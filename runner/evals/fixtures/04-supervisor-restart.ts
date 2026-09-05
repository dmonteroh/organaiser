// Fixture: supervisor-restart.
//
// `scheduler.ts`'s `dispatchEligible` hardcodes every attempt it creates as
// `mutating: true` (goals spec: a real implementer/integrator attempt always
// touches the worktree), and `reconcile.ts` deliberately classifies every
// exited/stale *mutating* attempt as `indeterminate`, never
// `supervisor-crash`/`stale-lease` — by design, "reconciling a mutating
// worktree after a crash requires tooling this phase doesn't implement."
// That means a live-dispatched attempt from the real, integrated scheduler
// can never itself be observed reclassified `supervisor-crash`: the
// vocabulary this fixture is asked to prove is only reachable through a
// manually-seeded, non-mutating attempt — exactly the technique P5b/P5d's
// own `reconcile.test.ts` already uses to exercise this same path
// (`insertAttempt(db, { mutating: 0, ... })`). This fixture does the same:
// it seeds one already-dead "crashed" attempt directly, confirms the first
// supervisor's own startup reconciliation reclassifies it, then lets that
// same supervisor's ordinary dispatch (which does not consult
// `interrupt_reason` before redispatching a task still sitting at a
// dispatchable stage) pick task-a back up for real — which is what actually
// gives this fixture something live to SIGKILL "mid-attempt."

import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  ProcessRegistry,
  alive,
  waitFor,
  startFixtureRun,
  readRunRow,
  allRows,
  spawnFixtureSupervisor,
  writeStream,
  reportLine,
  outputLine,
  exitLine,
  sleepLine,
  withFixtureWorkspace,
  TEST_SUPERVISOR_PATH,
  openStore,
  withTransaction,
} from "./harness.ts";

const TICK_INTERVAL_MS = 300;

async function spawnDeadProcess(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return pid;
}

export async function supervisorRestart(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
      const now = Date.now();

      const deadPid = await spawnDeadProcess();

      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-a", runId, "task-a", "Task A", "brief.md", "dev-workflow", "integration", "[]", 0, "implementing", null, now, now);
          db.prepare(
            `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("att-crashed", runId, "task-a", "integration", "implementer", 1, "v-crash", "fake", "fake", "{}", 0, "running", now, now);
          db.prepare(
            `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run("w-crashed", runId, "att-crashed", deadPid, deadPid, now, now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("working"),
        sleepLine(TICK_INTERVAL_MS * 2),
        reportLine({ taskId: "task-a", stageId: "integration", summary: "done" }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("integrating"),
        reportLine({ taskId: "task-a", stageId: "integration", roleId: "integrator", summary: "integrated" }),
        exitLine(0),
      ]);

      const first = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(first.pid);

      const reclassified = await waitFor(() => {
        const row = allRows<{ status: string; interrupt_reason: string | null }>(
          dir,
          `SELECT status, interrupt_reason FROM attempts WHERE id = 'att-crashed'`,
        )[0];
        return row?.status === "interrupted";
      }, 3000);
      assert.ok(reclassified, "the first supervisor's own startup reconciliation must classify the crashed attempt");
      const crashedRow = allRows<{ status: string; interrupt_reason: string | null }>(
        dir,
        `SELECT status, interrupt_reason FROM attempts WHERE id = 'att-crashed'`,
      )[0] as { status: string; interrupt_reason: string | null };
      assert.equal(crashedRow.status, "interrupted");
      assert.equal(crashedRow.interrupt_reason, "supervisor-crash");

      const round2Live = await waitFor(() => {
        const rows = allRows<{ round: number; status: string }>(
          dir,
          `SELECT round, status FROM attempts WHERE run_id = ? AND task_id = 'task-a' AND stage_id = 'integration' AND round = 2`,
          runId,
        );
        return rows.length === 1 && rows[0]?.status === "running";
      }, 3000);
      assert.ok(round2Live, "the same supervisor must freely redispatch task-a once its old attempt is reconciled");
      const round2Workers = allRows<{ pgid: number }>(
        dir,
        `SELECT w.pgid AS pgid FROM workers w JOIN attempts a ON a.id = w.attempt_id WHERE a.run_id = ? AND a.task_id = 'task-a' AND a.round = 2`,
        runId,
      );
      for (const worker of round2Workers) registry.track(worker.pgid);

      process.kill(first.pid, "SIGKILL");
      const firstDead = await waitFor(() => !alive(first.pid), 2000);
      assert.ok(firstDead, "the first supervisor must actually be dead");

      const tooEarly = spawn(
        process.execPath,
        [
          TEST_SUPERVISOR_PATH,
          dir,
          runId,
          String(TICK_INTERVAL_MS),
          String(TICK_INTERVAL_MS * 4),
          String(TICK_INTERVAL_MS),
          streamsDir,
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      // Deliberately not `unref()`'d: this fixture actively awaits this
      // child's own `exit` event next, and an unref'd handle's `exit`
      // delivery to its still-running parent proved intermittently
      // unreliable on this platform during development.
      tooEarly.stdout?.resume();
      tooEarly.stderr?.resume();
      if (typeof tooEarly.pid === "number") registry.track(tooEarly.pid);
      const tooEarlyExitCode = await new Promise<number | null>((resolve) => tooEarly.on("exit", resolve));
      assert.equal(tooEarlyExitCode, 4, "resuming before the old lease is stale must fail with exit code 4");

      // Comfortably longer than both the lease-staleness threshold
      // (3 * tickIntervalMs) and round 2's own short sleep, so its real,
      // A-abandoned process has already exited on its own by the time B's
      // one-time startup reconciliation looks at it — reconcile() never
      // re-checks a worker it finds `live`, so if that race went the other
      // way the worker's row would keep `liveWorkerCount` above zero
      // forever and this run would never reach a resting state at all.
      await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS * 6));

      const resumed = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(resumed.pid);

      const completed = await waitFor(() => readRunRow(dir, runId).state === "succeeded", 8000);
      assert.ok(completed, `the run must go on to complete; last row: ${JSON.stringify(readRunRow(dir, runId))}`);

      const allImplementationAttempts = allRows<{ round: number }>(
        dir,
        `SELECT round FROM attempts WHERE run_id = ? AND task_id = 'task-a' AND stage_id = 'integration'`,
        runId,
      );
      const rounds = allImplementationAttempts.map((row) => row.round);
      assert.equal(new Set(rounds).size, rounds.length, `no duplicate (run,task,stage,round) key: rounds=${JSON.stringify(rounds)}`);
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
