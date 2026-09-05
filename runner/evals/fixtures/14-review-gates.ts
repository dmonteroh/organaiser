// Fixture: review-gates.
//
// Two properties of the `dev-workflow` driver's review gate that hold
// structurally from `DEVELOPMENT_STAGES`'s own transitions, proven here on a
// real, spawned-per-attempt run rather than by inspection of the table:
//
// `gateOrder`: a full happy-path run never records `review-quality` before
// `review-spec` has recorded a `pass` verdict, even across a fail-then-repair
// round on `review-spec` itself.
//
// `blockingFindingRequiresProof`: a `review-quality` report carrying an
// `important` finding with no `proof` fails `stage-result.schema.json`'s own
// bundled `review-finding` validation in full (goals spec section 15's
// candidate-report classification), so the driver parks with
// `schema-invalid` rather than ever dispatching `fix-quality`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertOperatorCheckoutUnchanged, openStore, startGitFixtureRun, withFixtureWorkspace } from "./harness.ts";
import { runDevelopmentStages, type DevelopmentStageInput } from "../../src/engine/workflow-stages.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../../src/adapters/adapter.ts";

const TASK_ID = "task-1";

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function fakeClock(startMs: number): { now: () => number } {
  let current = startMs;
  return {
    now: () => {
      current += 1;
      return current;
    },
  };
}

function implementerReport(runId: string, stageId: string, status: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId: "implementer",
    status,
    summary: `implementer reported ${status}`,
  };
}

function reviewerReport(
  runId: string,
  stageId: string,
  roleId: string,
  verdict: string,
  findings?: readonly Record<string, unknown>[],
): Record<string, unknown> {
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
    verdict,
    summary: `reviewer reported ${verdict}`,
    ...(findings ? { findings } : {}),
  };
}

function writeStreamFile(streamsDir: string, stageId: string, scenario: string, ops: readonly unknown[]): void {
  fs.mkdirSync(streamsDir, { recursive: true });
  const filePath = path.join(streamsDir, `${stageId}--${scenario}.jsonl`);
  fs.writeFileSync(filePath, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

function queueImplementerScenario(streamsDir: string, runId: string, stageId: string, scenario: string): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "working" },
    { op: "report", report: implementerReport(runId, stageId, "completed") },
    { op: "exit", code: 0 },
  ]);
}

function queueReviewerScenario(
  streamsDir: string,
  runId: string,
  stageId: string,
  roleId: string,
  scenario: string,
  verdict: string,
  findings?: readonly Record<string, unknown>[],
): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(runId, stageId, roleId, verdict, findings) },
    { op: "exit", code: 0 },
  ]);
}

function makeAdapter(streamsDir: string): {
  adapter: FakeAdapter;
  queue: (stageId: string, scenario: string) => void;
  descriptors: AttemptDescriptor[];
} {
  const queues = new Map<string, string[]>();
  const descriptors: AttemptDescriptor[] = [];
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (attempt: AttemptDescriptor) => {
      descriptors.push(attempt);
      const queue = queues.get(attempt.stageId);
      if (queue && queue.length > 0) return queue.shift() as string;
      throw new Error(`no scenario queued for stage ${attempt.stageId}`);
    },
  });
  return {
    adapter,
    queue: (stageId, scenario) => {
      const existing = queues.get(stageId) ?? [];
      existing.push(scenario);
      queues.set(stageId, existing);
    },
    descriptors,
  };
}

// `.orga`-rooted, exactly as `scheduler.ts` places its own `taskEvidenceDir`:
// the barrier's ledger write must stay out of the operator's own checkout,
// which `assertOperatorCheckoutUnchanged` asserts is untouched.
function taskEvidenceDir(dir: string, runId: string): string {
  return path.join(dir, ".orga", "runs", runId, "tasks", TASK_ID);
}

