// The `dev-workflow` pipeline (`workflows/manifests/development.v1.yaml`) as
// an executable data table and a driver over it. This package carries no
// YAML parser, so `DEVELOPMENT_STAGES`, `DEVELOPMENT_CAPS`, and
// `DEVELOPMENT_TERMINAL_OUTCOMES` are a hand-written mirror of the manifest
// rather than a runtime parse of it, in the same shape as `scheduler.ts`'s
// own `STAGE_DEFINITIONS` mirror of `task-board.v1.yaml`.
//
// `runDevelopmentStages` walks the table from `implement` to one of the
// three terminal outcomes, running exactly one attempt per `kind: agent`
// stage (dispatch, poll for process exit, collect, classify) and evaluating
// exactly one predicate per `kind: runner` stage. It holds no durability,
// worktree, or finding-routing concerns of its own: those are later
// extensions of this same table.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AttemptOutcome, ProcessAdapter, ProcessHandle, TimeoutBudget } from "../adapters/adapter.ts";
import { groupAlive } from "../adapters/process-group.ts";
import {
  computeInputVersion,
  dispatchAttempt,
  nextAttemptRound,
  type DispatchAttemptInput,
} from "./dispatch.ts";
import { runVerificationBarrier, taskChecksPass, type BarrierResult } from "./barrier.ts";
import { observedPaths, validateClaims } from "../git/claims.ts";
import type { WorkspaceHandle } from "../git/workspace.ts";
import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";

export type DevelopmentStageKind = "agent" | "runner";
export type DevelopmentStageAuthority = "workspace-write" | "read-only";

export interface DevelopmentRetryPolicy {
  malformedResult: number;
  processFailure: number;
}

export interface DevelopmentStageDefinition {
  id: string;
  kind: DevelopmentStageKind;
  // Set for `kind: agent` stages, null for `kind: runner` stages.
  role: string | null;
  // Set for `kind: runner` stages, null for `kind: agent` stages.
  predicate: string | null;
  authority: DevelopmentStageAuthority | null;
  freshSession: boolean | null;
  // For `kind: agent` this is the manifest's own declared `verdicts` list.
  // For `kind: runner` the manifest declares no separate `verdicts` key; its
  // transitions' key set (always `"true"`/`"false"`) plays that role.
  verdicts: readonly string[];
  transitions: Readonly<Record<string, string>>;
  retry: DevelopmentRetryPolicy | null;
}

const IMPLEMENTER_VERDICTS = ["completed", "questions", "failed"] as const;
const IMPLEMENTER_TRANSITIONS = {
  completed: "collect-implementation-artifacts",
  questions: "waiting-operator",
  failed: "parked",
} as const;
const IMPLEMENTER_RETRY: DevelopmentRetryPolicy = { malformedResult: 1, processFailure: 1 };

export const DEVELOPMENT_STAGES: readonly DevelopmentStageDefinition[] = [
  {
    id: "implement",
    kind: "agent",
    role: "implementer",
    predicate: null,
    authority: "workspace-write",
    freshSession: true,
    verdicts: IMPLEMENTER_VERDICTS,
    transitions: IMPLEMENTER_TRANSITIONS,
    retry: IMPLEMENTER_RETRY,
  },
  {
    id: "collect-implementation-artifacts",
    kind: "runner",
    role: null,
    predicate: "implementation-artifacts-present",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "verify-task", false: "implement" },
    retry: null,
  },
  {
    id: "verify-task",
    kind: "runner",
    role: null,
    predicate: "task-checks-pass",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "review-spec", false: "implement" },
    retry: null,
  },
  {
    id: "review-spec",
    kind: "agent",
    role: "spec-reviewer",
    predicate: null,
    authority: "read-only",
    freshSession: true,
    verdicts: ["pass", "fail", "needs-info"],
    transitions: { pass: "review-quality", fail: "fix-spec", "needs-info": "waiting-operator" },
    retry: { malformedResult: 1, processFailure: 1 },
  },
  {
    id: "fix-spec",
    kind: "agent",
    role: "implementer",
    predicate: null,
    authority: "workspace-write",
    freshSession: true,
    verdicts: IMPLEMENTER_VERDICTS,
    transitions: IMPLEMENTER_TRANSITIONS,
    retry: IMPLEMENTER_RETRY,
  },
  {
    id: "review-quality",
    kind: "agent",
    role: "code-quality-reviewer",
    predicate: null,
    authority: "read-only",
    freshSession: true,
    verdicts: ["pass", "needs-info", "fail-with-severity: critical", "fail-with-severity: important"],
    transitions: {
      pass: "record-minors",
      "needs-info": "waiting-operator",
      "fail-with-severity: critical": "fix-quality",
      "fail-with-severity: important": "fix-quality",
    },
    retry: { malformedResult: 1, processFailure: 1 },
  },
  {
    id: "fix-quality",
    kind: "agent",
    role: "implementer",
    predicate: null,
    authority: "workspace-write",
    freshSession: true,
    verdicts: IMPLEMENTER_VERDICTS,
    transitions: IMPLEMENTER_TRANSITIONS,
    retry: IMPLEMENTER_RETRY,
  },
  {
    id: "record-minors",
    kind: "runner",
    role: null,
    predicate: "minor-findings-recorded",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "ready-to-integrate", false: "parked" },
    retry: null,
  },
  {
    id: "ready-to-integrate",
    kind: "runner",
    role: null,
    predicate: "handoff-recorded",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "integrating", false: "parked" },
    retry: null,
  },
];

