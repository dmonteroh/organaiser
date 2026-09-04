// The fixed-point scheduler loop body (goals spec section 11) as a `TickBody`
// plugging into P5b's tick seam (`tick.ts`). This module owns nothing that
// seam already owns: no lease renewal, no `control`-row handling, no resting
// exit decision beyond returning the `TickOutcome` the shell asked for.
//
// The loop body runs six named, separately callable steps in goals spec
// section 11's order (lease renewal is the shell's own first step and does
// not appear here): `reapWorkers`, `normalizeResults`, `advanceTransitions`,
// `executeGates`, `reconcileState`, `dispatchEligible`. Every step
// re-evaluates the whole board, never only the task an event touched.
//
// `task-board.v1.yaml`'s stage graph is mirrored here as `STAGE_DEFINITIONS`,
// a plain data table rather than a parsed re-read of the manifest at runtime:
// this package carries no YAML parser. `STAGE_DEFINITIONS` is exported so a
// test can assert its per-stage transitions map is identical, id-for-id and
// target-for-target, to the manifest's own parsed transitions.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AttemptOutcome, ProcessAdapter, ProcessHandle } from "../adapters/adapter.ts";
import { FakeAdapter } from "../adapters/fake.ts";
import {
  claimSetComplete,
  computeInputVersion,
  dispatchAttempt,
  isDispatchEligible,
  nextAttemptRound,
  permissiveOutOfScopeConditions,
  worktreeMatchesRecordedBase,
  type DispatchConditions,
} from "./dispatch.ts";
import { getPredicate } from "./predicate-registry.ts";
import { PREDICATE_RETURN_UNIONS, TERMINAL_DISPOSITION_VALUES } from "./board-predicates.ts";
import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { createWorkspace, removeWorkspace, listUntrackedWorktrees, type WorkspaceHandle } from "../git/workspace.ts";
import { observedPaths, validateClaims } from "../git/claims.ts";
import type { RestingRunState, TickBody, TickContext, TickOutcome } from "./tick.ts";
import type { TaskRow, TaskState } from "../store/types.ts";

export interface StageDefinition {
  id: string;
  predicateName: string;
  transitions: Readonly<Record<string, string>>;
}

export const STAGE_DEFINITIONS: readonly StageDefinition[] = [
  {
    id: "admit-task",
    predicateName: "entry-artifacts-valid",
    transitions: { true: "release-dependencies", false: "reconcile-outcome" },
  },
  {
    id: "release-dependencies",
    predicateName: "dependencies-satisfied",
    transitions: { true: "acquire-claims", false: "release-dependencies" },
  },
  {
    id: "acquire-claims",
    predicateName: "claims-available",
    transitions: { true: "admit-to-batch", false: "acquire-claims" },
  },
  {
    id: "admit-to-batch",
    predicateName: "batch-slot-available",
    transitions: { true: "product-specification", false: "admit-to-batch" },
  },
  {
    id: "product-specification",
    predicateName: "product-spec-outcome",
    transitions: {
      skipped: "task-refinement",
      specified: "task-refinement",
      shelved: "reconcile-outcome",
      "needs-research": "reconcile-outcome",
      "needs-decision": "reconcile-outcome",
      "needs-operator": "reconcile-outcome",
    },
  },
  {
    id: "task-refinement",
    predicateName: "refinement-outcome",
    transitions: {
      skipped: "implementation",
      "ready-to-implement": "implementation",
      superseded: "reconcile-outcome",
      parked: "reconcile-outcome",
    },
  },
  {
    id: "implementation",
    predicateName: "implementation-outcome",
    transitions: {
      integrating: "integration-candidate",
      "waiting-operator": "reconcile-outcome",
      parked: "reconcile-outcome",
    },
  },
  {
    id: "integration-candidate",
    predicateName: "integration-slot-available",
    transitions: { true: "integration", false: "integration-candidate" },
  },
  {
    id: "integration",
    predicateName: "integration-outcome",
    transitions: {
      integrated: "reconcile-outcome",
      "ready-to-implement": "implementation",
      "waiting-operator": "reconcile-outcome",
      parked: "reconcile-outcome",
    },
  },
  {
    id: "reconcile-outcome",
    predicateName: "terminal-disposition",
    transitions: {
      integrated: "integrated",
      superseded: "superseded",
      shelved: "shelved",
      cancelled: "cancelled",
      parked: "parked",
      "waiting-operator": "waiting-operator",
    },
  },
];

