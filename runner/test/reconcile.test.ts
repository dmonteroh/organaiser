import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { classifyWorker, interruptReasonFor, reconcile, type ClassifyFacts } from "../src/engine/reconcile.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "running", now);
  });
}

function insertAttempt(
  db: ReturnType<typeof openStore>,
  opts: { id: string; runId: string; mutating: 0 | 1; now: number },
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.id, opts.runId, "task-1", "stage-1", "implementer", 1, "v1", "fake", "fake", "{}", opts.mutating, "running", opts.now);
  });
}

function insertWorker(
  db: ReturnType<typeof openStore>,
  opts: { id: string; runId: string; attemptId: string; pid: number; pgid: number; heartbeatAt: number; worktreeId?: string | null; now: number },
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, worktree_id, heartbeat_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.id, opts.runId, opts.attemptId, opts.pid, opts.pgid, opts.worktreeId ?? null, opts.heartbeatAt, opts.now);
  });
}

function getAttempt(db: ReturnType<typeof openStore>, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Record<string, unknown>;
}

function getWorker(db: ReturnType<typeof openStore>, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Record<string, unknown>;
}

// ── classifyWorker: pure function, no I/O ──────────────────────────────────

function baseFacts(overrides: Partial<ClassifyFacts> = {}): ClassifyFacts {
  return {
    pidAlive: true,
    groupAlive: true,
    heartbeatAgeMs: 0,
    staleThresholdMs: 3000,
    worktreeExpected: false,
    worktreePresent: false,
    ...overrides,
  };
}

test("classifyWorker: live when pid and group are alive and heartbeat is fresh", () => {
  assert.equal(classifyWorker(baseFacts()), "live");
});

test("classifyWorker: exited when neither the pid nor the group answers", () => {
  assert.equal(classifyWorker(baseFacts({ pidAlive: false, groupAlive: false })), "exited");
});

test("classifyWorker: stale when the heartbeat is at least as old as the threshold, even if the process answers", () => {
  assert.equal(classifyWorker(baseFacts({ heartbeatAgeMs: 3000 })), "stale");
  assert.equal(classifyWorker(baseFacts({ heartbeatAgeMs: 5000 })), "stale");
});

test("classifyWorker: indeterminate when pid and group liveness disagree", () => {
  assert.equal(classifyWorker(baseFacts({ pidAlive: true, groupAlive: false })), "indeterminate");
  assert.equal(classifyWorker(baseFacts({ pidAlive: false, groupAlive: true })), "indeterminate");
});

test("classifyWorker: indeterminate when a worktree is expected but missing, overriding an otherwise-live signal", () => {
  assert.equal(
    classifyWorker(baseFacts({ worktreeExpected: true, worktreePresent: false })),
    "indeterminate",
  );
});

// ── interruptReasonFor: mutating attempts are never auto-redispatched ─────

test("interruptReasonFor: live classification never produces an interrupt reason", () => {
  assert.equal(interruptReasonFor("live", false), null);
  assert.equal(interruptReasonFor("live", true), null);
});

test("interruptReasonFor: exited/stale map to supervisor-crash/stale-lease for a non-mutating attempt", () => {
  assert.equal(interruptReasonFor("exited", false), "supervisor-crash");
  assert.equal(interruptReasonFor("stale", false), "stale-lease");
});

test("interruptReasonFor: indeterminate always maps to indeterminate", () => {
  assert.equal(interruptReasonFor("indeterminate", false), "indeterminate");
  assert.equal(interruptReasonFor("indeterminate", true), "indeterminate");
});

test("interruptReasonFor: a mutating attempt is never eligible for automatic redispatch, even when exited or stale", () => {
  assert.equal(interruptReasonFor("exited", true), "indeterminate");
  assert.equal(interruptReasonFor("stale", true), "indeterminate");
});

// ── reconcile: I/O-performing classification against real process liveness ─

test("reconcile marks a worker whose process is genuinely gone as exited, and its attempt interrupted with supervisor-crash", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const now = 1_000_000;
      insertRun(db, "run-1", now);
      insertAttempt(db, { id: "att-1", runId: "run-1", mutating: 0, now });

      // spawn and kill a real child so its pid is genuinely dead, not merely
      // an unlikely-to-exist fixed number.
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true });
      const pid = child.pid as number;
      await new Promise<void>((resolve) => {
        child.on("spawn", () => resolve());
      });
      process.kill(-pid, "SIGKILL");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      // give the OS a moment to fully reap the process table entry
      await new Promise((resolve) => setTimeout(resolve, 50));

      insertWorker(db, { id: "w-1", runId: "run-1", attemptId: "att-1", pid, pgid: pid, heartbeatAt: now, now });

      const result = reconcile(db, { runId: "run-1", now: () => now, staleThresholdMs: 3000 });

      assert.equal(result.workers.length, 1);
      assert.equal(result.workers[0]?.classification, "exited");
      assert.equal(result.workers[0]?.interruptReason, "supervisor-crash");

      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "supervisor-crash");

      const worker = getWorker(db, "w-1");
      assert.equal(worker.termination_state, "exited");
    } finally {
      db.close();
    }
  });
});

