import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../src/adapters/adapter.ts";
import { runDevelopmentStages, type DevelopmentStageInput } from "../src/engine/workflow-stages.ts";
import { createSchedulerRuntime, executeGates } from "../src/engine/scheduler.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const RUN_ID = "run-1";
const TASK_ID = "task-1";

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

interface TestEnv {
  dir: string;
  db: ReturnType<typeof openStore>;
  clock: { now: () => number };
  taskDir: string;
  streamsDir: string;
}

function fakeClock(startMs: number): { now: () => number } {
  let current = startMs;
  return {
    now: () => {
      current += 1;
      return current;
    },
  };
}

async function withEnv(fn: (env: TestEnv) => Promise<void>): Promise<void> {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(RUN_ID, "board.yaml", "running", "starting", 1_000_000);
      });
      const taskDir = path.join(dir, "task-dir");
      fs.mkdirSync(taskDir, { recursive: true });
      const streamsDir = path.join(dir, "streams");
      fs.mkdirSync(streamsDir, { recursive: true });
      await fn({ dir, db, clock: fakeClock(1_000_000), taskDir, streamsDir });
    } finally {
      db.close();
    }
  });
}

function baseInput(env: TestEnv, adapter: FakeAdapter, overrides: Partial<DevelopmentStageInput> = {}): DevelopmentStageInput {
  return {
    db: env.db,
    adapter,
    runId: RUN_ID,
    taskId: TASK_ID,
    now: env.clock.now,
    taskDir: env.taskDir,
    executionRoot: env.dir,
    requiredArtifacts: [],
    checks: {},
    env: process.env,
    ...overrides,
  };
}

function writeStreamFile(streamsDir: string, stageId: string, scenario: string, ops: readonly unknown[]): void {
  const filePath = path.join(streamsDir, `${stageId}--${scenario}.jsonl`);
  fs.writeFileSync(filePath, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

function implementerReport(stageId: string, status: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: RUN_ID,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId: "implementer",
    status,
    summary: `implementer reported ${status}`,
  };
}

function reviewerReport(
  stageId: string,
  roleId: string,
  verdict: string,
  findings: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: RUN_ID,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId,
    status: "completed",
    verdict,
    summary: `reviewer reported ${verdict}`,
    findings,
  };
}

function queueImplementerScenario(streamsDir: string, stageId: string, scenario: string, status: string): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "working" },
    { op: "report", report: implementerReport(stageId, status) },
    { op: "exit", code: 0 },
  ]);
}

function queueReviewerScenario(
  streamsDir: string,
  stageId: string,
  roleId: string,
  scenario: string,
  verdict: string,
  findings: readonly Record<string, unknown>[],
): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(stageId, roleId, verdict, findings) },
    { op: "exit", code: 0 },
  ]);
}

// Scenario resolution is queue-based rather than round-based, mirroring
// `workflow-stages.test.ts`'s own `makeAdapter`: `AttemptDescriptor` carries
// no round number, so each test enqueues, per stage id, the exact ordered
// sequence of scenario names it expects the driver to dispatch.
function makeAdapter(streamsDir: string): { adapter: FakeAdapter; queue: (stageId: string, scenario: string) => void } {
  const queues = new Map<string, string[]>();
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (attempt: AttemptDescriptor) => {
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
  };
}

function finding(id: string): Record<string, unknown> {
  return { id, severity: "minor", summary: `finding ${id}`, path: "src/example.ts" };
}

function gateRows(
  db: TestEnv["db"],
  gateType: string,
): Array<{ round: number; verdict: string | null; evidence_ref: string | null; cap: number }> {
  return db
    .prepare(
      `SELECT round, verdict, evidence_ref, cap FROM gates WHERE run_id = ? AND task_id = ? AND gate_type = ? ORDER BY round ASC`,
    )
    .all(RUN_ID, TASK_ID, gateType) as Array<{ round: number; verdict: string | null; evidence_ref: string | null; cap: number }>;
}

test("runDevelopmentStages parks at a gate's cap with every round's findings durably recorded, keyed by round", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");

    const roundFindings = [1, 2, 3].map((round) => [finding(`spec-finding-${round}`)]);

    for (let round = 1; round <= 3; round += 1) {
      const scenario = `fail-${round}`;
      queueReviewerScenario(
        env.streamsDir,
        "review-spec",
        "spec-reviewer",
        scenario,
        "fail",
        roundFindings[round - 1] as Record<string, unknown>[],
      );
      queue("review-spec", scenario);
      if (round < 3) {
        queueImplementerScenario(env.streamsDir, "fix-spec", `completed-${round}`, "completed");
        queue("fix-spec", `completed-${round}`);
      }
    }

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.equal(outcome.gateRounds.specReviewGate, 3);

    const rows = gateRows(env.db, "specReviewGate");
    assert.equal(rows.length, 3, "one durable row per round, not just the last");
    assert.deepEqual(rows.map((row) => row.round), [1, 2, 3]);
    assert.ok(rows.every((row) => row.verdict === "fail" && row.cap === 3));

    rows.forEach((row, index) => {
      assert.ok(row.evidence_ref, `round ${index + 1} carries recorded evidence`);
      const report = JSON.parse(row.evidence_ref as string) as { findings: Array<{ id: string }> };
      assert.deepEqual(
        report.findings.map((finding) => finding.id),
        [`spec-finding-${index + 1}`],
        `round ${index + 1}'s evidence carries only that round's own finding`,
      );
    });
  });
});

