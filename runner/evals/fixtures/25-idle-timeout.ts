// Fixture: idle-timeout.
//
// `implement--silent-until-killed.jsonl` (P9d-i) emits exactly one `output`
// event near-instantly, then a single 60-second sleep with no further event
// and no exit. Against a `timeoutBudget` whose `idleMs` clears comfortably
// under 60000ms and whose `wallMs` clears `idleMs` by a comfortable margin,
// the watchdog (`runner/src/engine/timeout-watchdog.ts`, P9d-i) must fire on
// the idle timer specifically, not the wall timer — proving a genuinely
// silent worker is actually terminated. `runDevelopmentStages`
// (`runner/src/engine/workflow-stages.ts`, P9d-ii) then records the real,
// landed timeout bookkeeping this fixture asserts: an `interrupted` attempt
// with `interrupt_reason = 'worker-timeout'`, a `signalled` worker, an
// `attempt.timed-out` event, and the terminal `worker-timeout -> parked`
// transition (`IMPLEMENTER_TRANSITIONS`) — `runDevelopmentStages`'s loop
// stops immediately, so only the one stream file is needed.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProcessRegistry,
  openStore,
  recordedPgidsForRun,
  startFixtureRun,
  withFixtureWorkspace,
} from "./harness.ts";
import { runDevelopmentStages, type DevelopmentStageInput } from "../../src/engine/workflow-stages.ts";
import { FakeAdapter, type RecordedProcessInfo, type TerminateFn } from "../../src/adapters/fake.ts";

const TASK_ID = "task-1";

const SILENT_UNTIL_KILLED_SOURCE = fileURLToPath(
  new URL("../fake-bin/streams/implement--silent-until-killed.jsonl", import.meta.url),
);

function isAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The real SIGTERM/SIGKILL termination path, not a no-op: `FakeAdapter.start`
// always spawns a real OS child process via `replay.ts` regardless of
// scenario, so a genuine `worker-timeout` here really does need to kill it.
// Mirrors `runner/test/timeout-watchdog.test.ts`'s own `terminate` helper.
const terminate: TerminateFn = async (info: RecordedProcessInfo, gracePeriodMs: number) => {
  const { pgid } = info;
  let signalSent: NodeJS.Signals | null = null;
  try {
    process.kill(-pgid, "SIGTERM");
    signalSent = "SIGTERM";
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && isAlive(pgid)) {
    await sleep(10);
  }
  if (isAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
      signalSent = "SIGKILL";
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && isAlive(pgid); i++) await sleep(10);
  }
  return {
    signalSent,
    exitCode: null,
    killedProcessTree: !isAlive(pgid),
    timedOutWaitingForExit: isAlive(pgid),
  };
};

function taskEvidenceDir(dir: string, runId: string): string {
  return path.join(dir, ".orga", "runs", runId, "tasks", TASK_ID);
}

export async function idleTimeout(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startFixtureRun(dir, [{ id: TASK_ID, priority: 0 }]);
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));
    const registry = new ProcessRegistry();

    try {
      const db = openStore(dir);
      try {
        fs.writeFileSync(
          path.join(streamsDir, "implement--silent-until-killed.jsonl"),
          fs.readFileSync(SILENT_UNTIL_KILLED_SOURCE),
        );

        const adapter = new FakeAdapter({
          terminate,
          streamsDir,
          scenarioFor: () => "silent-until-killed",
        });

        const taskDir = taskEvidenceDir(dir, runId);
        fs.mkdirSync(taskDir, { recursive: true });

        const input: DevelopmentStageInput = {
          db,
          adapter,
          runId,
          taskId: TASK_ID,
          now: () => Date.now(),
          taskDir,
          executionRoot: dir,
          requiredArtifacts: [],
          checks: {},
          env: process.env,
          timeoutBudget: { spawnMs: 3000, idleMs: 200, wallMs: 1000 },
        };

        let outcome;
        try {
          outcome = await runDevelopmentStages(input);
        } finally {
          for (const pgid of recordedPgidsForRun(dir, runId)) registry.track(pgid);
        }

        assert.equal(outcome.outcome, "parked", JSON.stringify(outcome));
        assert.deepEqual(
          outcome.stages,
          [{ stageId: "implement", verdict: "worker-timeout" }],
          JSON.stringify(outcome.stages),
        );

        const attemptRows = db
          .prepare(`SELECT * FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'implement'`)
          .all(runId, TASK_ID) as Array<Record<string, unknown>>;
        assert.equal(attemptRows.length, 1, "exactly one attempts row for (task, implement) after the fixture completes");
        const attemptRow = attemptRows[0]!;
        assert.equal(attemptRow.round, 1);
        assert.equal(attemptRow.status, "interrupted");
        assert.equal(attemptRow.interrupt_reason, "worker-timeout");

        const workerRow = db
          .prepare(`SELECT * FROM workers WHERE attempt_id = ?`)
          .get(attemptRow.id as string) as Record<string, unknown> | undefined;
        assert.ok(workerRow, "a workers row must exist for the timed-out attempt");
        assert.equal(workerRow!.termination_state, "signalled");

        const timedOutEvents = db
          .prepare(`SELECT * FROM events WHERE run_id = ? AND attempt_id = ? AND type = 'attempt.timed-out'`)
          .all(runId, attemptRow.id as string) as Array<Record<string, unknown>>;
        assert.equal(timedOutEvents.length, 1, "exactly one attempt.timed-out event for the timed-out attempt");
        assert.deepEqual(
          JSON.parse(timedOutEvents[0]!.payload as string),
          { firedBudget: "idle-timeout" },
          "the timed-out event must record the idle timer, not the wall or spawn timer, as the one that fired",
        );

        const normalizedEvents = db
          .prepare(`SELECT * FROM events WHERE run_id = ? AND attempt_id = ? AND type = 'attempt.normalized'`)
          .all(runId, attemptRow.id as string) as Array<Record<string, unknown>>;
        assert.equal(normalizedEvents.length, 0, "no attempt.normalized event may exist for a timed-out attempt");
      } finally {
        db.close();
      }
    } finally {
      registry.killAll();
      await registry.allDead();
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}
