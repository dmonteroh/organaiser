// Fixture: supervisor-exits-at-rest.
//
// Two cases. Draining: a board that reaches `succeeded` — the supervisor
// process must be gone within `2 * tickIntervalMs` of the `succeeded` event,
// its lease released, no live descendant left. Waiting-operator (Q10): the
// supervisor must stay alive for at most `operatorPollWindowMs +
// tickIntervalMs`, the count of `workers` rows with a null
// `termination_state` must be zero at every poll, `process.kill(-pgid, 0)`
// must throw `ESRCH` for every recorded group throughout the window, and it
// must then exit with the `waiting-operator` disposition and a released
// lease.

import assert from "node:assert/strict";
import path from "node:path";

import {
  ProcessRegistry,
  alive,
  waitFor,
  startFixtureRun,
  readRunRow,
  allRows,
  countRows,
  spawnFixtureSupervisor,
  writeStream,
  reportLine,
  outputLine,
  exitLine,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";

const TICK_INTERVAL_MS = 100;

export async function supervisorExitsAtRestDraining(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
      const now = Date.now();
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-a", runId, "task-a", "Task A", "brief.md", "dev-workflow", "implementation", "[]", 0, "implementing", null, now, now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "implementation", "task-a", [
        outputLine("working"),
        reportLine({ taskId: "task-a", stageId: "implementation", summary: "done" }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("integrating"),
        reportLine({ taskId: "task-a", stageId: "integration", roleId: "integrator", summary: "integrated" }),
        exitLine(0),
      ]);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      const succeeded = await waitFor(() => readRunRow(dir, runId).state === "succeeded", 6000);
      assert.ok(succeeded, `run must reach succeeded; last row: ${JSON.stringify(readRunRow(dir, runId))}`);
      const succeededAtMs = Date.now();

      const supervisorGone = await waitFor(() => !alive(supervisor.pid), 2 * TICK_INTERVAL_MS + 500);
      const elapsed = Date.now() - succeededAtMs;
      assert.ok(supervisorGone, "the supervisor must exit once the run drains to succeeded");
      assert.ok(
        elapsed <= 2 * TICK_INTERVAL_MS + 500,
        `the supervisor must exit within 2*tickIntervalMs of the succeeded event (took ${elapsed}ms)`,
      );

      const activeLease = countRows(dir, `SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL`, runId);
      assert.equal(activeLease, 0, "the lease row must be released");

      const workerPgids = allRows<{ pgid: number }>(dir, `SELECT DISTINCT pgid FROM workers WHERE run_id = ?`, runId);
      for (const worker of workerPgids) {
        registry.track(worker.pgid);
        assert.throws(
          () => process.kill(-worker.pgid, 0),
          /ESRCH/,
          `no live descendant may remain for group ${worker.pgid}`,
        );
      }
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function supervisorExitsAtRestWaitingOperator(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
      const now = Date.now();
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          // A task that never becomes dispatch-eligible (an unmet
          // dependency on an id that does not exist) self-loops at
          // `release-dependencies` forever without ever producing a live
          // worker or a terminal disposition; that alone would resolve to
          // `blocked`, not `waiting-operator`, so this case seeds the task
          // directly at the `waiting-operator` disposition instead — the
          // same technique P5b's own supervisor-detach.test.ts uses
          // (`seedWaitingOperatorTask`) to keep a real supervisor's tick
          // shell in its bounded operator-poll loop.
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-a", runId, "task-a", "Task A", "brief.md", "dev-workflow", null, "[]", 0, "waiting-operator", "waiting-operator", now, now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      const operatorPollWindowMs = TICK_INTERVAL_MS * 4;
      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      let sawNonZeroLiveWorkers = false;
      let sawLiveGroup = false;
      const pollDeadline = Date.now() + operatorPollWindowMs;
      while (Date.now() < pollDeadline && alive(supervisor.pid)) {
        const liveWorkers = countRows(dir, `SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL`, runId);
        if (liveWorkers !== 0) sawNonZeroLiveWorkers = true;
        for (const worker of allRows<{ pgid: number }>(dir, `SELECT DISTINCT pgid FROM workers WHERE run_id = ?`, runId)) {
          try {
            process.kill(-worker.pgid, 0);
            sawLiveGroup = true;
          } catch {
            // expected: ESRCH
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }

      assert.equal(sawNonZeroLiveWorkers, false, "zero workers rows with a null termination_state at every poll");
      assert.equal(sawLiveGroup, false, "process.kill(-pgid, 0) must throw ESRCH for every recorded group throughout the window");

      const maxWaitMs = operatorPollWindowMs + TICK_INTERVAL_MS + 500;
      const supervisorGone = await waitFor(() => !alive(supervisor.pid), maxWaitMs);
      assert.ok(supervisorGone, `the supervisor must exit within operatorPollWindowMs + tickIntervalMs (waited ${maxWaitMs}ms)`);

      const run = readRunRow(dir, runId);
      assert.equal(run.state, "waiting-operator");

      const activeLease = countRows(dir, `SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL`, runId);
      assert.equal(activeLease, 0, "the lease row must be released");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