export const DEVELOPMENT_ENTRY_STAGE = "implement";

export const DEVELOPMENT_CAPS: Readonly<Record<string, number>> = {
  specReviewGate: 3,
  qualityReviewGate: 3,
  questionsLoop: 3,
  artifactRepair: 3,
  taskChecksGate: 3,
};

export const DEVELOPMENT_TERMINAL_OUTCOMES: Readonly<{
  success: readonly string[];
  attention: readonly string[];
  neutral: readonly string[];
}> = {
  success: ["integrating"],
  attention: ["waiting-operator", "parked"],
  neutral: [],
};

const TERMINAL_OUTCOME_IDS = new Set<string>([
  ...DEVELOPMENT_TERMINAL_OUTCOMES.success,
  ...DEVELOPMENT_TERMINAL_OUTCOMES.attention,
  ...DEVELOPMENT_TERMINAL_OUTCOMES.neutral,
]);

const DEVELOPMENT_STAGES_BY_ID = new Map(DEVELOPMENT_STAGES.map((stage) => [stage.id, stage]));

export interface DevelopmentStageInput {
  // Store and process surface. Required.
  db: DatabaseSync;
  adapter: ProcessAdapter;
  runId: string;
  taskId: string;
  now: () => number;

  // Verification barrier surface, passed straight through to `BarrierInput`.
  // Required.
  taskDir: string;
  executionRoot: string;
  requiredArtifacts: readonly string[];
  checks: Record<string, unknown>;
  env: NodeJS.ProcessEnv;

  // Optional. Present enables claim validation on `authority: workspace-write`
  // stages and sets the dispatch working directory to `workspace.path`;
  // absent skips claim validation and dispatches at `executionRoot`.
  workspace?: WorkspaceHandle;

  // Optional injected `kind: runner` predicates. Each defaults to `() => "true"`.
  recordMinors?: () => "true" | "false";
  handoffRecorded?: () => "true" | "false";

  // Optional dispatch placeholders.
  vendor?: string;
  model?: string;
  configJson?: string;
  timeoutBudget?: TimeoutBudget;
  packet?: (stageId: string, role: string) => string;
}

const DEFAULT_TIMEOUT_BUDGET: TimeoutBudget = { spawnMs: 30000, idleMs: 30000, wallMs: 300000 };

export interface DevelopmentStageVisit {
  stageId: string;
  verdict: string;
}

export interface DevelopmentOutcome {
  outcome: "integrating" | "waiting-operator" | "parked";
  stages: readonly DevelopmentStageVisit[];
  gateRounds: Readonly<Record<string, number>>;
  // Set only when the terminal `parked` outcome was reached because a
  // stage's verdict fell outside its declared transitions; `stages`' last
  // entry already records `"schema-invalid"` for that stage, this carries
  // the raw verdict string that triggered it.
  schemaInvalid?: { stageId: string; verdict: string };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EXIT_POLL_INTERVAL_MS = 20;

async function waitForExit(handle: ProcessHandle): Promise<void> {
  while (pidAlive(handle.pid) || groupAlive(handle.pgid)) {
    await sleep(EXIT_POLL_INTERVAL_MS);
  }
}

// Reads the task's single `dimension = 'files'` claims row, mirroring
// `scheduler.ts`'s own private reader: a missing row or an unparseable value
// both yield an empty claim set rather than propagating.
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
  internalError?: string;
}

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
  } catch (err) {
    return { outOfClaim: [], internalError: err instanceof Error ? err.message : String(err) };
  }
}

