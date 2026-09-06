import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import type { TickContext } from "../src/engine/tick.ts";
import {
  advanceTransitions,
  classifyTick,
  createSchedulerRuntime,
  createSchedulerTick,
  DEFAULT_SCHEDULER_STEPS,
  dispatchEligible,
  executeGates,
  normalizeResults,
  reapWorkers,
  reconcileState,
  STAGE_DEFINITIONS,
  type SchedulerSteps,
  type WorkspaceProvider,
} from "../src/engine/scheduler.ts";
import { createWorkspace, DEFAULT_WORKTREE_ROOT, DEFAULT_BRANCH_PREFIX } from "../src/git/workspace.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor, ProcessAdapter } from "../src/adapters/adapter.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import { parseArgs, runTestSupervisor } from "../evals/fixtures/test-supervisor.ts";

const fixturesStreamsDir = fileURLToPath(new URL("./fixtures/fake-streams/", import.meta.url));

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function commitFile(dir: string, relPath: string, contents: string, message: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    message,
    "--",
    relPath,
  ]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

// Sets up a git repository at `dir` with an initialized, committed project,
// mirroring `workspace.test.ts`'s own `setupProject`.
function setupGitProject(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  const seed = commitFile(dir, "seed.txt", "seed\n", "seed");
  initProject(dir);
  runGit(dir, ["add", "--", "orga.yaml", ".gitignore"]);
  runGit(dir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "init orga project",
  ]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function defaultProvider(projectRoot: string): WorkspaceProvider {
  return { projectRoot, root: DEFAULT_WORKTREE_ROOT, branchPrefix: DEFAULT_BRANCH_PREFIX };
}

function seedFilesClaim(db: ReturnType<typeof openStore>, runId: string, taskId: string, paths: string[]): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`claim-${taskId}`, runId, taskId, "files", JSON.stringify(paths), 1000);
  });
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "starting", now);
  });
}

interface TaskSeed {
  id: string;
  runId: string;
  stageId: string | null;
  dependsOn?: string[];
  priority?: number;
  state?: string;
  briefPath?: string | null;
  disposition?: string | null;
  now: number;
}

function insertTask(db: ReturnType<typeof openStore>, seed: TaskSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.runId,
      seed.id,
      `Task ${seed.id}`,
      seed.briefPath === undefined ? "brief.md" : seed.briefPath,
      "task-board",
      seed.stageId,
      JSON.stringify(seed.dependsOn ?? []),
      seed.priority ?? 0,
      seed.state ?? "defined",
      seed.disposition ?? null,
      seed.now,
      seed.now,
    );
  });
}

function getTask(db: ReturnType<typeof openStore>, id: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>;
}

function buildCtx(db: ReturnType<typeof openStore>, runId: string, clock: ReturnType<typeof fakeClock>): TickContext {
  return {
    db,
    runId,
    tickIndex: 0,
    now: clock.now,
    leaseDeadlineMs: clock.now() + 60000,
    signal: new AbortController().signal,
  };
}

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function noWorkAdapter(): ProcessAdapter {
  return {
    probe: async () => {
      throw new Error("not used in this test");
    },
    start: async () => {
      throw new Error("not used in this test");
    },
    observe: async function* () {
      // empty
    },
    cancel: async () => ({ attemptId: "n/a", signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false }),
    collect: async () => {
      throw new Error("not used in this test");
    },
    classify: async () => {
      throw new Error("not used in this test");
    },
  };
}

