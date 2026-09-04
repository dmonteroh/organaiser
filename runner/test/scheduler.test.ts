import assert from "node:assert/strict";
import test from "node:test";
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
} from "../src/engine/scheduler.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { ProcessAdapter } from "../src/adapters/adapter.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const fixturesStreamsDir = fileURLToPath(new URL("./fixtures/fake-streams/", import.meta.url));

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
    insertTask(db, { id: "task-a", runId, stageId: "implementation", now: clock.now() });

    const adapter = new FakeAdapter({ terminate: noopTerminate, streamsDir: fixturesStreamsDir, scenarioFor: () => "well-formed" });
    const body = createSchedulerTick(adapter);
    const outcome = await body(buildCtx(db, runId, clock));

    assert.notEqual(outcome.kind === "resting" && (outcome as { state: string }).state, "succeeded");
    assert.ok(outcome.kind === "progress" || outcome.kind === "active");
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
    insertTask(db, { id: "task-a", runId, stageId: "implementation", priority: 0, now: clock.now() });
    insertTask(db, { id: "task-b", runId, stageId: "implementation", priority: 1, now: clock.now() });

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
    assert.ok(runtime.liveAttempt, "runtime should be tracking exactly the one live attempt");
    assert.equal(runtime.liveAttempt?.taskId, "task-a", "priority order dispatches task-a first");

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
      stageId: "implementation",
      priority: 0,
      dependsOn: ["missing-dependency"],
      now: clock.now(),
    });
    insertTask(db, { id: "task-b", runId, stageId: "implementation", priority: 1, now: clock.now() });

    const adapter = new FakeAdapter({
      terminate: noopTerminate,
      streamsDir: fixturesStreamsDir,
      scenarioFor: () => "well-formed",
    });

    const runtime = createSchedulerRuntime();
    await dispatchEligible(buildCtx(db, runId, clock), runtime, adapter);

    assert.equal(runtime.liveAttempt?.taskId, "task-b", "the eligible, lower-priority task is dispatched instead");
  });
});