const ENTRY_STAGE_ID = "admit-task";
const STAGE_DEFINITIONS_BY_ID = new Map(STAGE_DEFINITIONS.map((stage) => [stage.id, stage]));
const STAGE_IDS = new Set(STAGE_DEFINITIONS.map((stage) => stage.id));
const DISPATCHABLE_STAGE_IDS = new Set(["implementation", "integration"]);
const LEGAL_TERMINAL_DISPOSITIONS = new Set<string>(TERMINAL_DISPOSITION_VALUES);

// A representative store-level `TaskState` for each board stage, so
// `tasks.state` (the broader target-architecture vocabulary) stays roughly in
// sync with `tasks.stage_id` (this manifest's own stage vocabulary) as a task
// advances. Terminal transitions from `reconcile-outcome` bypass this table:
// their target is already a valid `TaskState` value in its own right.
const STAGE_TASK_STATE: Readonly<Record<string, TaskState>> = {
  "admit-task": "defined",
  "release-dependencies": "defined",
  "acquire-claims": "defined",
  "admit-to-batch": "defined",
  "product-specification": "specifying",
  "task-refinement": "refining",
  implementation: "implementing",
  "integration-candidate": "ready-to-integrate",
  integration: "integrating",
};

interface LiveAttempt {
  attemptId: string;
  taskId: string;
  stageId: string;
  handle: ProcessHandle;
  workspace: WorkspaceHandle | null;
}

// The workspace root, worktrees root, and branch prefix a caller sources
// from `ResolvedConfig.workspace` (plus the project root) to give
// `createSchedulerTick` a real Git workspace to dispatch mutating attempts
// into. Absent, `dispatchEligible` creates no worktree and runs no claim
// validation, so the current in-place behavior is preserved exactly.
export interface WorkspaceProvider {
  projectRoot: string;
  root: string;
  branchPrefix: string;
}

interface TickScratch {
  transitionedThisTick: boolean;
  dispatchedThisTick: boolean;
  invariantViolations: string[];
  outcomeByTaskId: Map<string, AttemptOutcome>;
  reapedAttempt?: LiveAttempt;
}

function freshScratch(): TickScratch {
  return {
    transitionedThisTick: false,
    dispatchedThisTick: false,
    invariantViolations: [],
    outcomeByTaskId: new Map(),
  };
}

export interface SchedulerRuntime {
  liveAttempt: LiveAttempt | null;
  priorOutcomeByTaskId: Map<string, string>;
  scratch: TickScratch;
}