// Writes one `dev-workflow` sub-stage's FakeAdapter stream file, mirroring
// `workflow-stages.test.ts`'s own `writeStreamFile`/`implementerReport`/
// `reviewerReport` helpers: a scheduler-level test drives `implementation`
// tasks through `runDevelopmentStages`, so its stream fixtures are keyed by
// the manifest's own sub-stage ids (`implement`, `review-spec`, ...), not by
// the board's `implementation`/`integration` stage ids `FakeAdapter`'s own
// checked-in fixtures use.
function writeDevStream(
  streamsDir: string,
  stageId: string,
  scenario: string,
  report: Record<string, unknown>,
): void {
  const ops = [
    { op: "output", text: "working" },
    { op: "report", report },
    { op: "exit", code: 0 },
  ];
  fs.mkdirSync(streamsDir, { recursive: true });
  fs.writeFileSync(
    path.join(streamsDir, `${stageId}--${scenario}.jsonl`),
    `${ops.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
}

function devImplementerReport(stageId: string, status: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: "run-1",
    taskId: "task-a",
    attemptId: "attempt-fixture",
    stageId,
    roleId: "implementer",
    status,
    summary: `implementer reported ${status}`,
  };
}

function devReviewerReport(stageId: string, roleId: string, verdict: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: "run-1",
    taskId: "task-a",
    attemptId: "attempt-fixture",
    stageId,
    roleId,
    status: "completed",
    verdict,
    summary: `reviewer reported ${verdict}`,
  };
}

async function withRunDb(
  fn: (env: {
    dir: string;
    db: ReturnType<typeof openStore>;
    runId: string;
    clock: ReturnType<typeof fakeClock>;
  }) => Promise<void>,
): Promise<void> {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1_000_000);
      const runId = "run-1";
      insertRun(db, runId, clock.now());
      await fn({ dir, db, runId, clock });
    } finally {
      db.close();
    }
  });
}

// Like `withRunDb`, but `dir` is a real git repository with an initial
// commit, so a workspace provider pointed at it can actually create
// worktrees.
async function withGitRunDb(
  fn: (env: {
    dir: string;
    db: ReturnType<typeof openStore>;
    runId: string;
    clock: ReturnType<typeof fakeClock>;
    baseCommit: string;
  }) => Promise<void>,
): Promise<void> {
  await withTempWorkspace(async (dir) => {
    const baseCommit = setupGitProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1_000_000);
      const runId = "run-1";
      insertRun(db, runId, clock.now());
      await fn({ dir, db, runId, clock, baseCommit });
    } finally {
      db.close();
    }
  });
}

test("createSchedulerTick calls the six named steps in goals spec section 11's order", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    const callOrder: string[] = [];
    const steps: SchedulerSteps = {
      reapWorkers: (ctx, runtime) => {
        callOrder.push("reapWorkers");
        return DEFAULT_SCHEDULER_STEPS.reapWorkers(ctx, runtime);
      },
      normalizeResults: async (ctx, runtime, adapter) => {
        callOrder.push("normalizeResults");
        return DEFAULT_SCHEDULER_STEPS.normalizeResults(ctx, runtime, adapter);
      },
      advanceTransitions: (ctx, runtime) => {
        callOrder.push("advanceTransitions");
        return DEFAULT_SCHEDULER_STEPS.advanceTransitions(ctx, runtime);
      },
      executeGates: (ctx, runtime) => {
        callOrder.push("executeGates");
        return DEFAULT_SCHEDULER_STEPS.executeGates(ctx, runtime);
      },
      reconcileState: (ctx, runtime) => {
        callOrder.push("reconcileState");
        return DEFAULT_SCHEDULER_STEPS.reconcileState(ctx, runtime);
      },
      dispatchEligible: async (ctx, runtime, adapter) => {
        callOrder.push("dispatchEligible");
        return DEFAULT_SCHEDULER_STEPS.dispatchEligible(ctx, runtime, adapter);
      },
    };

    const body = createSchedulerTick(noWorkAdapter(), steps);
    await body(buildCtx(db, runId, clock));

    assert.deepEqual(callOrder, [
      "reapWorkers",
      "normalizeResults",
      "advanceTransitions",
      "executeGates",
      "reconcileState",
      "dispatchEligible",
    ]);
  });
});

test("advanceTransitions evaluates the whole board every call: two independent tasks both progress in one pass", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "release-dependencies", now: clock.now() });
    insertTask(db, { id: "task-b", runId, stageId: "admit-to-batch", now: clock.now() });

    const runtime = createSchedulerRuntime();
    advanceTransitions(buildCtx(db, runId, clock), runtime);

    assert.equal(getTask(db, "task-a").stage_id, "acquire-claims");
    assert.equal(getTask(db, "task-b").stage_id, "product-specification");
    assert.equal(runtime.scratch.transitionedThisTick, true);
  });
});

test("advanceTransitions advances a task past acquire-claims once its files claim is seeded", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "acquire-claims", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["claimed.txt"]);

    const runtime = createSchedulerRuntime();
    advanceTransitions(buildCtx(db, runId, clock), runtime);

    assert.equal(getTask(db, "task-a").stage_id, "admit-to-batch");
  });
});

test("advanceTransitions leaves a task at acquire-claims when no files claim is seeded for it, including when a claim exists for another task or another dimension", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "acquire-claims", now: clock.now() });
    insertTask(db, { id: "task-b", runId, stageId: "acquire-claims", now: clock.now() });
    seedFilesClaim(db, runId, "task-b", ["claimed.txt"]);
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("claim-task-a-other-dimension", runId, "task-a", "other", JSON.stringify(["claimed.txt"]), 1000);
    });

    const runtime = createSchedulerRuntime();
    advanceTransitions(buildCtx(db, runId, clock), runtime);

    assert.equal(getTask(db, "task-a").stage_id, "acquire-claims");
  });
});

test("advanceTransitions records an invariant violation instead of writing a task's row when a stage's transition targets neither a known stage id nor a legal terminal disposition", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "task-refinement", now: clock.now() });

    const taskRefinement = STAGE_DEFINITIONS.find((stage) => stage.id === "task-refinement");
    assert.ok(taskRefinement, "task-refinement must be a defined stage");
    const transitions = taskRefinement.transitions as Record<string, string>;
    const originalTarget = transitions.skipped as string;
    transitions.skipped = "not-a-real-target";

    try {
      const runtime = createSchedulerRuntime();
      advanceTransitions(buildCtx(db, runId, clock), runtime);

      assert.equal(runtime.scratch.transitionedThisTick, false);
      assert.equal(runtime.scratch.invariantViolations.length, 1);
      assert.match(
        runtime.scratch.invariantViolations[0] as string,
        /targets "not-a-real-target", which is neither a known stage id nor a legal terminal disposition/,
      );

      const task = getTask(db, "task-a");
      assert.equal(task.stage_id, "task-refinement");
      assert.equal(task.disposition, null);
    } finally {
      transitions.skipped = originalTarget;
    }
  });
});

test("classifyTick: active when a worker is live, regardless of other counts", () => {
  const outcome = classifyTick({
    totalTaskCount: 1,
    acceptableTerminalCount: 0,
    waitingOperatorCount: 0,
    parkedCount: 0,
    liveWorkerCount: 1,
    invariantViolations: [],
    transitionedOrDispatchedThisTick: false,
  });
  assert.deepEqual(outcome, { kind: "active" });
});

test("classifyTick: progress when something transitioned or dispatched this tick", () => {
  const outcome = classifyTick({
    totalTaskCount: 2,
    acceptableTerminalCount: 0,
    waitingOperatorCount: 0,
    parkedCount: 0,
    liveWorkerCount: 0,
    invariantViolations: [],
    transitionedOrDispatchedThisTick: true,
  });
  assert.deepEqual(outcome, { kind: "progress" });
});

test("classifyTick: succeeded when every task reached an acceptable terminal disposition", () => {
  const outcome = classifyTick({
    totalTaskCount: 3,
    acceptableTerminalCount: 3,
    waitingOperatorCount: 0,
    parkedCount: 0,
    liveWorkerCount: 0,
    invariantViolations: [],
    transitionedOrDispatchedThisTick: false,
  });
  assert.equal(outcome.kind, "resting");
  assert.equal((outcome as { state: string }).state, "succeeded");
});

test("classifyTick: waiting-operator when only operator answers can create progress", () => {
  const outcome = classifyTick({
    totalTaskCount: 3,
    acceptableTerminalCount: 1,
    waitingOperatorCount: 2,
    parkedCount: 0,
    liveWorkerCount: 0,
    invariantViolations: [],
    transitionedOrDispatchedThisTick: false,
  });
  assert.equal(outcome.kind, "resting");
  assert.equal((outcome as { state: string }).state, "waiting-operator");
});

test("classifyTick: blocked with invariant evidence when a parked task remains or a predicate misbehaved", () => {
  const parked = classifyTick({
    totalTaskCount: 2,
    acceptableTerminalCount: 0,
    waitingOperatorCount: 0,
    parkedCount: 1,
    liveWorkerCount: 0,
    invariantViolations: [],
    transitionedOrDispatchedThisTick: false,
  });
  assert.equal(parked.kind, "resting");
  assert.equal((parked as { state: string }).state, "blocked");

  const invariant = classifyTick({
    totalTaskCount: 1,
    acceptableTerminalCount: 1,
    waitingOperatorCount: 0,
    parkedCount: 0,
    liveWorkerCount: 0,
    invariantViolations: ["predicate x returned an undeclared value"],
    transitionedOrDispatchedThisTick: false,
  });
  assert.equal(invariant.kind, "resting");
  assert.equal((invariant as { state: string; reason: string | null }).state, "blocked");
  assert.match((invariant as { reason: string }).reason, /undeclared value/);
});

test("the scheduler never emits succeeded while a pending gate remains, even if every task is acceptable-terminal", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: null, disposition: "integrated", now: clock.now() });
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO gates (id, run_id, task_id, gate_type, round, cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("gate-1", runId, "task-a", "verification", 1, 1, clock.now());
    });

    const body = createSchedulerTick(noWorkAdapter());
    const outcome = await body(buildCtx(db, runId, clock));

    assert.equal(outcome.kind, "resting");
    assert.equal((outcome as { state: string }).state, "blocked");
    assert.match((outcome as { reason: string }).reason, /pending gate/);
  });
});

test("the scheduler never emits succeeded while a live worker exists, even if every task looks terminal", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: null, disposition: "integrated", now: clock.now() });
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("attempt-a", runId, "task-a", "implementation", "implementer", 1, "v1", "fake", "fake", "{}", 1, "running", clock.now());
      db.prepare(
        `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("worker-a", runId, "attempt-a", 999999, 999999, clock.now(), clock.now());
    });

    const body = createSchedulerTick(noWorkAdapter());
    const outcome = await body(buildCtx(db, runId, clock));
    assert.notDeepEqual(outcome, { kind: "resting", state: "succeeded", reason: null });
    assert.equal(outcome.kind, "active");
  });
});