interface LastAgentAttempt {
  attemptId: string;
  pgid: number;
}

interface DriverContext {
  input: DevelopmentStageInput;
  lastAgentAttempt: LastAgentAttempt | null;
  barrierCache: { attemptId: string; result: BarrierResult } | null;
}

function extractVerdict(stage: DevelopmentStageDefinition, outcome: AttemptOutcome): string {
  if (!outcome.ok || outcome.report === null) {
    return outcome.failureClass ?? "no-report";
  }
  const field = stage.role === "implementer" ? "status" : "verdict";
  const value = outcome.report[field];
  return typeof value === "string" ? value : "no-verdict";
}

async function runAgentStage(stage: DevelopmentStageDefinition, ctx: DriverContext): Promise<string> {
  const { input } = ctx;
  const round = nextAttemptRound(input.db, input.runId, input.taskId, stage.id);
  const inputVersion = computeInputVersion({ taskId: input.taskId, stageId: stage.id, round: String(round) });
  const mutating = stage.authority === "workspace-write";
  const workingDirectory = input.workspace?.path ?? input.executionRoot;
  const packetFn = input.packet ?? ((stageId: string) => `packet for task ${input.taskId} at stage ${stageId}`);

  const dispatchInput: DispatchAttemptInput = {
    runId: input.runId,
    taskId: input.taskId,
    stageId: stage.id,
    role: stage.role ?? "",
    round,
    inputVersion,
    vendor: input.vendor ?? "fake",
    model: input.model ?? "fake",
    configJson: input.configJson ?? "{}",
    mutating,
    timeoutBudget: input.timeoutBudget ?? DEFAULT_TIMEOUT_BUDGET,
    workingDirectory,
    environment: input.env,
    packet: packetFn(stage.id, stage.role ?? ""),
  };

  const dispatched = await dispatchAttempt(input.db, input.adapter, dispatchInput, input.now);
  if (!dispatched.dispatched) {
    throw new Error(
      `dispatch of stage ${stage.id} round ${round} collided with an already-recorded attempt`,
    );
  }
  const { attemptId, handle } = dispatched;

  await waitForExit(handle);

  const reapedAt = input.now();
  withTransaction(input.db, () => {
    input.db
      .prepare(`UPDATE workers SET termination_state = 'exited', ended_at = ? WHERE attempt_id = ?`)
      .run(reapedAt, attemptId);
  });

  // Invalidate the barrier cache from any prior attempt now that a new one
  // has been reaped; `collect-implementation-artifacts` repopulates it for
  // this attempt.
  ctx.barrierCache = null;
  ctx.lastAgentAttempt = { attemptId, pgid: handle.pgid };

  const artifacts = await input.adapter.collect(handle);
  const outcome = await input.adapter.classify(artifacts);

  const claimViolation = input.workspace
    ? await validateAttemptClaims(input.db, input.runId, input.taskId, input.workspace)
    : null;

  const normalizedAt = input.now();
  withTransaction(input.db, () => {
    input.db
      .prepare(`UPDATE attempts SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?`)
      .run(claimViolation ? "failed" : outcome.ok ? "completed" : "failed", artifacts.exitCode, normalizedAt, attemptId);
    appendEvent(input.db, {
      id: randomUUID(),
      run_id: input.runId,
      task_id: input.taskId,
      attempt_id: attemptId,
      type: "attempt.normalized",
      payload: JSON.stringify({ ok: outcome.ok, failureClass: outcome.failureClass, reason: outcome.reason }),
      created_at: normalizedAt,
    });
    if (claimViolation) {
      appendEvent(input.db, {
        id: randomUUID(),
        run_id: input.runId,
        task_id: input.taskId,
        attempt_id: attemptId,
        type: "attempt.claim-violation",
        payload: JSON.stringify(
          claimViolation.internalError === undefined
            ? { outOfClaim: claimViolation.outOfClaim }
            : { outOfClaim: claimViolation.outOfClaim, internalError: claimViolation.internalError },
        ),
        created_at: normalizedAt,
      });
    }
  });

  if (claimViolation) return "failed";
  return extractVerdict(stage, outcome);
}