export function createSchedulerRuntime(): SchedulerRuntime {
  return { liveAttempt: null, priorOutcomeByTaskId: new Map(), scratch: freshScratch() };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function listActiveTasks(db: DatabaseSync, runId: string): TaskRow[] {
  return db
    .prepare(`SELECT * FROM tasks WHERE run_id = ? AND disposition IS NULL ORDER BY priority ASC, created_at ASC`)
    .all(runId) as unknown as TaskRow[];
}

function parseDependsOn(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function dependencyDispositionsFor(db: DatabaseSync, task: TaskRow): string[] {
  const dependencyIds = parseDependsOn(task.depends_on);
  return dependencyIds.map((depId) => {
    const row = db.prepare(`SELECT disposition FROM tasks WHERE id = ?`).get(depId) as
      | { disposition: string | null }
      | undefined;
    return row?.disposition ?? "";
  });
}

function hasOpenBlockingQuestion(db: DatabaseSync, task: TaskRow): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions WHERE run_id = ? AND task_id = ? AND status = 'open'`)
    .get(task.run_id, task.id) as { n: number };
  return row.n > 0;
}

// `brief_path` presence is checked at the row level only: `TickContext`
// carries no filesystem root, so on-disk artifact existence and schema
// validation are not evaluated here.
function briefArtifactDeclared(task: TaskRow): boolean {
  return typeof task.brief_path === "string" && task.brief_path.length > 0;
}

// Step 1 of goals spec section 11: reap the run's single P5-serial live
// worker once its process has exited. Liveness is polled directly by pid and
// process group rather than through `adapter.collect`, which blocks until
// the process has already finished; polling keeps this step cheap on every
// tick where the worker is still running.
export function reapWorkers(ctx: TickContext, runtime: SchedulerRuntime): void {
  const live = runtime.liveAttempt;
  if (live === null) return;
  if (pidAlive(live.handle.pid) || groupAlive(live.handle.pgid)) return;

  const nowMs = ctx.now();
  withTransaction(ctx.db, () => {
    ctx.db
      .prepare(`UPDATE workers SET termination_state = 'exited', ended_at = ? WHERE attempt_id = ?`)
      .run(nowMs, live.attemptId);
  });
  runtime.scratch.reapedAttempt = live;
  runtime.liveAttempt = null;
}

// Reads the task's single `dimension = 'files'` claims row and parses its
// JSON array of repository-relative paths. A missing row, a non-array parse
// result, or a parse throw all yield an empty claim set rather than
// propagating: a malformed claim rejects the attempt at `validateClaims`
// instead of killing the detached supervisor.
function readClaimedPaths(db: DatabaseSync, runId: string, taskId: string): string[] {
  const row = db
    .prepare(`SELECT value FROM claims WHERE run_id = ? AND task_id = ? AND dimension = 'files'`)
    .get(runId, taskId) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

interface ClaimValidationOutcome {
  outOfClaim: string[];
}

// Validates a mutating attempt's workspace against its declared claims.
// Every failure here — a Git call inside `observedPaths`, a malformed claim
// row — converts to a rejection rather than propagating, since an uncaught
// throw in this path kills the detached supervisor.
async function validateAttemptClaims(
  db: DatabaseSync,
  runId: string,
  taskId: string,
  workspace: WorkspaceHandle,
): Promise<ClaimValidationOutcome | null> {
  try {
    const observed = await observedPaths(workspace);
    const claimed = readClaimedPaths(db, runId, taskId);
    const result = validateClaims({ observed, claimed, recordedDirt: workspace.recordedDirt });
    return result.ok ? null : { outOfClaim: result.outOfClaim };
  } catch {
    return { outOfClaim: [] };
  }
}

// Step 2: normalize the reaped worker's artifacts into an `AttemptOutcome`
// via the adapter's own `collect`/`classify`, and persist the attempt's
// terminal status. The outcome is kept in this tick's scratch space for
// `advanceTransitions`, called immediately afterward in the same tick.
//
// When the attempt dispatched into a workspace, its observed diff is
// validated against the task's claims before the outcome is recorded. A
// claim violation marks the attempt failed with the offending paths as
// structured evidence and leaves the task's outcome unset for this tick, so
// `advanceTransitions` finds no facts for it and advances no transition; the
// worktrees row is left `active` (no `removeWorkspace` call), which is what
// makes `worktreeMatchesRecordedBase` block the task's redispatch next tick.
export async function normalizeResults(
  ctx: TickContext,
  runtime: SchedulerRuntime,
  adapter: ProcessAdapter,
): Promise<void> {
  const reaped = runtime.scratch.reapedAttempt;
  if (!reaped) return;

  const artifacts = await adapter.collect(reaped.handle);
  const outcome = await adapter.classify(artifacts);
  const nowMs = ctx.now();

  const claimViolation = reaped.workspace
    ? await validateAttemptClaims(ctx.db, ctx.runId, reaped.taskId, reaped.workspace)
    : null;

  withTransaction(ctx.db, () => {
    ctx.db
      .prepare(`UPDATE attempts SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?`)
      .run(claimViolation ? "failed" : outcome.ok ? "completed" : "failed", artifacts.exitCode, nowMs, reaped.attemptId);
    appendEvent(ctx.db, {
      id: randomUUID(),
      run_id: ctx.runId,
      task_id: reaped.taskId,
      attempt_id: reaped.attemptId,
      type: "attempt.normalized",
      payload: JSON.stringify({ ok: outcome.ok, failureClass: outcome.failureClass, reason: outcome.reason }),
      created_at: nowMs,
    });
    if (claimViolation) {
      appendEvent(ctx.db, {
        id: randomUUID(),
        run_id: ctx.runId,
        task_id: reaped.taskId,
        attempt_id: reaped.attemptId,
        type: "attempt.claim-violation",
        payload: JSON.stringify({ outOfClaim: claimViolation.outOfClaim }),
        created_at: nowMs,
      });
    }
  });

  if (!claimViolation) {
    runtime.scratch.outcomeByTaskId.set(reaped.taskId, outcome);
  }
  delete runtime.scratch.reapedAttempt;
}

function gatherFacts(
  db: DatabaseSync,
  runtime: SchedulerRuntime,
  task: TaskRow,
  predicateName: string,
): Record<string, unknown> | null {
  switch (predicateName) {
    case "entry-artifacts-valid":
      return { briefArtifactExists: briefArtifactDeclared(task), briefArtifactSchemaValid: true };
    case "dependencies-satisfied":
      return { dependencyDispositions: dependencyDispositionsFor(db, task) };
    case "claims-available":
      return {};
    case "batch-slot-available": {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
             WHERE run_id = ? AND disposition IS NULL
               AND stage_id NOT IN ('admit-task', 'release-dependencies', 'acquire-claims', 'admit-to-batch')`,
        )
        .get(task.run_id) as { n: number };
      return { activeBatchCount: row.n, batchCapacity: null };
    }
    case "product-spec-outcome":
      // No product-specification sub-workflow dispatch exists yet in P5: a
      // task always receives the manifest's own "does not require
      // specification" verdict and advances immediately.
      return { decision: "skipped" };
    case "refinement-outcome":
      // Same as above, for task-refinement.
      return { decision: "skipped" };
    case "implementation-outcome":
    case "integration-outcome": {
      const outcome = runtime.scratch.outcomeByTaskId.get(task.id);
      if (!outcome) return null;
      if (predicateName === "implementation-outcome") {
        return { attemptOk: outcome.ok, hasBlockingOperatorQuestion: false };
      }
      return { attemptOk: outcome.ok, hasIntegrationRejection: false, hasBlockingOperatorQuestion: false };
    }
    case "integration-slot-available":
      return {};
    case "terminal-disposition": {
      const priorOutcome = runtime.priorOutcomeByTaskId.get(task.id) ?? "";
      runtime.priorOutcomeByTaskId.delete(task.id);
      return { cancellationRequested: false, priorOutcome };
    }
    default:
      return null;
  }
}

