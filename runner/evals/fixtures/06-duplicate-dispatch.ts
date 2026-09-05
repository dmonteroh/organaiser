// Fixture: duplicate-dispatch.
//
// Two parts. Supervisor race: a second supervisor started against a run
// whose first supervisor holds a fresh lease must find exactly one lease
// holder and itself exit 4. Dispatch race: two concurrent `dispatchAttempt`
// calls for the same `(run_id, task_id, stage_id, round, input_version)`
// key must leave exactly one `attempts` row, exactly one spawned worker
// process, and the loser recording a conflict rather than spawning.

import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  ProcessRegistry,
  alive,
  waitFor,
  startFixtureRun,
  seedTasks,
  countRows,
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
import { dispatchAttempt, computeInputVersion } from "../../src/engine/dispatch.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { DispatchAttemptInput } from "../../src/engine/dispatch.ts";

const TICK_INTERVAL_MS = 100;

export async function duplicateDispatchSupervisorRace(): Promise<void> {
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
          ).run("task-a", runId, "task-a", "task-a", "brief.md", "dev-workflow", "integration", "[]", 0, "defined", null, now, now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("working"),
        sleepLine(TICK_INTERVAL_MS * 20),
        reportLine({ taskId: "task-a", stageId: "integration", summary: "done" }),
        exitLine(0),
      ]);

      const first = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(first.pid);

      const leaseHeld = await waitFor(
        () => countRows(dir, `SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL`, runId) === 1,
        2000,
      );
      assert.ok(leaseHeld, "the first supervisor must hold a fresh lease before the race starts");

      const second = spawn(
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
      // child's own `exit` event next.
      second.stdout?.resume();
      second.stderr?.resume();
      if (typeof second.pid === "number") registry.track(second.pid);

      const secondExitCode = await new Promise<number | null>((resolve) => second.on("exit", resolve));
      assert.equal(secondExitCode, 4, "the second supervisor must exit 4 against an already-fresh lease");

      const activeLeaseCount = countRows(dir, `SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL`, runId);
      assert.equal(activeLeaseCount, 1, "exactly one lease must remain held");
      const activeOwner = allRows<{ owner_pid: number }>(
        dir,
        `SELECT owner_pid FROM locks WHERE resource = ? AND released_at IS NULL`,
        runId,
      )[0] as { owner_pid: number };
      assert.equal(activeOwner.owner_pid, first.pid, "the first supervisor must remain the sole lease holder");
      assert.ok(alive(first.pid), "the winning supervisor must still be alive");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function duplicateDispatchRace(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
      seedTasks(dir, runId, [{ id: "task-a" }], Date.now());

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "implementation", "task-a", [
        outputLine("working"),
        sleepLine(TICK_INTERVAL_MS * 10),
        reportLine({ taskId: "task-a", stageId: "implementation", summary: "done" }),
        exitLine(0),
      ]);

      const terminate: TerminateFn = async ({ pgid }) => {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          // already gone
        }
        return { signalSent: "SIGKILL", exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
      };
      const adapter = new FakeAdapter({ terminate, streamsDir, scenarioFor: (attempt) => attempt.taskId });

      const db = openStore(dir);
      try {
        const inputVersion = computeInputVersion({ taskId: "task-a", stageId: "implementation", round: "1" });
        const dispatchInput: DispatchAttemptInput = {
          runId,
          taskId: "task-a",
          stageId: "implementation",
          role: "implementer",
          round: 1,
          inputVersion,
          vendor: "fake",
          model: "fake",
          configJson: "{}",
          mutating: true,
          timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
          workingDirectory: dir,
          environment: process.env,
          packet: "packet body",
        };

        const [a, b] = await Promise.allSettled([
          dispatchAttempt(db, adapter, dispatchInput, Date.now),
          dispatchAttempt(db, adapter, dispatchInput, Date.now),
        ]);

        const outcomes = [a, b].map((result) => (result.status === "fulfilled" ? result.value : { dispatched: false, reason: "threw" as const }));
        const dispatchedOutcomes = outcomes.filter((outcome) => outcome.dispatched);
        const conflictOutcomes = outcomes.filter((outcome) => !outcome.dispatched);
        assert.equal(dispatchedOutcomes.length, 1, `exactly one caller must have dispatched: ${JSON.stringify(outcomes)}`);
        assert.equal(conflictOutcomes.length, 1, "exactly one caller must have recorded a conflict rather than spawning");
        if (conflictOutcomes[0] && "reason" in conflictOutcomes[0]) {
          assert.equal((conflictOutcomes[0] as { reason: string }).reason, "duplicate");
        }

        const attemptsCount = countRows(
          dir,
          `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-a' AND stage_id = 'implementation' AND round = 1 AND input_version = ?`,
          runId,
          inputVersion,
        );
        assert.equal(attemptsCount, 1, "exactly one attempts row must exist for the contested idempotency key");

        const workerRows = allRows<{ pgid: number }>(dir, `SELECT DISTINCT pgid FROM workers WHERE run_id = ?`, runId);
        assert.equal(workerRows.length, 1, "exactly one worker process must have been spawned");
        for (const worker of workerRows) registry.track(worker.pgid);
      } finally {
        db.close();
      }
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