test("the scheduler never emits succeeded while a dispatchable task exists", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });

    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });
    const body = createSchedulerTick(adapter);
    const outcome = await body(buildCtx(db, runId, clock));

    assert.notEqual(outcome.kind === "resting" && (outcome as { state: string }).state, "succeeded");
    assert.ok(outcome.kind === "progress" || outcome.kind === "active");
  });
});

test("createSchedulerTick renders BOARD.md via the optional renderRoot when the tick dispatches a task", async () => {
  await withRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });

    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });
    const body = createSchedulerTick(adapter, DEFAULT_SCHEDULER_STEPS, undefined, undefined, dir);
    const outcome = await body(buildCtx(db, runId, clock));

    assert.ok(outcome.kind === "progress" || outcome.kind === "active");
    const boardPath = path.join(dir, ".orga", "runs", runId, "BOARD.md");
    assert.ok(fs.existsSync(boardPath));
  });
});

test("createSchedulerTick does not render BOARD.md when nothing transitions or dispatches this tick", async () => {
  await withRunDb(async ({ dir, db, runId, clock }) => {
    const body = createSchedulerTick(noWorkAdapter(), DEFAULT_SCHEDULER_STEPS, undefined, undefined, dir);
    const outcome = await body(buildCtx(db, runId, clock));

    assert.equal(outcome.kind, "resting");
    const boardPath = path.join(dir, ".orga", "runs", runId, "BOARD.md");
    assert.ok(!fs.existsSync(boardPath));
  });
});