async function resolveRunnerStage(stage: DevelopmentStageDefinition, ctx: DriverContext): Promise<string> {
  const { input } = ctx;

  switch (stage.predicate) {
    case "implementation-artifacts-present": {
      const result = await runBarrierForCurrentAttempt(ctx);
      const failedCondition = result.failedCondition;
      const meansMissing =
        failedCondition === "process-exited" ||
        failedCondition === "no-live-descendants" ||
        failedCondition === "artifacts-present";
      return meansMissing ? "false" : "true";
    }
    case "task-checks-pass": {
      const result = requireCachedBarrierResult(ctx);
      return taskChecksPass({ verdict: result.verdict });
    }
    case "minor-findings-recorded":
      return (input.recordMinors ?? (() => "true" as const))();
    case "handoff-recorded":
      return (input.handoffRecorded ?? (() => "true" as const))();
    default:
      throw new Error(`unknown runner predicate: ${String(stage.predicate)}`);
  }
}

async function runBarrierForCurrentAttempt(ctx: DriverContext): Promise<BarrierResult> {
  const { input, lastAgentAttempt } = ctx;
  if (!lastAgentAttempt) {
    throw new Error("collect-implementation-artifacts reached with no reaped agent attempt on record");
  }
  if (ctx.barrierCache && ctx.barrierCache.attemptId === lastAgentAttempt.attemptId) {
    return ctx.barrierCache.result;
  }
  const result = await runVerificationBarrier({
    attemptId: lastAgentAttempt.attemptId,
    taskId: input.taskId,
    taskDir: input.taskDir,
    executionRoot: input.executionRoot,
    pgids: [lastAgentAttempt.pgid],
    requiredArtifacts: input.requiredArtifacts,
    checks: input.checks,
    env: input.env,
  });
  ctx.barrierCache = { attemptId: lastAgentAttempt.attemptId, result };
  return result;
}

function requireCachedBarrierResult(ctx: DriverContext): BarrierResult {
  const { lastAgentAttempt, barrierCache } = ctx;
  if (!lastAgentAttempt || !barrierCache || barrierCache.attemptId !== lastAgentAttempt.attemptId) {
    throw new Error("verify-task reached with no cached barrier result for the current attempt");
  }
  return barrierCache.result;
}

// Maps a stage's counted edge (per the manifest's own gate semantics, not a
// generic default) to the `DEVELOPMENT_CAPS` key it advances. Every other
// edge advances no counter.
function gateForEdge(stageId: string, verdict: string, target: string): string | null {
  if (stageId === "review-spec" && verdict === "fail" && target === "fix-spec") return "specReviewGate";
  if (
    stageId === "review-quality" &&
    (verdict === "fail-with-severity: critical" || verdict === "fail-with-severity: important") &&
    target === "fix-quality"
  ) {
    return "qualityReviewGate";
  }
  if (verdict === "questions" && target === "waiting-operator") return "questionsLoop";
  if (stageId === "collect-implementation-artifacts" && verdict === "false" && target === "implement") {
    return "artifactRepair";
  }
  if (stageId === "verify-task" && verdict === "false" && target === "implement") return "taskChecksGate";
  return null;
}

export async function runDevelopmentStages(input: DevelopmentStageInput): Promise<DevelopmentOutcome> {
  const ctx: DriverContext = { input, lastAgentAttempt: null, barrierCache: null };
  const gateRounds: Record<string, number> = Object.fromEntries(
    Object.keys(DEVELOPMENT_CAPS).map((name) => [name, 0]),
  );
  const stages: DevelopmentStageVisit[] = [];

  let currentId = DEVELOPMENT_ENTRY_STAGE;

  for (;;) {
    const stage = DEVELOPMENT_STAGES_BY_ID.get(currentId);
    if (!stage) {
      throw new Error(`unknown development stage id: ${currentId}`);
    }

    const verdict = stage.kind === "agent" ? await runAgentStage(stage, ctx) : await resolveRunnerStage(stage, ctx);

    const target = Object.prototype.hasOwnProperty.call(stage.transitions, verdict)
      ? stage.transitions[verdict]
      : undefined;

    if (target === undefined) {
      stages.push({ stageId: stage.id, verdict: "schema-invalid" });
      return { outcome: "parked", stages, gateRounds, schemaInvalid: { stageId: stage.id, verdict } };
    }

    stages.push({ stageId: stage.id, verdict });

    const gateName = gateForEdge(stage.id, verdict, target);
    if (gateName) {
      gateRounds[gateName] = (gateRounds[gateName] ?? 0) + 1;
      if (gateRounds[gateName]! >= DEVELOPMENT_CAPS[gateName]!) {
        return { outcome: "parked", stages, gateRounds };
      }
    }

    if (TERMINAL_OUTCOME_IDS.has(target)) {
      return { outcome: target as DevelopmentOutcome["outcome"], stages, gateRounds };
    }

    currentId = target;
  }
}