function applyTransition(
  ctx: TickContext,
  runtime: SchedulerRuntime,
  task: TaskRow,
  fromStageId: string,
  result: string,
  target: string,
): void {
  const nowMs = ctx.now();

  if (target === fromStageId) {
    // Self-loop: the task keeps waiting at this stage. No state change.
    return;
  }

  if (!STAGE_IDS.has(target) && !LEGAL_TERMINAL_DISPOSITIONS.has(target)) {
    runtime.scratch.invariantViolations.push(
      `stage ${fromStageId} transition result ${JSON.stringify(result)} targets ${JSON.stringify(target)}, which is neither a known stage id nor a legal terminal disposition for task ${task.id}`,
    );
    return;
  }

  withTransaction(ctx.db, () => {
    if (STAGE_IDS.has(target)) {
      ctx.db
        .prepare(`UPDATE tasks SET stage_id = ?, state = ?, updated_at = ? WHERE id = ?`)
        .run(target, STAGE_TASK_STATE[target] ?? task.state, nowMs, task.id);
      if (target === "reconcile-outcome") {
        runtime.priorOutcomeByTaskId.set(task.id, result);
      }
    } else {
      // A terminal name from `reconcile-outcome`, not a further stage.
      ctx.db
        .prepare(`UPDATE tasks SET stage_id = NULL, state = ?, disposition = ?, updated_at = ? WHERE id = ?`)
        .run(target, target, nowMs, task.id);
    }
    appendEvent(ctx.db, {
      id: randomUUID(),
      run_id: ctx.runId,
      task_id: task.id,
      type: "task.transitioned",
      payload: JSON.stringify({ fromStageId, result, target }),
      created_at: nowMs,
    });
  });

  runtime.scratch.transitionedThisTick = true;
}