test("executeGates and reconcileState record invariant evidence instead of throwing", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO gates (id, run_id, task_id, gate_type, round, cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("gate-1", runId, "task-a", "verification", 1, 1, clock.now());
    });
    const runtime = createSchedulerRuntime();
    executeGates(buildCtx(db, runId, clock), runtime);
    assert.equal(runtime.scratch.invariantViolations.length, 1);
    assert.match(runtime.scratch.invariantViolations[0] as string, /pending gate/);

    reconcileState(buildCtx(db, runId, clock), runtime);
    assert.equal(runtime.scratch.invariantViolations.length, 1, "no stray claim/worktree rows in this seed");
  });
});

test("the scheduler dispatches a two-task board strictly one attempt at a time", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", priority: 0, now: clock.now() });
    insertTask(db, { id: "task-b", runId, stageId: "integration", priority: 1, now: clock.now() });

    const adapter = new FakeAdapter({
      terminate: noopTerminate,
      streamsDir: fixturesStreamsDir,
      scenarioFor: () => "well-formed",
    });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter);

    const liveWorkers = db
      .prepare(`SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL`)
      .get(runId) as { n: number };
    assert.equal(liveWorkers.n, 1, "only one worker should be live after one dispatchEligible call");
    assert.equal(runtime.liveAttemptByTaskId.size, 1, "runtime should be tracking exactly the one live attempt");
    assert.ok(runtime.liveAttemptByTaskId.has("task-a"), "priority order dispatches task-a first");

    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter);
    const stillOneWorker = db
      .prepare(`SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL`)
      .get(runId) as { n: number };
    assert.equal(stillOneWorker.n, 1, "a second call must not dispatch task-b while task-a's worker is still live");
  });
});

test("priority filtering never bypasses eligibility: a higher-priority ineligible task is skipped for a lower-priority eligible one", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    // task-a is highest priority but has an unmet dependency, so it is not eligible.
    insertTask(db, {
      id: "task-a",
      runId,
      stageId: "integration",
      priority: 0,
      dependsOn: ["missing-dependency"],
      now: clock.now(),
    });
    insertTask(db, { id: "task-b", runId, stageId: "integration", priority: 1, now: clock.now() });

    const adapter = new FakeAdapter({
      terminate: noopTerminate,
      streamsDir: fixturesStreamsDir,
      scenarioFor: () => "well-formed",
    });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter);

    assert.ok(runtime.liveAttemptByTaskId.has("task-b"), "the eligible, lower-priority task is dispatched instead");
  });
});

test("dispatchEligible: a mutating task with no claims rows is not dispatched when a workspace provider is present, and is dispatched once a claims row exists", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    const provider = defaultProvider(dir);
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);

    assert.equal(runtime.liveAttemptByTaskId.size, 0, "no claims row means claimSetComplete is false");
    const attemptsBefore = db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`).get(runId) as { n: number };
    assert.equal(attemptsBefore.n, 0, "no attempts row is created for an ineligible dispatch");

    seedFilesClaim(db, runId, "task-a", ["implementation-output.txt"]);
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);

    assert.ok(runtime.liveAttemptByTaskId.has("task-a"), "the task dispatches once its claims row exists");
    const attemptsAfter = db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`).get(runId) as { n: number };
    assert.equal(attemptsAfter.n, 1);
  });
});