test("a restarted driver resumes a gate's round count from the highest durably recorded round, not zero", async () => {
  await withEnv(async (env) => {
    withTransaction(env.db, () => {
      env.db
        .prepare(
          `INSERT INTO gates (id, run_id, task_id, gate_type, round, verdict, evidence_ref, cap, created_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "gate-prior",
          RUN_ID,
          TASK_ID,
          "specReviewGate",
          1,
          "fail",
          JSON.stringify({ findings: [finding("spec-finding-1")] }),
          3,
          1_000_000,
          1_000_000,
        );
    });

    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail-2", "fail", [finding("spec-finding-2")]);
    queue("review-spec", "fail-2");
    queueImplementerScenario(env.streamsDir, "fix-spec", "completed-2", "completed");
    queue("fix-spec", "completed-2");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail-3", "fail", [finding("spec-finding-3")]);
    queue("review-spec", "fail-3");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked", "the resumed count reaches the cap after only two more real rounds");
    assert.equal(outcome.gateRounds.specReviewGate, 3);

    const rows = gateRows(env.db, "specReviewGate");
    assert.deepEqual(rows.map((row) => row.round), [1, 2, 3], "the pre-existing round is never re-numbered or duplicated");
  });
});

test("a speculative round that ultimately passes is discarded, not left as a dangling row", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail", "fail", [finding("spec-finding-1")]);
    queue("review-spec", "fail");
    queueImplementerScenario(env.streamsDir, "fix-spec", "completed", "completed");
    queue("fix-spec", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass", []);
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass", []);
    queue("review-quality", "pass");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "integrating");
    assert.equal(outcome.gateRounds.specReviewGate, 1, "the passing review-spec attempt never became round 2");

    const rows = gateRows(env.db, "specReviewGate");
    assert.deepEqual(rows.map((row) => row.round), [1], "no dangling row is left for the passing attempt");
  });
});

test("a genuinely pending gate row orphaned by a crashed invocation is discarded on restart, and the resumed count still reaches its cap without leaving a permanent invariant violation behind", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const taskDir = path.join(dir, "task-dir");
    fs.mkdirSync(taskDir, { recursive: true });
    const streamsDir = path.join(dir, "streams");
    fs.mkdirSync(streamsDir, { recursive: true });
    const clock = fakeClock(1_000_000);

    let db = openStore(dir);
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(RUN_ID, "board.yaml", "running", "starting", 1_000_000);
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(TASK_ID, RUN_ID, TASK_ID, "Task", null, "dev-workflow", "review-spec", "[]", 0, "spec-review", null, 1_000_000, 1_000_000);
      // A genuinely pending row: `insertPendingGate` wrote it before
      // dispatch, but the invocation that wrote it never reached its own
      // `finalizeGate`/`discardPendingGate` call.
      db.prepare(
        `INSERT INTO gates (id, run_id, task_id, gate_type, round, cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("gate-orphan", RUN_ID, TASK_ID, "specReviewGate", 1, 3, 1_000_000);
    });
    db.close();

    // Simulate a restart: a fresh connection to the same on-disk store, with
    // no in-memory state carried over from the crashed invocation that left
    // "gate-orphan" pending.
    db = openStore(dir);
    try {
      const { adapter, queue } = makeAdapter(streamsDir);
      queueImplementerScenario(streamsDir, "implement", "completed", "completed");
      queue("implement", "completed");
      queueReviewerScenario(streamsDir, "review-spec", "spec-reviewer", "fail-2", "fail", [finding("spec-finding-2")]);
      queue("review-spec", "fail-2");
      queueImplementerScenario(streamsDir, "fix-spec", "completed-2", "completed");
      queue("fix-spec", "completed-2");
      queueReviewerScenario(streamsDir, "review-spec", "spec-reviewer", "fail-3", "fail", [finding("spec-finding-3")]);
      queue("review-spec", "fail-3");

      const outcome = await runDevelopmentStages({
        db,
        adapter,
        runId: RUN_ID,
        taskId: TASK_ID,
        now: clock.now,
        taskDir,
        executionRoot: dir,
        requiredArtifacts: [],
        checks: {},
        env: process.env,
      });

      assert.equal(outcome.outcome, "parked", "the resumed count reaches the cap after only two more real rounds");
      assert.equal(outcome.gateRounds.specReviewGate, 3);

      const rows = gateRows(db, "specReviewGate");
      assert.deepEqual(
        rows.map((row) => row.round),
        [2, 3],
        "the orphaned round-1 row is discarded, not re-decided or renumbered",
      );
      assert.ok(rows.every((row) => row.verdict === "fail"));

      withTransaction(db, () => {
        db.prepare(`UPDATE tasks SET disposition = ? WHERE id = ?`).run("parked", TASK_ID);
      });

      const runtime = createSchedulerRuntime();
      const ctx: TickContext = {
        db,
        runId: RUN_ID,
        tickIndex: 0,
        now: clock.now,
        leaseDeadlineMs: clock.now() + 60000,
        signal: new AbortController().signal,
      };
      executeGates(ctx, runtime);
      assert.deepEqual(
        runtime.scratch.invariantViolations,
        [],
        "no dangling pending row remains for executeGates to flag once the task resolves to a terminal disposition",
      );
    } finally {
      db.close();
    }
  });
});
