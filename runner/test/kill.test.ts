import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { acquireLease } from "../src/store/lease.ts";
import { killRun, killAll } from "../src/engine/control-commands.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number, state = "running"): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", state, now);
  });
}

function insertAttemptAndWorker(
  db: ReturnType<typeof openStore>,
  opts: { attemptId: string; workerId: string; runId: string; pid: number; pgid: number; now: number },
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
      1,
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

// ── killRun: no live supervisor assumed ────────────────────────────────────

test("killRun terminates every recorded worker group and marks the run cancelled with no live supervisor", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const worker = await spawnGroup(PLAIN_IDLE);
    const pgid = worker.pid as number;
    try {
      insertRun(db, "run-1", Date.now());
      insertAttemptAndWorker(db, { attemptId: "att-1", workerId: "w1", runId: "run-1", pid: pgid, pgid, now: Date.now() });

      const result = await killRun(db, { runId: "run-1" });
      assert.equal(result.ok, true);
      assert.equal(result.workers.length, 1);

      const gone = await waitFor(() => !groupAlive(pgid), 500);
      assert.ok(gone);

      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "operator-cancel");

      const run = getRunRow(db, "run-1");
      assert.equal(run.state, "cancelled");
      assert.equal(run.terminal_reason, "operator-cancel");
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

test("kill-without-supervisor: killing the supervisor process first, then running killRun, still reaps every worker group", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const fakeSupervisor = await spawnGroup(PLAIN_IDLE);
    const worker = await spawnGroup(IGNORES_SIGTERM);
    const pgid = worker.pid as number;
    try {
      insertRun(db, "run-1", Date.now());
      acquireLease(db, {
        runId: "run-1",
        ownerPid: fakeSupervisor.pid as number,
        tickIntervalMs: 10,
        now: Date.now,
      });
      insertAttemptAndWorker(db, { attemptId: "att-1", workerId: "w1", runId: "run-1", pid: pgid, pgid, now: Date.now() });

      // Kill the "supervisor" first, exactly as the AC describes: no live
      // supervisor process exists by the time killRun runs.
      process.kill(-(fakeSupervisor.pid as number), "SIGKILL");
      const supervisorDead = await waitFor(() => !alive(fakeSupervisor.pid as number), 500);
      assert.ok(supervisorDead, "precondition: the fake supervisor must actually be dead");

      const result = await killRun(db, { runId: "run-1", graceMs: 100 });
      assert.equal(result.workers[0]?.killed, true, "the trapping worker must have needed the SIGKILL escalation");

      const gone = await waitFor(() => !groupAlive(pgid), 500);
      assert.ok(gone, "every recorded worker group must be gone");

      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "operator-cancel");

      const run = getRunRow(db, "run-1");
      assert.equal(run.state, "cancelled");

      const activeLease = db
        .prepare("SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL")
        .get("run-1") as { n: number };
      assert.equal(activeLease.n, 0, "the stale lease must be released so a future run does not appear held");
    } finally {
      await killGroupBestEffort(pgid);
      db.close();
    }
  });
});

test("killRun is a no-op on an already-cancelled run: no state regression, no crash", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", Date.now(), "cancelled");
      const result = await killRun(db, { runId: "run-1" });
      assert.deepEqual(result, { ok: true, workers: [] });
      assert.equal(getRunRow(db, "run-1").state, "cancelled");
    } finally {
      db.close();
    }
  });
});

test("killRun with no live workers still succeeds and finalizes the run", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", Date.now());
      const result = await killRun(db, { runId: "run-1" });
      assert.equal(result.workers.length, 0);
      assert.equal(getRunRow(db, "run-1").state, "cancelled");

      // Idempotent: calling it again does nothing further.
      const second = await killRun(db, { runId: "run-1" });
      assert.deepEqual(second, { ok: true, workers: [] });
    } finally {
      db.close();
    }
  });
});

// ── killAll ─────────────────────────────────────────────────────────────

test("killAll terminates every non-terminal run and leaves terminal runs untouched", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const workerA = await spawnGroup(PLAIN_IDLE);
    const workerB = await spawnGroup(PLAIN_IDLE);
    const pgidA = workerA.pid as number;
    const pgidB = workerB.pid as number;
    try {
      insertRun(db, "run-a", Date.now(), "running");
      insertRun(db, "run-b", Date.now(), "running");
      insertRun(db, "run-c", Date.now(), "succeeded");
      insertAttemptAndWorker(db, { attemptId: "att-a", workerId: "w-a", runId: "run-a", pid: pgidA, pgid: pgidA, now: Date.now() });
      insertAttemptAndWorker(db, { attemptId: "att-b", workerId: "w-b", runId: "run-b", pid: pgidB, pgid: pgidB, now: Date.now() });

      const results = await killAll(db);
      assert.equal(results.size, 2);
      assert.ok(results.has("run-a"));
      assert.ok(results.has("run-b"));
      assert.ok(!results.has("run-c"), "a terminal run must not be touched by kill-all");

      assert.equal(getRunRow(db, "run-a").state, "cancelled");
      assert.equal(getRunRow(db, "run-b").state, "cancelled");
      assert.equal(getRunRow(db, "run-c").state, "succeeded");

      assert.ok(await waitFor(() => !groupAlive(pgidA), 500));
      assert.ok(await waitFor(() => !groupAlive(pgidB), 500));
    } finally {
      await killGroupBestEffort(pgidA);
      await killGroupBestEffort(pgidB);
      db.close();
    }
  });
});