test("dispatchEligible with no workspace provider: unchanged behavior — zero worktrees rows, process.cwd() as the working directory", async () => {
  await withRunDb(async ({ db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter);

    const attemptTaskA = runtime.liveAttemptByTaskId.get("task-a");
    assert.ok(attemptTaskA, "task-a dispatches");
    assert.equal(attemptTaskA!.workspace, null, "no workspace handle is held without a provider");
    assert.equal(attemptTaskA!.handle.worktree, process.cwd(), "the working directory is unchanged");

    const worktreeRows = db.prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ?`).get(runId) as { n: number };
    assert.equal(worktreeRows.n, 0, "no worktree is ever created without a provider");
  });
});

test("dispatchEligible with a workspace provider: a mutating dispatch runs inside a runner-owned worktree, and the operator checkout is left untouched", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["implementation-output.txt"]);
    const provider = defaultProvider(dir);
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const headBefore = runGit(dir, ["rev-parse", "HEAD"]);
    const statusBefore = runGit(dir, ["status", "--porcelain"]);

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);

    const attemptTaskA = runtime.liveAttemptByTaskId.get("task-a");
    assert.ok(attemptTaskA, "the task dispatches once its claims row exists");
    const workspace = attemptTaskA!.workspace;
    assert.ok(workspace, "a workspace handle is held for a provider-backed mutating dispatch");
    assert.ok(fs.existsSync(workspace!.path), "the worktree directory exists on disk");
    assert.equal(attemptTaskA!.handle.worktree, workspace!.path, "the attempt's working directory is the worktree path");

    // Let the fake worker process finish before inspecting the checkout again.
    await waitForExit(attemptTaskA!.handle.pid);

    const headAfter = runGit(dir, ["rev-parse", "HEAD"]);
    const statusAfter = runGit(dir, ["status", "--porcelain"]);
    assert.equal(headAfter, headBefore, "the operator checkout's HEAD is unchanged");
    assert.equal(statusAfter, statusBefore, "the operator checkout's working tree is unchanged");
  });
});

test("dispatchEligible with a workspace provider whose mode is \"in-place\": the integration stage runs the full in-place git-plumbing pipeline and lands a plain commit on the operator's checkout, with no worktree left behind", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock, baseCommit }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["implementation-output.txt"]);
    // Simulates the file the task's own `implementation` dispatch already
    // wrote to the operator's checkout, uncommitted: `in-place` mode's
    // `integration` stage lands this claim set through git plumbing
    // (`runIntegrationStages`), not through a raw dispatched attempt, so
    // there is no separate "attempt" here to write it.
    fs.writeFileSync(path.join(dir, "implementation-output.txt"), "implementer output\n", "utf8");

    const provider: WorkspaceProvider = {
      projectRoot: dir,
      root: DEFAULT_WORKTREE_ROOT,
      branchPrefix: DEFAULT_BRANCH_PREFIX,
      mode: "in-place",
    };

    // In-place mode's `integration` stage dispatches its sub-agent attempt
    // at `cross-task-review` (inside `runIntegrationStages`), working
    // against the manufactured review candidate rather than `dir` itself, so
    // this test supplies its own streams directory rather than the shared
    // `fixturesStreamsDir` (which carries no `cross-task-review` stream).
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-scheduler-inplace-review-"));
    fs.writeFileSync(
      path.join(streamsDir, "cross-task-review--well-formed.jsonl"),
      [
        JSON.stringify({ op: "output", text: "reviewing" }),
        JSON.stringify({
          op: "report",
          report: {
            protocolVersion: "1",
            workflowId: "integration",
            workflowVersion: "1.0.0",
            runId,
            taskId: "task-a",
            attemptId: "attempt-fixture",
            stageId: "cross-task-review",
            roleId: "code-quality-reviewer",
            status: "completed",
            verdict: "pass",
            summary: "looks good",
          },
        }),
        JSON.stringify({ op: "exit", code: 0 }),
      ].join("\n") + "\n",
    );

    try {
      const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir, scenarioFor: () => "well-formed" });

      const runtime = createSchedulerRuntime();
      await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);

      assert.equal(
        runtime.liveAttemptByTaskId.size,
        0,
        "the in-place integration pipeline runs to completion inside dispatchEligible; no live attempt handle is held",
      );
      const outcome = runtime.integrationOutcomeByTaskId.get("task-a");
      assert.ok(outcome, "an integration outcome is recorded for the task");
      assert.equal(outcome!.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);

      const taskWorktreeRow = db
        .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND path = ?`)
        .get(runId, dir) as { n: number };
      assert.equal(taskWorktreeRow.n, 0, "no worktrees row is ever inserted for the operator's own checkout");

      const pendingWorktrees = db
        .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND cleanup_state != 'cleaned'`)
        .get(runId) as { n: number };
      assert.equal(pendingWorktrees.n, 0, "the review candidate worktree is fully cleaned up");

      const worktreeList = runGit(dir, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
      assert.equal(worktreeList.length, 1, "only the operator's own checkout remains as a worktree");

      const headAfter = runGit(dir, ["rev-parse", "HEAD"]);
      assert.notEqual(headAfter, baseCommit, "the task's commit landed on the operator's checked-out branch");
      assert.equal(
        runGit(dir, ["show", "HEAD:implementation-output.txt"]),
        "implementer output",
        "the landed commit carries the claimed path's content",
      );
    } finally {
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
});

test("test-supervisor.ts driven with workspaceMode \"in-place\": a well-formed attempt on a task seeded at \"integration\" lands a plain commit on the operator's checkout and leaves no worktree behind", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    const runId = "run-1";
    const now = 1_000_000;
    const db = openStore(dir);
    try {
      insertRun(db, runId, now);
      insertTask(db, { id: "task-a", runId, stageId: "integration", now });
      seedFilesClaim(db, runId, "task-a", ["implementation-output.txt"]);
    } finally {
      db.close();
    }

    // Simulates the file the task's own `implementation` dispatch already
    // wrote to the operator's checkout, uncommitted.
    fs.writeFileSync(path.join(dir, "implementation-output.txt"), "implementer output\n", "utf8");

    // `runTestSupervisor`'s own `FakeAdapter` keys its scenario file by the
    // dispatched attempt's task id (`test-supervisor.ts`'s `scenarioFor`),
    // not by a fixed name. In-place mode's `integration` stage dispatches
    // its sub-agent attempt at `cross-task-review` (inside
    // `runIntegrationStages`), not at `integration` itself, so the stream
    // lives at `cross-task-review--task-a.jsonl` under a streams directory
    // scoped to this test rather than the shared `fixturesStreamsDir`.
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-scheduler-inplace-streams-"));
    fs.writeFileSync(
      path.join(streamsDir, "cross-task-review--task-a.jsonl"),
      [
        JSON.stringify({ op: "output", text: "reviewing" }),
        JSON.stringify({
          op: "report",
          report: {
            protocolVersion: "1",
            workflowId: "integration",
            workflowVersion: "1.0.0",
            runId: "run-1",
            taskId: "task-a",
            attemptId: "attempt-fixture",
            stageId: "cross-task-review",
            roleId: "code-quality-reviewer",
            status: "completed",
            verdict: "pass",
            summary: "looks good",
          },
        }),
        JSON.stringify({ op: "exit", code: 0 }),
      ].join("\n") + "\n",
    );

    try {
      const args = parseArgs([dir, runId, "50", "400", "150", streamsDir, "in-place"]);
      assert.equal(args.workspaceMode, "in-place");

      const exitCode = await runTestSupervisor(args);
      assert.equal(exitCode, 0);

      const verifyDb = openStore(dir);
      try {
        const run = verifyDb.prepare(`SELECT state, terminal_reason FROM runs WHERE id = ?`).get(runId) as {
          state: string;
          terminal_reason: string | null;
        };
        assert.equal(run.state, "succeeded", `expected succeeded; got ${JSON.stringify(run)}`);
        const pendingWorktrees = verifyDb
          .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND cleanup_state != 'cleaned'`)
          .get(runId) as { n: number };
        assert.equal(pendingWorktrees.n, 0, "the review candidate worktree is fully cleaned up");
        const taskWorktreeRow = verifyDb
          .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND path = ?`)
          .get(runId, dir) as { n: number };
        assert.equal(taskWorktreeRow.n, 0, "no worktrees row is ever inserted for the operator's own checkout");
      } finally {
        verifyDb.close();
      }

      const worktreeList = runGit(dir, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
      assert.equal(worktreeList.length, 1, "only the operator's own checkout remains as a worktree");
    } finally {
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
});

test("normalizeResults: a mutating attempt whose observed diff exceeds its claims is rejected without touching the worktree, and reconcileState still finds no invariant to flag", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["claimed.txt"]);
    const provider = defaultProvider(dir);
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);
    assert.ok(runtime.liveAttemptByTaskId.get("task-a"));
    const workspacePath = runtime.liveAttemptByTaskId.get("task-a")!.workspace!.path;

    // Simulate the worker writing an out-of-claim file into its worktree.
    fs.writeFileSync(path.join(workspacePath, "unclaimed.txt"), "surprise\n", "utf8");
    await waitForExit(runtime.liveAttemptByTaskId.get("task-a")!.handle.pid);

    const diffBefore = runGit(workspacePath, ["diff"]);
    const statusBefore = runGit(workspacePath, ["status", "--porcelain"]);

    reapWorkers(buildCtx(db, runId, clock), runtime);
    await normalizeResults(buildCtx(db, runId, clock), runtime, adapter);

    assert.equal(runtime.liveAttemptByTaskId.size, 0);

    const attempt = db.prepare(`SELECT status FROM attempts WHERE run_id = ? AND task_id = ?`).get(runId, "task-a") as {
      status: string;
    };
    assert.equal(attempt.status, "failed", "an out-of-claim attempt is marked failed regardless of the adapter's own verdict");

    const violationEvents = db
      .prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`)
      .all(runId) as Array<{ payload: string }>;
    assert.equal(violationEvents.length, 1);
    const payload = JSON.parse(violationEvents[0]!.payload) as { outOfClaim: string[] };
    assert.deepEqual(payload.outOfClaim, ["unclaimed.txt"]);

    const worktreeRow = db
      .prepare(`SELECT cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-a") as { cleanup_state: string };
    assert.equal(worktreeRow.cleanup_state, "active", "a rejection leaves the worktrees row active; no removeWorkspace call");

    assert.ok(fs.existsSync(path.join(workspacePath, "unclaimed.txt")), "the file the worker wrote is still present");
    const diffAfter = runGit(workspacePath, ["diff"]);
    const statusAfter = runGit(workspacePath, ["status", "--porcelain"]);
    assert.equal(diffAfter, diffBefore, "the worktree's working tree is byte-identical before and after the rejection");
    assert.equal(statusAfter, statusBefore);

    // advanceTransitions finds no outcome recorded for task-a (the violation
    // withheld it), so the task advances no board transition.
    advanceTransitions(buildCtx(db, runId, clock), runtime);
    const taskAfter = getTask(db, "task-a");
    assert.equal(taskAfter.stage_id, "integration", "the rejected task's stage is unchanged");

    const reconcileRuntime = createSchedulerRuntime();
    reconcileState(buildCtx(db, runId, clock), reconcileRuntime, provider);
    assert.equal(
      reconcileRuntime.scratch.invariantViolations.some((v) => v.includes("untracked worktree")),
      false,
      "an active worktrees row backing a live-tracked task is not reported as an untracked stray",
    );
  });
});

test("normalizeResults: a genuine git failure inside observedPaths still fails the attempt closed, but is recorded distinctly from an empty-violation rejection", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["claimed.txt"]);
    const provider = defaultProvider(dir);
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);
    assert.ok(runtime.liveAttemptByTaskId.get("task-a"));
    const workspacePath = runtime.liveAttemptByTaskId.get("task-a")!.workspace!.path;
    await waitForExit(runtime.liveAttemptByTaskId.get("task-a")!.handle.pid);

    // Delete the worktree directory itself (not through `git worktree
    // remove`, so git's own metadata is left dangling too) so that
    // observedPaths' `git diff`/`git ls-files` calls, run with this now-gone
    // path as their cwd, fail with a real, uncontrived error rather than a
    // mock.
    fs.rmSync(workspacePath, { recursive: true, force: true });

    reapWorkers(buildCtx(db, runId, clock), runtime);
    await normalizeResults(buildCtx(db, runId, clock), runtime, adapter);

    assert.equal(runtime.liveAttemptByTaskId.size, 0);

    const attempt = db.prepare(`SELECT status FROM attempts WHERE run_id = ? AND task_id = ?`).get(runId, "task-a") as {
      status: string;
    };
    assert.equal(attempt.status, "failed", "the attempt still fails closed on a genuine internal (git) failure");

    const worktreeRow = db
      .prepare(`SELECT cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-a") as { cleanup_state: string };
    assert.equal(worktreeRow.cleanup_state, "active", "a rejection leaves the worktrees row active here too");

    const violationEvents = db
      .prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`)
      .all(runId) as Array<{ payload: string }>;
    assert.equal(violationEvents.length, 1);
    const payload = JSON.parse(violationEvents[0]!.payload) as { outOfClaim: string[]; internalError?: string };
    assert.deepEqual(payload.outOfClaim, [], "the catch path reports no out-of-claim paths, same shape as before");
    assert.equal(typeof payload.internalError, "string", "the caught error's message is recorded");
    assert.ok(
      (payload.internalError as string).length > 0,
      "the internal-error field is non-empty, distinguishing this from a genuine empty-violation rejection",
    );
  });
});

