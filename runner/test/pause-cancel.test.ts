import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { acquireLease } from "../src/store/lease.ts";
import { reconcile } from "../src/engine/reconcile.ts";
import type { TickContext, TickOutcome } from "../src/engine/tick.ts";
import { restingStubBody } from "../src/engine/tick.ts";
import { pauseRun, cancelRun, withOperatorTermination } from "../src/engine/control-commands.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const SUPERVISOR_PATH = fileURLToPath(new URL("../src/engine/supervisor.ts", import.meta.url));

function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "running", now);
  });
}

function insertAttemptAndWorker(
  db: ReturnType<typeof openStore>,
  opts: {
    attemptId: string;
    workerId: string;
    runId: string;
    pid: number;
    pgid: number;
    round?: number;
    now: number;
  },
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.attemptId,
      opts.runId,
      "task-1",
      "stage-1",
      "implementer",
      opts.round ?? 1,
      "v1",
      "fake",
      "fake",
      "{}",
      0,
      "running",
      opts.now,
    );
    db.prepare(
      `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.workerId, opts.runId, opts.attemptId, opts.pid, opts.pgid, opts.now, opts.now);
  });
}

function getRunRow(db: ReturnType<typeof openStore>, runId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown>;
}

function getAttempt(db: ReturnType<typeof openStore>, attemptId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as Record<string, unknown>;
}

function countControlRows(db: ReturnType<typeof openStore>, runId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM control WHERE run_id = ?").get(runId) as { n: number };
  return row.n;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 10): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (predicate() || Date.now() > deadline) {
        clearInterval(tick);
        resolve(predicate());
      }
    }, pollMs);
  });
}

// Spawns a detached group leader and waits for it to print "READY" (printed
// right after any SIGTERM trap is installed) so callers never race a
// still-starting child.
function spawnGroup(script: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      if (buf.includes("READY")) {
        child.stdout?.off("data", onData);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.on("error", reject);
  });
}

async function killGroupBestEffort(pgid: number | undefined): Promise<void> {
  if (typeof pgid !== "number") return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

const IGNORES_SIGTERM = `
  process.on('SIGTERM', () => {});
  process.stdout.write('READY\\n');
  setTimeout(() => {}, 60000);
`;

const PLAIN_IDLE = `
  process.stdout.write('READY\\n');
  setTimeout(() => {}, 60000);
`;

function abortedContext(db: ReturnType<typeof openStore>, runId: string, now: () => number): TickContext {
  const controller = new AbortController();
  controller.abort();
  return { db, runId, tickIndex: 0, now, leaseDeadlineMs: now() + 3000, signal: controller.signal };
}

// ── pauseRun / cancelRun: control-row insertion and idempotency ───────────

test("pauseRun inserts a 'pause' control row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      const result = pauseRun(db, { runId: "run-1", now: clock.now });
      assert.equal(result.inserted, true);
      const row = db.prepare("SELECT kind FROM control WHERE id = ?").get(result.controlId) as { kind: string };
      assert.equal(row.kind, "pause");
    } finally {
      db.close();
    }
  });
});

test("pauseRun --now inserts a 'pause-now' control row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      const result = pauseRun(db, { runId: "run-1", now: clock.now, immediate: true });
      const row = db.prepare("SELECT kind FROM control WHERE id = ?").get(result.controlId) as { kind: string };
      assert.equal(row.kind, "pause-now");
    } finally {
      db.close();
    }
  });
});

test("pauseRun is a no-op when the run is already paused", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET state = 'paused' WHERE id = ?").run("run-1");
      const result = pauseRun(db, { runId: "run-1", now: clock.now });
      assert.equal(result.inserted, false);
      assert.equal(countControlRows(db, "run-1"), 0);
    } finally {
      db.close();
    }
  });
});

test("pauseRun does not insert a duplicate unacknowledged 'pause' row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      pauseRun(db, { runId: "run-1", now: clock.now });
      clock.advance(10);
      const second = pauseRun(db, { runId: "run-1", now: clock.now });
      assert.equal(second.inserted, false);
      assert.equal(countControlRows(db, "run-1"), 1);
    } finally {
      db.close();
    }
  });
});

test("cancelRun inserts a 'cancel' row and does not signal the active lease owner", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const fakeSupervisor = await spawnGroup(PLAIN_IDLE);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      acquireLease(db, { runId: "run-1", ownerPid: fakeSupervisor.pid as number, tickIntervalMs: 10, now: clock.now });

      const result = cancelRun(db, { runId: "run-1", now: clock.now });
      assert.equal(result.inserted, true);
      const row = db.prepare("SELECT kind FROM control WHERE id = ?").get(result.controlId) as { kind: string };
      assert.equal(row.kind, "cancel");

      // cancelRun must be a pure DB write: no signal to the lease owner. A
      // process that never traps SIGTERM (PLAIN_IDLE does not) would die
      // immediately from a real nudge, so staying alive here is the proof.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(
        alive(fakeSupervisor.pid as number),
        "cancelRun must not signal the supervisor process — the control row is the only durable trigger",
      );
    } finally {
      await killGroupBestEffort(fakeSupervisor.pid);
      db.close();
    }
  });
});

test("cancelRun --now inserts a 'cancel-now' row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      const result = cancelRun(db, { runId: "run-1", now: clock.now, immediate: true });
      const row = db.prepare("SELECT kind FROM control WHERE id = ?").get(result.controlId) as { kind: string };
      assert.equal(row.kind, "cancel-now");
    } finally {
      db.close();
    }
  });
});

test("cancelRun is a no-op when the run is already cancelled", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET state = 'cancelled' WHERE id = ?").run("run-1");
      const result = cancelRun(db, { runId: "run-1", now: clock.now });
      assert.equal(result.inserted, false);
      assert.equal(countControlRows(db, "run-1"), 0);
    } finally {
      db.close();
    }
  });
});

test("cancelRun does not insert a duplicate unacknowledged 'cancel' row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      cancelRun(db, { runId: "run-1", now: clock.now });
      clock.advance(10);
      const second = cancelRun(db, { runId: "run-1", now: clock.now });
      assert.equal(second.inserted, false);
      assert.equal(countControlRows(db, "run-1"), 1);
    } finally {
      db.close();
    }
  });
});

// ── withOperatorTermination: the tick-body wrapper's forceful paths ───────

test("withOperatorTermination on a graceful 'cancel': trapping worker survives the grace window and is SIGKILLed, attempt marked operator-cancel", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const worker = await spawnGroup(IGNORES_SIGTERM);
    const pgid = worker.pid as number;
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET desired_state = 'cancelled' WHERE id = ?").run("run-1");
      db.prepare("INSERT INTO control (id, run_id, kind, created_at) VALUES ('c1', 'run-1', 'cancel', ?)").run(
        clock.now(),
      );
      insertAttemptAndWorker(db, {
        attemptId: "att-1",
        workerId: "w1",
        runId: "run-1",
        pid: pgid,
        pgid,
        now: clock.now(),
      });

      // The grace window is real wall-clock time (the process actually has to
      // stay alive through it), so `now` here is `Date.now`, not the fake,
      // frozen clock used for the DB row timestamps above.
      const body = withOperatorTermination(restingStubBody({ kind: "active" }), {
        now: Date.now,
        defaultCancelGraceMs: 150,
      });
      const outcome: TickOutcome = await body(abortedContext(db, "run-1", Date.now));

      assert.deepEqual(outcome, { kind: "resting", state: "cancelled", reason: "operator-cancel" });
      const gone = await waitFor(() => !groupAlive(pgid), 500);
      assert.ok(gone, "the trapping worker group must be gone after the SIGKILL escalation");
      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "operator-cancel");
      assert.equal(getRunRow(db, "run-1").state, "cancelling", "the wrapper durably marks cancelling before terminating");
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

test("withOperatorTermination on 'cancel-now' terminates with no grace wait", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const worker = await spawnGroup(IGNORES_SIGTERM);
    const pgid = worker.pid as number;
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET desired_state = 'cancelled' WHERE id = ?").run("run-1");
      db.prepare("INSERT INTO control (id, run_id, kind, created_at) VALUES ('c1', 'run-1', 'cancel-now', ?)").run(
        clock.now(),
      );
      insertAttemptAndWorker(db, {
        attemptId: "att-1",
        workerId: "w1",
        runId: "run-1",
        pid: pgid,
        pgid,
        now: clock.now(),
      });

      const body = withOperatorTermination(restingStubBody({ kind: "active" }));
      const start = Date.now();
      const outcome = await body(abortedContext(db, "run-1", clock.now));
      const elapsed = Date.now() - start;

      assert.equal(outcome.kind, "resting");
      assert.ok(elapsed < 500, `cancel-now must not wait a grace window: took ${elapsed}ms`);
      const gone = await waitFor(() => !groupAlive(pgid), 500);
      assert.ok(gone);
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

test("withOperatorTermination on a graceful 'pause' does not terminate: it waits for the live worker to finish naturally", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const worker = await spawnGroup(PLAIN_IDLE);
    const pgid = worker.pid as number;
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET desired_state = 'paused' WHERE id = ?").run("run-1");
      db.prepare("INSERT INTO control (id, run_id, kind, created_at) VALUES ('c1', 'run-1', 'pause', ?)").run(
        clock.now(),
      );
      insertAttemptAndWorker(db, {
        attemptId: "att-1",
        workerId: "w1",
        runId: "run-1",
        pid: pgid,
        pgid,
        now: clock.now(),
      });

      const body = withOperatorTermination(restingStubBody({ kind: "active" }));
      const outcome = await body(abortedContext(db, "run-1", clock.now));

      assert.deepEqual(outcome, { kind: "active" }, "a plain pause must not terminate a live worker");
      assert.ok(groupAlive(pgid), "the live worker must be left alone by a plain pause");
      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "running", "a plain pause never marks the in-flight attempt interrupted");

      db.prepare("UPDATE workers SET termination_state = 'exited', ended_at = ? WHERE id = 'w1'").run(clock.now());
      const drainedOutcome = await body(abortedContext(db, "run-1", clock.now));
      assert.deepEqual(drainedOutcome, { kind: "resting", state: "paused", reason: null });
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

test("withOperatorTermination on 'pause-now' terminates the live worker immediately and marks it operator-pause", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const worker = await spawnGroup(PLAIN_IDLE);
    const pgid = worker.pid as number;
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET desired_state = 'paused' WHERE id = ?").run("run-1");
      db.prepare("INSERT INTO control (id, run_id, kind, created_at) VALUES ('c1', 'run-1', 'pause-now', ?)").run(
        clock.now(),
      );
      insertAttemptAndWorker(db, {
        attemptId: "att-1",
        workerId: "w1",
        runId: "run-1",
        pid: pgid,
        pgid,
        now: clock.now(),
      });

      const body = withOperatorTermination(restingStubBody({ kind: "active" }));
      const outcome = await body(abortedContext(db, "run-1", clock.now));

      assert.deepEqual(outcome, { kind: "resting", state: "paused", reason: null });
      const gone = await waitFor(() => !groupAlive(pgid), 500);
      assert.ok(gone);
      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "operator-pause");
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

// ── pause-resume roundtrip: the interrupted row is preserved, not deleted ──

test("pause-resume-roundtrip: a --now-paused attempt keeps its row, and reconcile never touches an operator-pause interrupted attempt", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const worker = await spawnGroup(PLAIN_IDLE);
    const pgid = worker.pid as number;
    try {
      const clock = fakeClock(1000);
      insertRun(db, "run-1", clock.now());
      db.prepare("UPDATE runs SET desired_state = 'paused' WHERE id = ?").run("run-1");
      db.prepare("INSERT INTO control (id, run_id, kind, created_at) VALUES ('c1', 'run-1', 'pause-now', ?)").run(
        clock.now(),
      );
      insertAttemptAndWorker(db, {
        attemptId: "att-1",
        workerId: "w1",
        runId: "run-1",
        pid: pgid,
        pgid,
        round: 1,
        now: clock.now(),
      });

      const body = withOperatorTermination(restingStubBody({ kind: "active" }));
      await body(abortedContext(db, "run-1", clock.now));

      const interrupted = getAttempt(db, "att-1");
      assert.equal(interrupted.status, "interrupted");
      assert.equal(interrupted.interrupt_reason, "operator-pause");

      // reconcile must leave an already-interrupted attempt exactly as it is:
      // it is the future scheduler's (P5d's) job to decide redispatch based on
      // interrupt_reason, not reconcile's.
      reconcile(db, { runId: "run-1", now: clock.now, staleThresholdMs: 3000 });
      const afterReconcile = getAttempt(db, "att-1");
      assert.equal(afterReconcile.status, "interrupted");
      assert.equal(afterReconcile.interrupt_reason, "operator-pause");
      assert.equal(afterReconcile.id, "att-1", "the interrupted attempt's row must be preserved, not deleted");

      // `run resume` (P5b, already shipped) flips desired_state back to
      // running; a fresh redispatch for the same task-stage inserts a NEW
      // attempt row at the next round rather than reusing att-1's id — the
      // unique index on (run_id, task_id, stage_id, round, input_version)
      // is what makes that possible instead of colliding.
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("att-2", "run-1", "task-1", "stage-1", "implementer", 2, "v1", "fake", "fake", "{}", 0, "running", clock.now());
      });

      const rawRows = db.prepare("SELECT id, round, status FROM attempts WHERE task_id = 'task-1' ORDER BY round").all() as Array<{
        id: string;
        round: number;
        status: string;
      }>;
      const rows = rawRows.map((row) => ({ id: row.id, round: row.round, status: row.status }));
      assert.deepEqual(
        rows,
        [
          { id: "att-1", round: 1, status: "interrupted" },
          { id: "att-2", round: 2, status: "running" },
        ],
        "the paused attempt is preserved and the redispatch is a distinct new attempt id",
      );
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

// ── Real, end-to-end run cancel through a spawned supervisor process ──────

test("run cancel end to end: a real supervisor process acknowledges the control row, terminates the group, and exits with the run cancelled", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const worker = await spawnGroup(PLAIN_IDLE);
    const pgid = worker.pid as number;
    let supervisorPid: number | undefined;
    try {
      const db = openStore(dir);
      const runId = "run-1";
      insertRun(db, runId, Date.now());
      insertAttemptAndWorker(db, {
        attemptId: "att-1",
        workerId: "w1",
        runId,
        pid: pgid,
        pgid,
        now: Date.now(),
      });
      db.close();

      const supervisor = spawn(process.execPath, [SUPERVISOR_PATH, dir, runId], { detached: true, stdio: "ignore" });
      supervisor.unref();
      supervisorPid = supervisor.pid as number;

      const leaseDb = openStore(dir);
      try {
        const leaseAcquired = await waitFor(
          () =>
            (leaseDb
              .prepare("SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL")
              .get(runId) as { n: number }).n === 1,
          2000,
        );
        assert.ok(leaseAcquired, "the real supervisor must acquire the run lease before this test proceeds");

        cancelRun(leaseDb, { runId, immediate: true });
      } finally {
        leaseDb.close();
      }

      const supervisorExited = await waitFor(() => !alive(supervisorPid as number), 5000);
      assert.ok(supervisorExited, "the supervisor process must exit once the run is cancelled");

      const finalDb = openStore(dir);
      try {
        const run = getRunRow(finalDb, runId);
        assert.equal(run.state, "cancelled");
        const attempt = getAttempt(finalDb, "att-1");
        assert.equal(attempt.status, "interrupted");
        assert.equal(attempt.interrupt_reason, "operator-cancel");
      } finally {
        finalDb.close();
      }

      const gone = await waitFor(() => !groupAlive(pgid), 500);
      assert.ok(gone, "the worker's process group must be gone");
    } finally {
      await killGroupBestEffort(pgid);
      if (typeof supervisorPid === "number") {
        try {
          process.kill(-supervisorPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

// ── Regression: cancelRun must never race process-supervisor's exit handler ──
//
// Once a worker is dispatched through the real `superviseProcess`,
// `process-supervisor.ts`'s own `installParentExitCleanup` registers a
// SIGTERM handler that hard-kills every tracked group and calls
// `process.exit(130)` synchronously, with no grace window and no durable
// record. A SIGTERM sent to that same process races that handler. This test
// reproduces the exact precondition (a real worker dispatched via
// `superviseProcess`, so the competing handler genuinely exists) and asserts
// that a `cancelRun` call in that state still lets the run reach `cancelled`
// through the ordinary tick loop, with the configured grace period honored —
// proving `cancelRun` itself never triggers the race, rather than merely
// passing by coincidence.
test("cancelRun against a supervisor with a real dispatched worker: the run reaches cancelled with the configured grace honored, not process-supervisor's immediate exit(130)", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    insertRun(db, runId, Date.now());
    db.close();

    const graceMs = 150;
    const scriptPath = path.join(dir, "supervisor-with-real-worker.mjs");
    const dbPath = fileURLToPath(new URL("../src/store/db.ts", import.meta.url));
    const leasePath = fileURLToPath(new URL("../src/store/lease.ts", import.meta.url));
    const tickPath = fileURLToPath(new URL("../src/engine/tick.ts", import.meta.url));
    const controlCommandsPath = fileURLToPath(new URL("../src/engine/control-commands.ts", import.meta.url));
    const processSupervisorPath = fileURLToPath(new URL("../src/adapters/process-supervisor.ts", import.meta.url));

    // Mirrors `supervisor.ts`'s own wiring order: the tick-body wrapper (and
    // its SIGTERM trap) is built first, before any worker exists, exactly as
    // `runSupervisor` builds it before `runTickShell` ever runs a tick. The
    // real `superviseProcess` call that follows is what registers
    // process-supervisor's own competing handler — the realistic ordering
    // this test needs, not merely the source layout.
    const script = `
      import { openStore, withTransaction } from ${JSON.stringify(dbPath)};
      import { acquireLease } from ${JSON.stringify(leasePath)};
      import { runTickShell, restingStubBody } from ${JSON.stringify(tickPath)};
      import { withOperatorTermination } from ${JSON.stringify(controlCommandsPath)};
      import { superviseProcess } from ${JSON.stringify(processSupervisorPath)};

      const dir = ${JSON.stringify(dir)};
      const runId = ${JSON.stringify(runId)};
      const db = openStore(dir);

      acquireLease(db, { runId, ownerPid: process.pid, tickIntervalMs: 50, now: Date.now });

      const body = withOperatorTermination(restingStubBody({ kind: 'active' }), {
        installSigtermTrap: true,
        defaultCancelGraceMs: ${graceMs},
      });

      const supervisePromise = superviseProcess({
        command: process.execPath,
        args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('READY\\\\n'); setTimeout(() => {}, 60000);"],
        budgets: { POLL_SECS: 60, NO_PROGRESS_SECS: 600, GRACE_SECS: 60, HARD_CEILING_SECS: 600 },
        recordProcess: (info) => {
          withTransaction(db, () => {
            db.prepare(
              \`INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
            ).run('att-1', runId, 'task-1', 'stage-1', 'implementer', 1, 'v1', 'fake', 'fake', '{}', 0, 'running', Date.now());
            db.prepare(
              \`INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)\`,
            ).run('w1', runId, 'att-1', info.pid, info.pgid, Date.now(), Date.now());
          });
          process.stdout.write('WORKERPID:' + info.pid + '\\n');
        },
        onStdout: () => {
          process.stdout.write('CHILD-READY\\n');
        },
      });
      supervisePromise.catch(() => {});

      const exit = await runTickShell({ db, runId, body, tickIntervalMs: 50, operatorPollWindowMs: 300000 });
      process.stdout.write('EXITCODE:' + exit.exitCode + '\\n');
      process.exit(exit.exitCode);
    `;
    fs.writeFileSync(scriptPath, script);

    const supervisor = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let workerPgid: number | undefined;
    let exitCodeLine: number | undefined;
    supervisor.stdout.setEncoding("utf8");
    supervisor.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const workerMatch = /WORKERPID:(\d+)/.exec(chunk);
      if (workerMatch) workerPgid = Number(workerMatch[1]);
      const exitMatch = /EXITCODE:(\d+)/.exec(chunk);
      if (exitMatch) exitCodeLine = Number(exitMatch[1]);
    });
    let stderr = "";
    supervisor.stderr.setEncoding("utf8");
    supervisor.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const workerStarted = await waitFor(() => stdout.includes("CHILD-READY"), 3000);
      assert.ok(
        workerStarted,
        `worker did not start in time (this is the precondition that registers process-supervisor's own SIGTERM handler); stderr: ${stderr}`,
      );

      const cancelDb = openStore(dir);
      let cancelledAtMs: number;
      try {
        cancelRun(cancelDb, { runId });
        cancelledAtMs = Date.now();
      } finally {
        cancelDb.close();
      }

      // Give process-supervisor's own exit(130) handler every chance to have
      // won this race if cancelRun (wrongly) signalled it: if the process is
      // still alive shortly after cancelRun returns, no such signal was sent.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(
        supervisor.exitCode === null,
        "the supervisor process must still be alive immediately after cancelRun — cancelRun must not signal it",
      );

      const exited = await waitFor(() => supervisor.exitCode !== null, 5000);
      assert.ok(exited, `supervisor process did not exit; stderr: ${stderr}`);
      const elapsedMs = Date.now() - cancelledAtMs;

      assert.equal(
        supervisor.exitCode,
        0,
        `supervisor must exit via runTickShell's own return (0), not process-supervisor's exit(130); stderr: ${stderr}`,
      );
      assert.equal(exitCodeLine, 0);
      assert.ok(
        elapsedMs >= graceMs - 20,
        `the configured ${graceMs}ms grace window must be honored, not skipped for an immediate force-kill (took ${elapsedMs}ms)`,
      );

      const finalDb = openStore(dir);
      try {
        const run = getRunRow(finalDb, runId);
        assert.equal(run.state, "cancelled", "the durable cancelled record must exist");
        assert.equal(run.terminal_reason, "operator-cancel");
        const attempt = getAttempt(finalDb, "att-1");
        assert.equal(attempt.status, "interrupted");
        assert.equal(attempt.interrupt_reason, "operator-cancel");
      } finally {
        finalDb.close();
      }

      if (typeof workerPgid === "number") {
        const gone = await waitFor(() => !groupAlive(workerPgid as number), 500);
        assert.ok(gone, "the SIGTERM-ignoring worker's group must be gone after the SIGKILL escalation");
      }
    } finally {
      try {
        supervisor.kill("SIGKILL");
      } catch {
        // already gone
      }
      await killGroupBestEffort(workerPgid);
    }
  });
});