// Step 3: evaluate the whole board's stage predicates and advance every
// mechanically decidable transition. Every non-terminal task is visited on
// every call, never only a task an event named.
export function advanceTransitions(ctx: TickContext, runtime: SchedulerRuntime): void {
  const tasks = listActiveTasks(ctx.db, ctx.runId);

  for (const task of tasks) {
    const stageId = task.stage_id ?? ENTRY_STAGE_ID;
    const stage = STAGE_DEFINITIONS_BY_ID.get(stageId);
    if (!stage) {
      runtime.scratch.invariantViolations.push(
        `task ${task.id} sits at unknown stage_id ${JSON.stringify(stageId)}`,
      );
      continue;
    }

    const facts = gatherFacts(ctx.db, runtime, task, stage.predicateName);
    if (facts === null) continue;

    let result: string;
    try {
      result = getPredicate(stage.predicateName)(facts);
    } catch (err) {
      runtime.scratch.invariantViolations.push(
        `predicate ${stage.predicateName} threw for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const allowedUnion = PREDICATE_RETURN_UNIONS[stage.predicateName] ?? [];
    if (!allowedUnion.includes(result)) {
      runtime.scratch.invariantViolations.push(
        `predicate ${stage.predicateName} returned ${JSON.stringify(result)} outside its declared union for task ${task.id}`,
      );
      continue;
    }

    const target = stage.transitions[result];
    if (target === undefined) {
      runtime.scratch.invariantViolations.push(
        `stage ${stageId} has no transition declared for predicate result ${JSON.stringify(result)} (task ${task.id})`,
      );
      continue;
    }

    applyTransition(ctx, runtime, task, stageId, result, target);
  }
}

// Step 4: execute verification and integration gates. In P5, gate execution
// is folded into the dispatched attempt's own `classify` result (per
// `task-board-workflow.md`'s `implementation`/`integration` stage notes), so
// this step's own responsibility is limited to confirming no `gates` row is
// left pending; nothing in P5 ever inserts one. A pending gate is recorded as
// invariant evidence rather than thrown, so the tick still returns a
// `blocked` outcome instead of killing the detached supervisor process.
export function executeGates(ctx: TickContext, runtime: SchedulerRuntime): void {
  const row = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM gates WHERE run_id = ? AND verdict IS NULL`)
    .get(ctx.runId) as { n: number };
  if (row.n > 0) {
    runtime.scratch.invariantViolations.push(`${row.n} pending gate(s) exist but P5 dispatches none`);
  }
}

// Step 5: reconcile dependencies, claims, questions, and worktrees.
// Dependency re-evaluation already happens every tick inside
// `advanceTransitions` (the whole board is re-walked, including tasks
// waiting at `release-dependencies`), so this step's own job is to confirm
// no stray, unreconciled row exists: an `active` worktrees row is now
// legitimate (a dispatched attempt owns it), but a worktree present on disk
// with no row at all is the state a crash between `git worktree add` and the
// row-write transaction leaves behind.
export function reconcileState(ctx: TickContext, runtime: SchedulerRuntime, workspace?: WorkspaceProvider): void {
  const claims = ctx.db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE run_id = ?`).get(ctx.runId) as {
    n: number;
  };
  if (claims.n > 0) {
    runtime.scratch.invariantViolations.push(`${claims.n} claim row(s) exist but P5 acquires none`);
  }

  if (!workspace) return;
  const untracked = listUntrackedWorktrees({ db: ctx.db, runId: ctx.runId, projectRoot: workspace.projectRoot });
  if (untracked.length > 0) {
    runtime.scratch.invariantViolations.push(
      `${untracked.length} untracked worktree(s) on disk with no worktrees row: ${untracked.join(", ")}`,
    );
  }
}

function dispatchDependenciesSatisfied(db: DatabaseSync, task: TaskRow): boolean {
  const dispositions = dependencyDispositionsFor(db, task);
  return dispositions.every((disposition) =>
    disposition === "integrated" || disposition === "superseded" || disposition === "shelved",
  );
}

// Step 6: dispatch the highest-priority eligible task. P5 is single-lane
// serial: `workerSlotAvailable` is false whenever a live attempt already
// exists, so at most one dispatch happens per tick and at most one attempt is
// ever live for the run.
//
// With no workspace provider, dispatch runs exactly as it always has: no
// worktree, no claim requirement, `process.cwd()` as the working directory.
// With one, a mutating dispatch is guarded by `claimSetComplete` and
// `worktreeMatchesRecordedBase` and, once past those, runs inside a
// runner-owned worktree created by `createWorkspace`; the resulting handle
// is held on `runtime.liveAttempt.workspace` for the reap-time claim check.
export async function dispatchEligible(
  ctx: TickContext,
  runtime: SchedulerRuntime,
  adapter: ProcessAdapter,
  workspace?: WorkspaceProvider,
): Promise<void> {
  if (runtime.liveAttempt !== null) return;

  const candidates = listActiveTasks(ctx.db, ctx.runId).filter((task) =>
    task.stage_id !== null && DISPATCHABLE_STAGE_IDS.has(task.stage_id),
  );

  for (const task of candidates) {
    const mutating = true;
    const conditions: DispatchConditions = {
      dependenciesSatisfied: dispatchDependenciesSatisfied(ctx.db, task),
      noUnresolvedBlockingQuestion: !hasOpenBlockingQuestion(ctx.db, task),
      stageInputArtifactsValid: briefArtifactDeclared(task),
      workerSlotAvailable: runtime.liveAttempt === null,
      claimSetComplete: claimSetComplete(ctx.db, {
        runId: ctx.runId,
        taskId: task.id,
        mutating,
        workspaceProviderPresent: workspace !== undefined,
      }),
      // `runtime.liveAttempt` is guaranteed null here (checked at this
      // function's entry, and this single-lane loop dispatches at most one
      // attempt before returning), so the held handle for any candidate task
      // is always none under this child's serial scheduling; the
      // matching-handle true branch is exercised by
      // `worktreeMatchesRecordedBase`'s own unit test instead.
      worktreeMatchesRecordedBase: worktreeMatchesRecordedBase(ctx.db, {
        runId: ctx.runId,
        taskId: task.id,
        heldBaseCommit: null,
      }),
      ...permissiveOutOfScopeConditions(),
    };

    if (!isDispatchEligible(conditions)) continue;

    const stageId = task.stage_id as string;
    const role = stageId === "implementation" ? "implementer" : "integrator";
    const round = nextAttemptRound(ctx.db, ctx.runId, task.id, stageId);
    const inputVersion = computeInputVersion({ taskId: task.id, stageId, updatedAt: String(task.updated_at) });

    let workingDirectory = process.cwd();
    let workspaceHandle: WorkspaceHandle | null = null;
    if (mutating && workspace) {
      try {
        workspaceHandle = await createWorkspace({
          mode: "worktree",
          ref: "HEAD",
          db: ctx.db,
          projectRoot: workspace.projectRoot,
          runId: ctx.runId,
          taskId: task.id,
          taskKey: task.task_key,
          root: workspace.root,
          branchPrefix: workspace.branchPrefix,
        });
      } catch (err) {
        runtime.scratch.invariantViolations.push(
          `workspace creation failed for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      workingDirectory = workspaceHandle.path;
    }

    const outcome = await dispatchAttempt(
      ctx.db,
      adapter,
      {
        runId: ctx.runId,
        taskId: task.id,
        stageId,
        role,
        round,
        inputVersion,
        vendor: "fake",
        model: "fake",
        configJson: "{}",
        mutating,
        timeoutBudget: { spawnMs: 30000, idleMs: 30000, wallMs: 300000 },
        workingDirectory,
        environment: process.env,
        packet: `packet for task ${task.id} at stage ${stageId}`,
      },
      ctx.now,
    );

    if (outcome.dispatched) {
      runtime.liveAttempt = {
        attemptId: outcome.attemptId,
        taskId: task.id,
        stageId,
        handle: outcome.handle,
        workspace: workspaceHandle,
      };
      runtime.scratch.dispatchedThisTick = true;
    }
    // Serial: stop after the first attempted dispatch regardless of outcome,
    // since either a worker is now live or the round was already claimed.
    return;
  }
}