test("reconcile marks a worker with a stale heartbeat as stale/reclaimed even though its process is still alive", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const now = 1_000_000;
      insertRun(db, "run-1", now);
      insertAttempt(db, { id: "att-1", runId: "run-1", mutating: 0, now });
      insertWorker(db, {
        id: "w-1",
        runId: "run-1",
        attemptId: "att-1",
        pid: process.pid,
        pgid: process.pid,
        heartbeatAt: now - 10_000,
        now,
      });

      const result = reconcile(db, { runId: "run-1", now: () => now, staleThresholdMs: 3000 });

      assert.equal(result.workers[0]?.classification, "stale");
      assert.equal(result.workers[0]?.interruptReason, "stale-lease");

      const worker = getWorker(db, "w-1");
      assert.equal(worker.termination_state, "reclaimed");
    } finally {
      db.close();
    }
  });
});

test("reconcile classifies a live worker without touching its attempt or worker row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    // A real detached child is its own process group leader, so both the pid
    // and the group probe succeed — unlike this test process, which is not
    // its own group leader and would otherwise read back as indeterminate.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true });
    try {
      const pid = child.pid as number;
      await new Promise<void>((resolve) => child.on("spawn", () => resolve()));

      const now = 1_000_000;
      insertRun(db, "run-1", now);
      insertAttempt(db, { id: "att-1", runId: "run-1", mutating: 0, now });
      insertWorker(db, {
        id: "w-1",
        runId: "run-1",
        attemptId: "att-1",
        pid,
        pgid: pid,
        heartbeatAt: now,
        now,
      });

      const result = reconcile(db, { runId: "run-1", now: () => now, staleThresholdMs: 3000 });

      assert.equal(result.workers[0]?.classification, "live");
      assert.equal(result.workers[0]?.interruptReason, null);

      const attempt = getAttempt(db, "att-1");
      assert.equal(attempt.status, "running");
      const worker = getWorker(db, "w-1");
      assert.equal(worker.termination_state, null);
    } finally {
      process.kill(-(child.pid as number), "SIGKILL");
      db.close();
    }
  });
});

test("reconcile: a synthesized mutating attempt whose worker exited is marked indeterminate, never auto-redispatched", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const now = 1_000_000;
      insertRun(db, "run-1", now);
      insertAttempt(db, { id: "att-mutating", runId: "run-1", mutating: 1, now });

      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true });
      const pid = child.pid as number;
      await new Promise<void>((resolve) => child.on("spawn", () => resolve()));
      process.kill(-pid, "SIGKILL");
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 50));

      insertWorker(db, { id: "w-mutating", runId: "run-1", attemptId: "att-mutating", pid, pgid: pid, heartbeatAt: now, now });

      const result = reconcile(db, { runId: "run-1", now: () => now, staleThresholdMs: 3000 });

      // The underlying process signal genuinely classifies as "exited" — the
      // guard is about interrupt_reason, not about hiding the true classification.
      assert.equal(result.workers[0]?.classification, "exited");
      assert.equal(result.workers[0]?.interruptReason, "indeterminate");

      const attempt = getAttempt(db, "att-mutating");
      assert.equal(attempt.interrupt_reason, "indeterminate");
    } finally {
      db.close();
    }
  });
});

test("reconcile classifies a worker as indeterminate when its recorded worktree is missing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const now = 1_000_000;
      insertRun(db, "run-1", now);
      insertAttempt(db, { id: "att-1", runId: "run-1", mutating: 0, now });
      insertWorker(db, {
        id: "w-1",
        runId: "run-1",
        attemptId: "att-1",
        pid: process.pid,
        pgid: process.pid,
        heartbeatAt: now,
        worktreeId: "missing-worktree",
        now,
      });

      const result = reconcile(db, { runId: "run-1", now: () => now, staleThresholdMs: 3000 });

      assert.equal(result.workers[0]?.classification, "indeterminate");
      assert.equal(result.workers[0]?.interruptReason, "indeterminate");
    } finally {
      db.close();
    }
  });
});