function baseInput(
  runId: string,
  dir: string,
  db: ReturnType<typeof openStore>,
  adapter: FakeAdapter,
  clock: { now: () => number },
): DevelopmentStageInput {
  const taskDir = taskEvidenceDir(dir, runId);
  fs.mkdirSync(taskDir, { recursive: true });
  return {
    db,
    adapter,
    runId,
    taskId: TASK_ID,
    now: clock.now,
    taskDir,
    executionRoot: dir,
    requiredArtifacts: [],
    checks: {},
    env: process.env,
  };
}

export async function gateOrder(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startGitFixtureRun(dir, [{ id: TASK_ID, priority: 0 }]);
    // Outside `dir`: a directory inside it would itself be a new untracked
    // path the moment it is written, which `assertOperatorCheckoutUnchanged`
    // would then (correctly) flag.
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const db = openStore(dir);
        try {
          const { adapter, queue } = makeAdapter(streamsDir);
          queueImplementerScenario(streamsDir, runId, "implement", "completed");
          queue("implement", "completed");
          queueReviewerScenario(streamsDir, runId, "review-spec", "spec-reviewer", "fail", "fail");
          queue("review-spec", "fail");
          queueImplementerScenario(streamsDir, runId, "fix-spec", "completed");
          queue("fix-spec", "completed");
          queueReviewerScenario(streamsDir, runId, "review-spec", "spec-reviewer", "pass", "pass");
          queue("review-spec", "pass");
          queueReviewerScenario(streamsDir, runId, "review-quality", "code-quality-reviewer", "pass", "pass");
          queue("review-quality", "pass");

          const outcome = await runDevelopmentStages(baseInput(runId, dir, db, adapter, fakeClock(1_000_000)));

          assert.equal(outcome.outcome, "integrating", JSON.stringify(outcome));
          const stageIds = outcome.stages.map((s) => s.stageId);
          const firstQualityIndex = stageIds.indexOf("review-quality");
          assert.notEqual(firstQualityIndex, -1, "review-quality must have run");

          const specPassIndex = outcome.stages.findIndex((s) => s.stageId === "review-spec" && s.verdict === "pass");
          assert.notEqual(specPassIndex, -1, "review-spec must have recorded a pass verdict");
          assert.ok(
            specPassIndex < firstQualityIndex,
            `review-quality (index ${firstQualityIndex}) ran before review-spec's pass (index ${specPassIndex}): ${JSON.stringify(stageIds)}`,
          );
          assert.ok(
            !stageIds.slice(0, firstQualityIndex).includes("review-quality"),
            "review-quality must never appear before its own first recorded run",
          );
        } finally {
          db.close();
        }
      });
    } finally {
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}

export async function blockingFindingRequiresProof(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startGitFixtureRun(dir, [{ id: TASK_ID, priority: 0 }]);
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const db = openStore(dir);
        try {
          const { adapter, queue } = makeAdapter(streamsDir);
          queueImplementerScenario(streamsDir, runId, "implement", "completed");
          queue("implement", "completed");
          queueReviewerScenario(streamsDir, runId, "review-spec", "spec-reviewer", "pass", "pass");
          queue("review-spec", "pass");
          queueReviewerScenario(
            streamsDir,
            runId,
            "review-quality",
            "code-quality-reviewer",
            "fail-no-proof",
            "fail-with-severity: important",
            [{ id: "f-1", severity: "important", summary: "no proof", path: "src/example.ts" }],
          );
          queue("review-quality", "fail-no-proof");

          const outcome = await runDevelopmentStages(baseInput(runId, dir, db, adapter, fakeClock(1_000_000)));

          assert.equal(outcome.outcome, "parked", JSON.stringify(outcome));
          assert.equal(outcome.schemaInvalid?.stageId, "review-quality");
          assert.ok(!outcome.stages.some((s) => s.stageId === "fix-quality"), "fix-quality must never run");
        } finally {
          db.close();
        }
      });
    } finally {
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}