interface BoardSummary {
  totalTaskCount: number;
  acceptableTerminalCount: number;
  waitingOperatorCount: number;
  parkedCount: number;
  liveWorkerCount: number;
  invariantViolations: readonly string[];
  transitionedOrDispatchedThisTick: boolean;
}

const ACCEPTABLE_TERMINAL_DISPOSITIONS = new Set(["integrated", "superseded", "shelved", "cancelled"]);

function gatherBoardSummary(ctx: TickContext, runtime: SchedulerRuntime): BoardSummary {
  const tasks = ctx.db.prepare(`SELECT disposition FROM tasks WHERE run_id = ?`).all(ctx.runId) as unknown as Array<{
    disposition: string | null;
  }>;

  let acceptableTerminalCount = 0;
  let waitingOperatorCount = 0;
  let parkedCount = 0;
  for (const row of tasks) {
    if (row.disposition === null) continue;
    if (ACCEPTABLE_TERMINAL_DISPOSITIONS.has(row.disposition)) acceptableTerminalCount += 1;
    else if (row.disposition === "waiting-operator") waitingOperatorCount += 1;
    else if (row.disposition === "parked") parkedCount += 1;
  }

  const liveWorkerRow = ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL`)
    .get(ctx.runId) as { n: number };

  return {
    totalTaskCount: tasks.length,
    acceptableTerminalCount,
    waitingOperatorCount,
    parkedCount,
    liveWorkerCount: liveWorkerRow.n,
    invariantViolations: runtime.scratch.invariantViolations,
    transitionedOrDispatchedThisTick: runtime.scratch.transitionedThisTick || runtime.scratch.dispatchedThisTick,
  };
}

// Cleans runner-owned worktrees before a `succeeded` verdict, by calling
// `removeWorkspace` for each `active` row. With no workspace provider, no
// worktree could have been created, so this always iterates zero rows. A
// `WorkspaceHandle` is reconstructed from the row's own columns:
// `removeWorkspace` only reads `path` and `branch` off it, never `baseCommit`
// or `recordedDirt`, so the reconstruction is exact for what it uses.
async function cleanRunnerOwnedWorktrees(ctx: TickContext, workspace?: WorkspaceProvider): Promise<void> {
  if (!workspace) return;
  const rows = ctx.db
    .prepare(`SELECT path, branch, base_commit FROM worktrees WHERE run_id = ? AND cleanup_state = 'active'`)
    .all(ctx.runId) as unknown as Array<{ path: string; branch: string; base_commit: string }>;
  for (const row of rows) {
    const handle: WorkspaceHandle = {
      mode: "worktree",
      root: workspace.root,
      path: row.path,
      branch: row.branch,
      baseCommit: row.base_commit,
      recordedDirt: [],
    };
    await removeWorkspace(handle, { db: ctx.db, projectRoot: workspace.projectRoot, runId: ctx.runId });
  }
}

// The classifier is a pure function over already-gathered counts (goals spec
// section 11's tail), independently testable without a database.
export function classifyTick(summary: BoardSummary): TickOutcome {
  if (summary.invariantViolations.length > 0) {
    return { kind: "resting", state: "blocked", reason: summary.invariantViolations.join("; ") };
  }

  if (summary.liveWorkerCount > 0) {
    return { kind: "active" };
  }

  if (summary.transitionedOrDispatchedThisTick) {
    return { kind: "progress" };
  }

  if (summary.totalTaskCount > 0 && summary.acceptableTerminalCount === summary.totalTaskCount) {
    return { kind: "resting", state: "succeeded" as RestingRunState, reason: null };
  }
  if (summary.totalTaskCount === 0) {
    return { kind: "resting", state: "succeeded" as RestingRunState, reason: null };
  }

  const remaining = summary.totalTaskCount - summary.acceptableTerminalCount;
  if (summary.parkedCount === 0 && summary.waitingOperatorCount === remaining) {
    return {
      kind: "resting",
      state: "waiting-operator" as RestingRunState,
      reason: `${summary.waitingOperatorCount} task(s) waiting on an operator answer`,
    };
  }

  return {
    kind: "resting",
    state: "blocked" as RestingRunState,
    reason: `${summary.parkedCount} parked, ${summary.waitingOperatorCount} waiting-operator, ${remaining} task(s) not at an acceptable terminal disposition with no automatic transition eligible`,
  };
}

export interface SchedulerSteps {
  reapWorkers: (ctx: TickContext, runtime: SchedulerRuntime) => void;
  normalizeResults: (ctx: TickContext, runtime: SchedulerRuntime, adapter: ProcessAdapter) => Promise<void>;
  advanceTransitions: (ctx: TickContext, runtime: SchedulerRuntime) => void;
  executeGates: (ctx: TickContext, runtime: SchedulerRuntime) => void;
  reconcileState: (ctx: TickContext, runtime: SchedulerRuntime, workspace?: WorkspaceProvider) => void;
  dispatchEligible: (
    ctx: TickContext,
    runtime: SchedulerRuntime,
    adapter: ProcessAdapter,
    workspace?: WorkspaceProvider,
  ) => Promise<void>;
}

export const DEFAULT_SCHEDULER_STEPS: SchedulerSteps = {
  reapWorkers,
  normalizeResults,
  advanceTransitions,
  executeGates,
  reconcileState,
  dispatchEligible,
};

// The workspace provider is the third, optional parameter: absent (the
// default, and the production binding below), every step runs exactly as it
// did before this wiring existed — no worktree, no claim requirement, no
// untracked-worktree scan. Present, it is threaded into `reconcileState` and
// `dispatchEligible` and into the end-of-tick worktree cleanup.
export function createSchedulerTick(
  adapter: ProcessAdapter,
  steps: SchedulerSteps = DEFAULT_SCHEDULER_STEPS,
  workspace?: WorkspaceProvider,
): TickBody {
  const runtime = createSchedulerRuntime();

  return async (ctx: TickContext): Promise<TickOutcome> => {
    runtime.scratch = freshScratch();

    steps.reapWorkers(ctx, runtime);
    await steps.normalizeResults(ctx, runtime, adapter);
    steps.advanceTransitions(ctx, runtime);
    steps.executeGates(ctx, runtime);
    steps.reconcileState(ctx, runtime, workspace);
    await steps.dispatchEligible(ctx, runtime, adapter, workspace);

    const summary = gatherBoardSummary(ctx, runtime);
    let outcome = classifyTick(summary);
    if (outcome.kind === "resting" && outcome.state === "succeeded") {
      await cleanRunnerOwnedWorktrees(ctx, workspace);
      const orphaned = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND cleanup_state = 'orphaned'`)
        .get(ctx.runId) as { n: number };
      if (orphaned.n > 0) {
        outcome = {
          kind: "resting",
          state: "blocked",
          reason: `${orphaned.n} worktree(s) failed cleanup and are orphaned`,
        };
      }
    }
    return outcome;
  };
}

async function terminateFakeAttempt(
  info: { pid: number; pgid: number },
  gracePeriodMs: number,
): Promise<{ signalSent: NodeJS.Signals | null; exitCode: number | null; killedProcessTree: boolean; timedOutWaitingForExit: boolean }> {
  try {
    process.kill(-info.pgid, "SIGTERM");
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && groupAlive(info.pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (groupAlive(info.pgid)) {
    try {
      process.kill(-info.pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return { signalSent: "SIGTERM", exitCode: null, killedProcessTree: !groupAlive(info.pgid), timedOutWaitingForExit: groupAlive(info.pgid) };
}

// Production binding: a `FakeAdapter` over P5c's committed fixture streams.
// Real vendor adapter selection is out of this module's scope.
export const schedulerTick: TickBody = createSchedulerTick(new FakeAdapter({ terminate: terminateFakeAttempt }));
