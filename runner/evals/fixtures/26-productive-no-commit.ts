// Fixture: productive-no-commit.
//
// `implement--chatty-no-commit.jsonl` (P9d-i) emits seven `output`+`sleep
// 100` pairs (never idle for long) before finally reporting `completed` and
// exiting 0 — the false-positive case the idle-timeout mechanism must not
// misfire on: real, ongoing activity that never actually finishes until the
// end. Against a `timeoutBudget` whose `idleMs` clears the 100ms inter-event
// gaps and whose `wallMs` clears the whole ~800-900ms real run, the watchdog
// must never fire at all, so the attempt completes normally.
//
// `implement`'s `"completed"` verdict is not terminal (its transition is
// `collect-implementation-artifacts`, which with empty `requiredArtifacts`/
// `checks` falls through to a real `review-spec` dispatch, then
// `review-quality`), so this fixture also supplies two small synthesized
// `pass` streams for those stages, mirroring `14-review-gates.ts`'s own
// `queueReviewerScenario` helper. Those synthesized reports deliberately omit
// `findings` entirely (not merely pass an empty array): `record-minors`'s
// `recordMinors` predicate, left unset here, falls through to the real
// `resolveRecordMinors`, which only resolves to `"true"` because
// `partitionFindings(undefined)` yields zero minor findings
// (`workflow-stages.ts`) — a `findings` field, even `[]`, would still satisfy
// that specific path only by accident, and a non-empty one would instead
// route through `appendMinorFindings`/`loadConfig().followUpsFilePath`, a
// real filesystem write outside this fixture's temp dir.

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
import type { AttemptDescriptor } from "../../src/adapters/adapter.ts";

const TASK_ID = "task-1";

const CHATTY_NO_COMMIT_SOURCE = fileURLToPath(
  new URL("../fake-bin/streams/implement--chatty-no-commit.jsonl", import.meta.url),
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

// The real SIGTERM/SIGKILL termination path (never expected to fire in this
// fixture, since the watchdog must not time out here, but `FakeAdapter`
// always spawns a real OS child process regardless of scenario, so a real
// implementation is still required, exactly as in `25-idle-timeout.ts`).
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

function reviewerReport(runId: string, stageId: string, roleId: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId,
    status: "completed",
    verdict: "pass",
    summary: `reviewer reported pass for ${stageId}`,
    // Deliberately no `findings` field — see the module comment above.
  };
}

function writeStreamFile(streamsDir: string, stageId: string, scenario: string, ops: readonly unknown[]): void {
  const filePath = path.join(streamsDir, `${stageId}--${scenario}.jsonl`);
  fs.writeFileSync(filePath, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

function queueReviewerScenario(streamsDir: string, runId: string, stageId: string, roleId: string): void {
  writeStreamFile(streamsDir, stageId, "pass", [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(runId, stageId, roleId) },
    { op: "exit", code: 0 },
  ]);
}

export async function productiveNoCommit(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startFixtureRun(dir, [{ id: TASK_ID, priority: 0 }]);
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));
    const registry = new ProcessRegistry();

    try {
      const db = openStore(dir);
      try {
        fs.writeFileSync(
          path.join(streamsDir, "implement--chatty-no-commit.jsonl"),
          fs.readFileSync(CHATTY_NO_COMMIT_SOURCE),
        );
        queueReviewerScenario(streamsDir, runId, "review-spec", "spec-reviewer");
        queueReviewerScenario(streamsDir, runId, "review-quality", "code-quality-reviewer");

        const adapter = new FakeAdapter({
          terminate,
          streamsDir,
          scenarioFor: (attempt: AttemptDescriptor) => {
            if (attempt.stageId === "implement") return "chatty-no-commit";
            if (attempt.stageId === "review-spec") return "pass";
            if (attempt.stageId === "review-quality") return "pass";
            throw new Error(`no scenario queued for stage ${attempt.stageId}`);
          },
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
          timeoutBudget: { spawnMs: 3000, idleMs: 400, wallMs: 2000 },
        };

        let outcome;
        try {
          outcome = await runDevelopmentStages(input);
        } finally {
          for (const pgid of recordedPgidsForRun(dir, runId)) registry.track(pgid);
        }

        assert.equal(outcome.outcome, "integrating", JSON.stringify(outcome));

        const attemptRow = db
          .prepare(`SELECT * FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'implement'`)
          .get(runId, TASK_ID) as Record<string, unknown> | undefined;
        assert.ok(attemptRow, "an attempts row must exist for the implement stage");
        assert.equal(attemptRow!.status, "completed");
        assert.equal(attemptRow!.interrupt_reason, null);

        const timedOutEvents = db
          .prepare(`SELECT * FROM events WHERE run_id = ? AND type = 'attempt.timed-out'`)
          .all(runId) as Array<Record<string, unknown>>;
        assert.equal(timedOutEvents.length, 0, "no attempt.timed-out event may exist anywhere in this fixture's run");
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