// ── installForegroundInterruptHandler: a real SIGINT to a foreground run ──

test("a real SIGINT to a foreground run durably records cancelled before the process exits, ahead of process-supervisor's own exit(130) handler", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    insertRun(db, runId, Date.now());
    db.close();

    const foregroundScriptPath = path.join(dir, "foreground.mjs");
    const controlCommandsPath = fileURLToPathCompatible("../src/engine/control-commands.ts");
    const dbPath = fileURLToPathCompatible("../src/store/db.ts");
    const processSupervisorPath = fileURLToPathCompatible("../src/adapters/process-supervisor.ts");

    // A stand-in for P5f's --foreground code path: install the interrupt
    // handler BEFORE spawning any attempt, then spawn one (a SIGTERM-ignoring
    // fake worker) via the real superviseProcess — which is exactly what
    // installs process-supervisor.ts's own competing SIGINT handler, the
    // realistic race this test needs.
    const script = `
      import { openStore } from ${JSON.stringify(dbPath)};
      import { installForegroundInterruptHandler } from ${JSON.stringify(controlCommandsPath)};
      import { superviseProcess } from ${JSON.stringify(processSupervisorPath)};

      const db = openStore(${JSON.stringify(dir)});
      installForegroundInterruptHandler({ db, runId: ${JSON.stringify(runId)} });

      await superviseProcess({
        command: process.execPath,
        args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('READY\\\\n'); setTimeout(() => {}, 60000);"],
        budgets: { POLL_SECS: 60, NO_PROGRESS_SECS: 600, GRACE_SECS: 60, HARD_CEILING_SECS: 600 },
        recordProcess: (info) => {
          process.stdout.write('WORKERPID:' + info.pid + '\\n');
        },
        onStdout: () => {
          process.stdout.write('CHILD-READY\\n');
        },
      });
    `;
    fs.writeFileSync(foregroundScriptPath, script);

    const foreground = spawn(process.execPath, [foregroundScriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let workerPgid: number | undefined;
    foreground.stdout.setEncoding("utf8");
    foreground.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const m = /WORKERPID:(\d+)/.exec(chunk);
      if (m) workerPgid = Number(m[1]);
    });
    let stderr = "";
    foreground.stderr.setEncoding("utf8");
    foreground.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const workerStarted = await waitFor(() => stdout.includes("CHILD-READY"), 3000);
      assert.ok(workerStarted, `foreground process did not start its worker in time; stderr: ${stderr}`);

      foreground.kill("SIGINT");
      const exited = await waitFor(() => foreground.exitCode !== null, 3000);
      assert.ok(exited, `foreground process did not exit after SIGINT; stderr: ${stderr}`);
      assert.equal(foreground.exitCode, 130);

      const finalDb = openStore(dir);
      try {
        const run = getRunRow(finalDb, runId);
        assert.equal(run.state, "cancelled", "the durable cancelled record must exist, not merely exit code 130");
        assert.equal(run.terminal_reason, "operator-cancel");

        const events = finalDb
          .prepare("SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq")
          .all(runId) as Array<{ type: string; payload: string }>;
        const restingPayloads = events.filter((e) => e.type === "run.resting").map((e) => JSON.parse(e.payload) as { state: string });
        assert.ok(
          restingPayloads.some((p) => p.state === "cancelling"),
          "the cancelling transition must be durably recorded",
        );
        assert.ok(
          restingPayloads.some((p) => p.state === "cancelled"),
          "the cancelled transition must be durably recorded",
        );
      } finally {
        finalDb.close();
      }
    } finally {
      try {
        foreground.kill("SIGKILL");
      } catch {
        // already gone
      }
      // The trapping worker is never targeted by the interrupt handler in
      // this test (no `workers` row is recorded for it — that path is
      // covered by killRun's own tests above), and process-supervisor's own
      // cleanup handler is exactly what the durable-record win preempts, so
      // it is left running until reaped here explicitly.
      await killGroupBestEffort(workerPgid);
    }
  });
});

function fileURLToPathCompatible(relativeFromThisFile: string): string {
  return new URL(relativeFromThisFile, import.meta.url).pathname;
}
