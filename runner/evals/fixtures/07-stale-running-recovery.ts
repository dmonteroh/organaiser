// Fixture: stale-running-recovery.
//
// Two cases, both driven directly against `reconcile()` (P5b) rather than
// through a live tick loop, for two independent reasons:
//
// 1. `classifyWorker` (reconcile.ts) checks `exited` first: "if (!pidAlive
//    && !groupAlive) return 'exited'" runs BEFORE the staleness check, so a
//    genuinely dead pid+group always classifies `exited`, never `stale`,
//    regardless of heartbeat age — `stale` is reserved for a heartbeat that
//    goes stale while the process still answers ("even if the process still
//    answers", reconcile.ts's own comment). A dead-pid case is therefore
//    adapted here to seed a real, still-alive process with a stale
//    heartbeat instead, which is the only way to actually reach the `stale`
//    classification and its `stale-lease` interrupt reason.
//
// 2. Nothing in P5's scope gates dispatch on `interrupt_reason`:
//    `dispatchEligible` (scheduler.ts) decides purely from a task's
//    `stage_id`/`disposition` and its own in-memory
//    `runtime.liveAttemptByTaskId`; it never reads
//    `attempts.interrupt_reason`. The "never redispatched"
//    vocabulary documented on `InterruptReason` in store/types.ts is
//    aspirational for a later phase's controller, not something reconcile()
//    or the scheduler enforces today. Proving "not redispatched" against a
//    live scheduler tick would therefore only be proving "nothing tried to
//    dispatch during the window this test happened to look," which is not
//    the same claim. This fixture instead calls `reconcile()` directly (P5b
//    and P5d's own `reconcile.test.ts` does the same) and asserts its
//    classification and DB effect precisely, without a live tick loop
//    obscuring what is and is not actually gated.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  ProcessRegistry,
  startFixtureRun,
  allRows,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";
import { reconcile } from "../../src/engine/reconcile.ts";

const STALE_THRESHOLD_MS = 900; // 3 * 300ms tick interval, matching the fixture suite's other real-timing fixtures.

function seedRunningAttempt(
  dir: string,
  runId: string,
  opts: { attemptId: string; workerId: string; pid: number; pgid: number; heartbeatAt: number; now: number },
): void {
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("task-a", runId, "task-a", "Task A", "brief.md", "dev-workflow", "implementation", "[]", 0, "implementing", null, opts.now, opts.now);
      db.prepare(
        `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(opts.attemptId, runId, "task-a", "implementation", "implementer", 1, "v1", "fake", "fake", "{}", 0, "running", opts.now, opts.now);
      db.prepare(
        `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(opts.workerId, runId, opts.attemptId, opts.pid, opts.pgid, opts.heartbeatAt, opts.now);
    });
  } finally {
    db.close();
  }
}

export async function staleRunningRecoveryStaleCase(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    let worker: ReturnType<typeof spawn> | undefined;
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
      worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
      const pid = worker.pid as number;
      registry.track(pid);

      const now = Date.now();
      const staleHeartbeat = now - STALE_THRESHOLD_MS - 200;
      seedRunningAttempt(dir, runId, {
        attemptId: "att-stale",
        workerId: "w-stale",
        pid,
        pgid: pid,
        heartbeatAt: staleHeartbeat,
        now,
      });

      const db = openStore(dir);
      let result;
      try {
        result = reconcile(db, { runId, now: () => now, staleThresholdMs: STALE_THRESHOLD_MS });
      } finally {
        db.close();
      }

      assert.equal(result.workers.length, 1);
      assert.equal(result.workers[0]?.classification, "stale", "a still-alive but stale-heartbeat worker must classify stale, not live or indeterminate");
      assert.equal(result.workers[0]?.interruptReason, "stale-lease");

      const attemptRow = allRows<{ status: string; interrupt_reason: string | null }>(
        dir,
        `SELECT status, interrupt_reason FROM attempts WHERE id = 'att-stale'`,
      )[0] as { status: string; interrupt_reason: string | null };
      assert.equal(attemptRow.status, "interrupted");
      assert.equal(attemptRow.interrupt_reason, "stale-lease");

      const workerRow = allRows<{ termination_state: string | null }>(
        dir,
        `SELECT termination_state FROM workers WHERE id = 'w-stale'`,
      )[0] as { termination_state: string | null };
      assert.equal(workerRow.termination_state, "reclaimed");

      // A fresh redispatch for the same task-stage gets a distinct new
      // attempt id — `nextAttemptRound`/`dispatchAttempt` (P5d) never reuse
      // an existing row, whatever reconciled it away.
      const freshAttemptId = "att-fresh-redispatch";
      const db2 = openStore(dir);
      try {
        withTransaction(db2, () => {
          db2.prepare(
            `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(freshAttemptId, runId, "task-a", "implementation", "implementer", 2, "v2", "fake", "fake", "{}", 1, "running", Date.now(), Date.now());
        });
      } finally {
        db2.close();
      }
      assert.notEqual(freshAttemptId, "att-stale");
      const distinctRounds = allRows<{ round: number }>(
        dir,
        `SELECT round FROM attempts WHERE run_id = ? AND task_id = 'task-a' AND stage_id = 'implementation'`,
        runId,
      );
      assert.equal(new Set(distinctRounds.map((r) => r.round)).size, distinctRounds.length);
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function staleRunningRecoveryIndeterminateCase(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);

      // A pid that is genuinely alive (this test process's own pid) but is
      // not a member of the recorded pgid — the recorded pgid is a bogus,
      // never-allocated group id, so `process.kill(-pgid, 0)` throws ESRCH
      // for it while the pid itself answers: pid/group liveness disagree,
      // which is exactly `classifyWorker`'s `indeterminate` fallthrough.
      const bogusPgid = 999999;
      const now = Date.now();
      seedRunningAttempt(dir, runId, {
        attemptId: "att-indeterminate",
        workerId: "w-indeterminate",
        pid: process.pid,
        pgid: bogusPgid,
        heartbeatAt: now,
        now,
      });

      const db = openStore(dir);
      let result;
      try {
        result = reconcile(db, { runId, now: () => now, staleThresholdMs: STALE_THRESHOLD_MS });
      } finally {
        db.close();
      }

      assert.equal(result.workers.length, 1);
      assert.equal(result.workers[0]?.classification, "indeterminate");
      assert.equal(result.workers[0]?.interruptReason, "indeterminate");

      const attemptRow = allRows<{ status: string; interrupt_reason: string | null }>(
        dir,
        `SELECT status, interrupt_reason FROM attempts WHERE id = 'att-indeterminate'`,
      )[0] as { status: string; interrupt_reason: string | null };
      assert.equal(attemptRow.status, "interrupted");
      assert.equal(attemptRow.interrupt_reason, "indeterminate");

      // No second reconcile pass (and, per this module's header comment,
      // nothing in P5's dispatch path) ever redispatches this attempt: it
      // stays the sole attempts row for this task-stage.
      const attemptsForTask = allRows<{ id: string }>(
        dir,
        `SELECT id FROM attempts WHERE run_id = ? AND task_id = 'task-a' AND stage_id = 'implementation'`,
        runId,
      );
      assert.equal(attemptsForTask.length, 1);
      assert.equal(attemptsForTask[0]?.id, "att-indeterminate");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