test("a task whose out-of-claim rejection left an active worktrees row is not redispatched: worktreeMatchesRecordedBase blocks it on the next tick", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["claimed.txt"]);
    const provider = defaultProvider(dir);
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);
    const workspacePath = runtime.liveAttemptByTaskId.get("task-a")!.workspace!.path;
    fs.writeFileSync(path.join(workspacePath, "unclaimed.txt"), "surprise\n", "utf8");
    await waitForExit(runtime.liveAttemptByTaskId.get("task-a")!.handle.pid);

    reapWorkers(buildCtx(db, runId, clock), runtime);
    await normalizeResults(buildCtx(db, runId, clock), runtime, adapter);
    assert.equal(runtime.liveAttemptByTaskId.size, 0);

    const attemptsBefore = db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`).get(runId) as { n: number };
    assert.equal(attemptsBefore.n, 1);

    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter, provider);

    assert.equal(runtime.liveAttemptByTaskId.size, 0, "the leftover active worktrees row blocks redispatch");
    const attemptsAfter = db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ?`).get(runId) as { n: number };
    assert.equal(attemptsAfter.n, 1, "no second attempts row is created");
  });
});

test("reconcileState with a workspace provider: a worktree present on disk with no worktrees row surfaces as an invariant violation", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    const provider = defaultProvider(dir);
    const untrackedPath = path.resolve(dir, DEFAULT_WORKTREE_ROOT, runId, "orphan-task");
    runGit(dir, ["worktree", "add", untrackedPath, "-b", "orga/task/orphan-task", "HEAD"]);

    const runtime = createSchedulerRuntime();
    reconcileState(buildCtx(db, runId, clock), runtime, provider);

    assert.equal(runtime.scratch.invariantViolations.length, 1);
    assert.match(runtime.scratch.invariantViolations[0] as string, /untracked worktree/);
  });
});

