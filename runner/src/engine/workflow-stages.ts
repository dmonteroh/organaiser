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
import path from "node:path";
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
import { partitionFindings } from "./review-stages.ts";
import { appendMinorFindings } from "./minor-findings.ts";
import { loadConfig } from "../cli/config.ts";
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

// A `kind: agent` stage whose mirrored `authority` is `read-only` dispatches
// at `workspace.path` like any other stage unless a `reviewerWorkspace`
// resolver is supplied; when it is, the resolver's own handle replaces
// `workspace` as that one attempt's dispatch directory, and its `release` is
// awaited once the attempt ends, on every exit path.
export interface ReviewerWorkspaceHandle {
  workspace: WorkspaceHandle;
  release: () => Promise<void>;
}

export interface ReviewerWorkspaceRequest {
  runId: string;
  taskId: string;
  stageId: string;
  round: number;
}

export type ReviewerWorkspaceResolver = (
  request: ReviewerWorkspaceRequest,
) => Promise<ReviewerWorkspaceHandle>;

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

  // Optional; consulted only for stages whose mirrored `authority` is
  // `read-only`. Absent, those stages dispatch exactly like any other stage.
  reviewerWorkspace?: ReviewerWorkspaceResolver;

  // Optional injected `kind: runner` predicates. Each defaults to `() => "true"`.
  recordMinors?: () => "true" | "false";
  handoffRecorded?: () => "true" | "false";

  // Optional dispatch placeholders.
  vendor?: string;
  model?: string;
  configJson?: string;
  timeoutBudget?: TimeoutBudget;
  packet?: (stageId: string, role: string, priorReport: Record<string, unknown> | null) => string;
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
  lastAgentReport: Record<string, unknown> | null;
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
  const packetFn = input.packet ?? ((stageId: string) => `packet for task ${input.taskId} at stage ${stageId}`);
  const packetText = packetFn(stage.id, stage.role ?? "", ctx.lastAgentReport);

  let workingDirectory = input.workspace?.path ?? input.executionRoot;
  let reviewerWorkspace: ReviewerWorkspaceHandle | null = null;
  if (stage.authority === "read-only" && input.reviewerWorkspace) {
    reviewerWorkspace = await input.reviewerWorkspace({
      runId: input.runId,
      taskId: input.taskId,
      stageId: stage.id,
      round,
    });
    workingDirectory = reviewerWorkspace.workspace.path;
  }

  try {
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
      packet: packetText,
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
    ctx.lastAgentReport = outcome.report;

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
  } finally {
    if (reviewerWorkspace) await reviewerWorkspace.release();
  }
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
      return input.recordMinors ? input.recordMinors() : resolveRecordMinors(input, ctx);
    case "handoff-recorded":
      return (input.handoffRecorded ?? (() => "true" as const))();
    default:
      throw new Error(`unknown runner predicate: ${String(stage.predicate)}`);
  }
}

// The default behind `input.recordMinors`'s injected seam: the reaped
// `review-quality` attempt's own report is `ctx.lastAgentReport` by the time
// this predicate runs, and `ctx.lastAgentAttempt` names that same attempt,
// so the accepted `minor` findings and their identity triple both come from
// the driver's own state — no separate lookup. The follow-ups file path is
// `cli/config.ts`'s resolved `followUpsFilePath`, resolved against
// `process.cwd()` rather than `input.executionRoot`: the detached
// supervisor's cwd is the project root by construction (`supervisor-spawn.ts`
// spawns it there), while `executionRoot` is a runner-owned worktree for a
// mutating task and must never receive this write.
function resolveRecordMinors(input: DevelopmentStageInput, ctx: DriverContext): "true" | "false" {
  const attemptId = ctx.lastAgentAttempt?.attemptId;
  if (!attemptId) return "true";

  const rawFindings = (ctx.lastAgentReport as Record<string, unknown> | null)?.findings as
    | readonly unknown[]
    | undefined;
  const partition = partitionFindings(rawFindings);
  if (partition.minor.length === 0) return "true";

  const config = loadConfig({ env: process.env });
  const followUpsFilePath = path.resolve(config.followUpsFilePath);

  return appendMinorFindings({
    db: input.db,
    runId: input.runId,
    taskId: input.taskId,
    attemptId,
    findings: partition.minor.map((finding) => ({
      summary: finding.summary,
      path: finding.path,
      line: finding.line ?? null,
    })),
    followUpsFilePath,
    now: input.now,
  });
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

// The single `DEVELOPMENT_CAPS` key a stage could ever advance, known before
// that stage's verdict is resolved (unlike `gateForEdge`, which additionally
// needs the verdict and target). Every gate name in `DEVELOPMENT_CAPS` has
// exactly one entry here.
function gateForStage(stageId: string): string | null {
  if (stageId === "review-spec") return "specReviewGate";
  if (stageId === "review-quality") return "qualityReviewGate";
  if (stageId === "collect-implementation-artifacts") return "artifactRepair";
  if (stageId === "verify-task") return "taskChecksGate";
  if (stageId === "implement" || stageId === "fix-spec" || stageId === "fix-quality") return "questionsLoop";
  return null;
}

// Resumes `gateRounds` from the run's durable `gates` rows for this task, so
// a driver restarted after a crash never re-starts a gate's count at zero.
function resumeGateRounds(
  db: DatabaseSync,
  runId: string,
  taskId: string,
  gateRounds: Record<string, number>,
): void {
  const rows = db
    .prepare(`SELECT gate_type, MAX(round) AS maxRound FROM gates WHERE run_id = ? AND task_id = ? GROUP BY gate_type`)
    .all(runId, taskId) as Array<{ gate_type: string; maxRound: number }>;
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(gateRounds, row.gate_type)) {
      gateRounds[row.gate_type] = row.maxRound;
    }
  }

  // This call has not yet written a pending row of its own, so any row still
  // `verdict IS NULL` here belongs to an earlier invocation that never
  // reached its own `finalizeGate`/`discardPendingGate` call. Its round is
  // already folded into `gateRounds` above; the row itself is discarded so
  // it is never left permanently undecided for `executeGates` to find once
  // this task later reaches a terminal disposition.
  const orphaned = db
    .prepare(`SELECT id FROM gates WHERE run_id = ? AND task_id = ? AND verdict IS NULL`)
    .all(runId, taskId) as Array<{ id: string }>;
  for (const orphan of orphaned) {
    discardPendingGate(db, orphan.id);
  }
}

