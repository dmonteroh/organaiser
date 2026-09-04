// Fixture: board-not-drained.
//
// Task B depends on task A; A's fake adapter reports `status: failed`. The
// run must never reach `succeeded`, must land on `blocked` with invariant
// evidence recorded on an event, B must never be dispatched, and `run wait
// --until succeeded,failed,blocked` must exit 11.

import assert from "node:assert/strict";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  startFixtureRun,
  seedTasks,
  readRunRow,
  readTaskRow,
  countRows,
  allRows,
  spawnFixtureSupervisor,
  writeStream,
  reportLine,
  outputLine,
  exitLine,
  withFixtureWorkspace,
} from "./harness.ts";
import { main } from "../../bin/orga.ts";
import { EXIT_CODES } from "../../src/cli/exit-codes.ts";
import type { Io } from "../../src/cli/commands.ts";

const TICK_INTERVAL_MS = 100;

function fakeIo(dir: string): Io & { outLines: string[] } {
  const outLines: string[] = [];
  return {
    outLines,
    stdout: (line: string) => outLines.push(line),
    stderr: () => {},
    cwd: () => dir,
    now: () => Date.now(),
    env: {},
  };
}

export async function boardNotDrained(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }, { id: "task-b", dependsOn: ["task-a"] }]);
      seedTasks(
        dir,
        runId,
        [{ id: "task-a" }, { id: "task-b", dependsOn: ["task-a"] }],
        Date.now(),
      );

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "implementation", "task-a", [
        outputLine("failing"),
        reportLine({ taskId: "task-a", stageId: "implementation", status: "failed", summary: "could not implement" }),
        exitLine(0),
      ]);
      // task-b's stream deliberately does not exist: if it were ever
      // dispatched this fixture would fail on the missing-file crash rather
      // than proving it, which is the point.

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      const reachedTerminal = await waitFor(() => {
        const run = readRunRow(dir, runId);
        return ["blocked", "succeeded", "failed", "cancelled"].includes(run.state as string);
      }, 5000);
      assert.ok(reachedTerminal, `run did not settle; last row: ${JSON.stringify(readRunRow(dir, runId))}`);

      const run = readRunRow(dir, runId);
      assert.equal(run.state, "blocked", "the run must never reach succeeded when a dependency task parks on failure");

      const events = allRows<{ type: string; payload: string }>(
        dir,
        `SELECT type, payload FROM events WHERE run_id = ? AND type = 'run.resting' ORDER BY seq DESC LIMIT 1`,
        runId,
      );
      assert.equal(events.length, 1, "a run.resting event recording the blocked disposition must exist");
      const payload = JSON.parse((events[0] as { payload: string }).payload) as { state: string; reason: string | null };
      assert.equal(payload.state, "blocked");
      assert.ok(payload.reason && payload.reason.length > 0, "invariant evidence must be recorded on the event");

      const taskB = readTaskRow(dir, "task-b");
      assert.equal(taskB?.disposition, null, "task B must never be dispatched while its dependency has not integrated");
      const taskA = readTaskRow(dir, "task-a");
      assert.equal(taskA?.disposition, "parked", "task A's failed attempt must park it");

      const attemptsForB = countRows(dir, `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-b'`, runId);
      assert.equal(attemptsForB, 0, "zero attempts rows for task B");

      const waitIo = fakeIo(dir);
      const waitCode = await main(
        ["node", "orga", "run", "wait", runId, "--until", "succeeded,failed,blocked"],
        waitIo,
      );
      assert.equal(waitCode, EXIT_CODES.BLOCKED);
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