test("a composed tick with a workspace provider and a seeded claims row does not rest blocked on stray-claims evidence", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "integration", now: clock.now() });
    seedFilesClaim(db, runId, "task-a", ["claimed.txt"]);
    const provider = defaultProvider(dir);
    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });

    const body = createSchedulerTick(adapter, DEFAULT_SCHEDULER_STEPS, provider);
    const outcome = await body(buildCtx(db, runId, clock));

    const restedBlockedOnClaims =
      outcome.kind === "resting" &&
      (outcome as { state: string }).state === "blocked" &&
      /claim row\(s\) exist/.test((outcome as { reason: string | null }).reason ?? "");
    assert.equal(
      restedBlockedOnClaims,
      false,
      `a claims row required by claimSetComplete must not itself be flagged as an invariant violation; got ${JSON.stringify(outcome)}`,
    );
  });
});

test("an orphaned worktree cleanup withholds a succeeded verdict", async () => {
  await withGitRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: null, disposition: "integrated", now: clock.now() });
    const provider = defaultProvider(dir);

    const handle = await createWorkspace({
      mode: "worktree",
      db,
      projectRoot: dir,
      runId,
      taskId: "task-a",
      taskKey: "task-a",
      ref: "HEAD",
      root: provider.root,
      branchPrefix: provider.branchPrefix,
    });

    // Force the branch-delete step of the coming cleanup to fail: free the
    // branch from its worktree, then check it out in the main repository so
    // `git branch -D` refuses to delete it, mirroring `workspace.test.ts`'s
    // own forced-failure setup.
    runGit(dir, ["worktree", "remove", "--force", handle.path]);
    runGit(dir, ["checkout", handle.branch]);

    const body = createSchedulerTick(noWorkAdapter(), DEFAULT_SCHEDULER_STEPS, provider);
    const outcome = await body(buildCtx(db, runId, clock));

    assert.equal(outcome.kind, "resting");
    assert.equal((outcome as { state: string }).state, "blocked", "an orphaned cleanup withholds succeeded");
    assert.match((outcome as { reason: string }).reason, /orphaned/);

    const row = db
      .prepare(`SELECT cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-a") as { cleanup_state: string };
    assert.equal(row.cleanup_state, "orphaned");
  });
});

test("both dispatch paths coexist in one run: an implementation task's development pipeline and an integration task's dispatchAttempt", async () => {
  await withRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "implementation", priority: 0, briefPath: path.join(dir, "brief.md"), now: clock.now() });
    insertTask(db, { id: "task-b", runId, stageId: "integration", priority: 1, now: clock.now() });
    fs.writeFileSync(path.join(dir, "brief.md"), "# Task A\n", "utf8");

    const streamsDir = path.join(dir, "dev-streams");
    writeDevStream(streamsDir, "implement", "completed", devImplementerReport("implement", "completed"));
    writeDevStream(streamsDir, "review-spec", "pass", devReviewerReport("review-spec", "spec-reviewer", "pass"));
    writeDevStream(
      streamsDir,
      "review-quality",
      "pass",
      devReviewerReport("review-quality", "code-quality-reviewer", "pass"),
    );
    writeDevStream(streamsDir, "integration", "well-formed", devImplementerReport("integration", "completed"));

    const adapter = new FakeAdapter({
      terminate: noopTerminate,
      streamsDir,
      scenarioFor: (attempt: AttemptDescriptor) => {
        if (attempt.stageId === "review-spec" || attempt.stageId === "review-quality") return "pass";
        if (attempt.stageId === "integration") return "well-formed";
        return "completed";
      },
    });

    const body = createSchedulerTick(adapter);

    await body(buildCtx(db, runId, clock));

    const devStageIds = db
      .prepare(`SELECT stage_id FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY rowid ASC`)
      .all(runId, "task-a") as Array<{ stage_id: string }>;
    assert.deepEqual(
      devStageIds.map((row) => row.stage_id),
      ["implement", "review-spec", "review-quality"],
      "task-a's whole development pipeline ran to completion inside the tick that dispatched it",
    );

    assert.equal(
      getTask(db, "task-a").stage_id,
      "implementation",
      "the recorded outcome is only consumed by the next tick's advanceTransitions",
    );

    const taskBAttemptsAfterTick1 = db
      .prepare(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-b") as { n: number };
    assert.equal(taskBAttemptsAfterTick1.n, 0, "single-lane: task-b is untouched while task-a occupies the tick");

    await body(buildCtx(db, runId, clock));

    assert.equal(
      getTask(db, "task-a").stage_id,
      "integration-candidate",
      "task-a's recorded development outcome advanced it off implementation",
    );

    const taskBAttempt = db
      .prepare(`SELECT stage_id, role FROM attempts WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-b") as { stage_id: string; role: string } | undefined;
    assert.ok(taskBAttempt, "task-b was dispatched through the untouched integration path");
    assert.equal(taskBAttempt?.stage_id, "integration");
    assert.equal(taskBAttempt?.role, "integrator");
  });
});