// Commits the pending row a gated stage's dispatch durably claims before it
// runs: a crash between this write and the round's resolution leaves a
// `verdict IS NULL` row a restart resumes from, rather than losing the round.
function insertPendingGate(
  db: DatabaseSync,
  runId: string,
  taskId: string,
  gateType: string,
  round: number,
  cap: number,
  nowMs: number,
): string {
  const id = randomUUID();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO gates (id, run_id, task_id, gate_type, round, cap, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, runId, taskId, gateType, round, cap, nowMs);
  });
  return id;
}

// Only a gate's counted-failure edge is ever finalized; a passing round is
// discarded instead (`discardPendingGate`), so `verdict` is always "fail"
// here.
function finalizeGate(db: DatabaseSync, id: string, evidenceRef: string | null, nowMs: number): void {
  withTransaction(db, () => {
    db.prepare(`UPDATE gates SET verdict = ?, evidence_ref = ?, decided_at = ? WHERE id = ?`).run(
      "fail",
      evidenceRef,
      nowMs,
      id,
    );
  });
}

// A speculative round that turned out not to be the gate's counted edge (the
// stage passed, or its verdict fell outside its declared transitions): the
// pending row committed before dispatch never became a round, so it is
// removed rather than left as a permanently unresolved row.
function discardPendingGate(db: DatabaseSync, id: string): void {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM gates WHERE id = ?`).run(id);
  });
}

function evidenceForStage(stage: DevelopmentStageDefinition, ctx: DriverContext): string | null {
  const value = stage.kind === "agent" ? ctx.lastAgentReport : ctx.barrierCache?.result ?? null;
  return value ? JSON.stringify(value) : null;
}

export async function runDevelopmentStages(input: DevelopmentStageInput): Promise<DevelopmentOutcome> {
  const ctx: DriverContext = { input, lastAgentAttempt: null, barrierCache: null, lastAgentReport: null };
  const gateRounds: Record<string, number> = Object.fromEntries(
    Object.keys(DEVELOPMENT_CAPS).map((name) => [name, 0]),
  );
  resumeGateRounds(input.db, input.runId, input.taskId, gateRounds);
  const stages: DevelopmentStageVisit[] = [];

  let currentId = DEVELOPMENT_ENTRY_STAGE;

  for (;;) {
    const stage = DEVELOPMENT_STAGES_BY_ID.get(currentId);
    if (!stage) {
      throw new Error(`unknown development stage id: ${currentId}`);
    }

    const gateName = gateForStage(stage.id);
    let pendingGateId: string | null = null;
    let pendingRound = 0;
    if (gateName) {
      pendingRound = (gateRounds[gateName] ?? 0) + 1;
      pendingGateId = insertPendingGate(
        input.db,
        input.runId,
        input.taskId,
        gateName,
        pendingRound,
        DEVELOPMENT_CAPS[gateName]!,
        input.now(),
      );
    }

    const verdict = stage.kind === "agent" ? await runAgentStage(stage, ctx) : await resolveRunnerStage(stage, ctx);

    const target = Object.prototype.hasOwnProperty.call(stage.transitions, verdict)
      ? stage.transitions[verdict]
      : undefined;

    const resolvedGate = target === undefined ? null : gateForEdge(stage.id, verdict, target);

    if (pendingGateId) {
      if (resolvedGate === gateName) {
        gateRounds[gateName!] = pendingRound;
        finalizeGate(input.db, pendingGateId, evidenceForStage(stage, ctx), input.now());
      } else {
        discardPendingGate(input.db, pendingGateId);
      }
    }

    if (target === undefined) {
      stages.push({ stageId: stage.id, verdict: "schema-invalid" });
      return { outcome: "parked", stages, gateRounds, schemaInvalid: { stageId: stage.id, verdict } };
    }

    stages.push({ stageId: stage.id, verdict });

    if (resolvedGate && gateRounds[resolvedGate]! >= DEVELOPMENT_CAPS[resolvedGate]!) {
      return { outcome: "parked", stages, gateRounds };
    }

    if (TERMINAL_OUTCOME_IDS.has(target)) {
      return { outcome: target as DevelopmentOutcome["outcome"], stages, gateRounds };
    }

    currentId = target;
  }
}