test("the scheduler dispatches an unrelated eligible task on the next tick after a task parks at a gate cap", async () => {
  await withRunDb(async ({ dir, db, runId, clock }) => {
    insertTask(db, { id: "task-a", runId, stageId: "implementation", priority: 0, briefPath: path.join(dir, "brief.md"), now: clock.now() });
    insertTask(db, { id: "task-b", runId, stageId: "integration", priority: 1, now: clock.now() });
    fs.writeFileSync(path.join(dir, "brief.md"), "# Task A\n", "utf8");

    const streamsDir = path.join(dir, "dev-streams");
    writeDevStream(streamsDir, "implement", "completed", devImplementerReport("implement", "completed"));
    writeDevStream(streamsDir, "fix-spec", "completed", devImplementerReport("fix-spec", "completed"));
    writeDevStream(streamsDir, "review-spec", "fail", devReviewerReport("review-spec", "spec-reviewer", "fail"));
    writeDevStream(streamsDir, "integration", "well-formed", devImplementerReport("integration", "completed"));

    const adapter = new FakeAdapter({
      terminate: noopTerminate,
      streamsDir,
      scenarioFor: (attempt: AttemptDescriptor) => {
        if (attempt.stageId === "review-spec") return "fail";
        if (attempt.stageId === "integration") return "well-formed";
        return "completed";
      },
    });

    const body = createSchedulerTick(adapter);

    await body(buildCtx(db, runId, clock));

    const gateRows = db
      .prepare(
        `SELECT round, verdict, cap FROM gates WHERE run_id = ? AND task_id = ? AND gate_type = ? ORDER BY round ASC`,
      )
      .all(runId, "task-a", "specReviewGate") as Array<{ round: number; verdict: string | null; cap: number }>;
    assert.equal(gateRows.length, 3, "all three specReviewGate rounds are durably recorded");
    assert.ok(
      gateRows.every((row) => row.verdict === "fail" && row.cap === 3),
      "every recorded round resolved as the gate's failing edge, capped at 3",
    );

    assert.equal(
      getTask(db, "task-a").stage_id,
      "implementation",
      "the capped outcome is only consumed by the next tick's advanceTransitions",
    );
    const taskBAttemptsAfterTick1 = db
      .prepare(`SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-b") as { n: number };
    assert.equal(taskBAttemptsAfterTick1.n, 0, "single-lane: task-b is untouched while task-a occupies the tick");

    await body(buildCtx(db, runId, clock));

    const taskBAttempt = db
      .prepare(`SELECT stage_id FROM attempts WHERE run_id = ? AND task_id = ?`)
      .get(runId, "task-b") as { stage_id: string } | undefined;
    assert.ok(taskBAttempt, "task-b, unrelated to task-a's capped gate, is dispatched once the lane frees up");
    assert.equal(taskBAttempt?.stage_id, "integration");
    assert.notEqual(getTask(db, "task-a").stage_id, "implementation", "task-a has moved off the stage it parked at");
  });
});
