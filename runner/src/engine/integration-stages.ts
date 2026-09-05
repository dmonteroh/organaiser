// The `integration.v1` pipeline (`workflows/manifests/integration.v1.yaml`)
// as an executable data table and a driver over it, in the same shape as
// `workflow-stages.ts`'s own mirror-and-drive pair over `development.v1.yaml`
// — but a second, fully self-contained instance of that shape, not an
// extension of it: `INTEGRATION_STAGES`, its `*_BY_ID` map, the predicate-id
// switch, the gate bookkeeping, and the agent-stage dispatch sequence are
// this file's own, importing nothing from `workflow-stages.ts` and requiring
// no change to it.
//
// `runIntegrationStages` walks the table from `lock-destination` to one of
// its four terminal outcomes, running exactly one attempt for the single
// `kind: agent` stage (`cross-task-review`) and evaluating exactly one
// predicate per `kind: runner` stage. A fifth, non-manifest outcome,
// `cleanup-pending`, is this driver's own signal for a real-but-recoverable
// condition the manifest has no vocabulary for: a worktree removal that
// failed at `cleanup` after every other stage's evidence was already durable.
// A caller sees `cleanup-pending` as "no verdict yet, try again" rather than
// as a fourth manifest-declared outcome to route.

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
import { runVerificationBarrier, taskChecksPass } from "./barrier.ts";
import { positiveInt, type Read } from "../cli/config.ts";
import { removeWorkspace, type WorkspaceHandle, type WorkspaceRemovalResult } from "../git/workspace.ts";
import {
  advanceIntegration,
  createCandidateWorkspace,
  headSha,
  readRefSha,
  replayTaskBranch,
} from "../git/integrate.ts";
import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";

export type IntegrationStageKind = "agent" | "runner";
export type IntegrationStageAuthority = "workspace-write" | "read-only";

export interface IntegrationRetryPolicy {
  malformedResult: number;
  processFailure: number;
}

export interface IntegrationStageDefinition {
  id: string;
  kind: IntegrationStageKind;
  role: string | null;
  predicate: string | null;
  authority: IntegrationStageAuthority | null;
  freshSession: boolean | null;
  verdicts: readonly string[];
  transitions: Readonly<Record<string, string>>;
  retry: IntegrationRetryPolicy | null;
}

const CROSS_TASK_REVIEW_VERDICTS = [
  "pass",
  "needs-info",
  "fail-with-severity: critical",
  "fail-with-severity: important",
] as const;

const CROSS_TASK_REVIEW_TRANSITIONS: Readonly<Record<string, string>> = {
  pass: "advance-destination",
  "needs-info": "waiting-operator",
  "fail-with-severity: critical": "ready-to-implement",
  "fail-with-severity: important": "ready-to-implement",
};

const CROSS_TASK_REVIEW_RETRY: IntegrationRetryPolicy = { malformedResult: 1, processFailure: 1 };

export const INTEGRATION_STAGES: readonly IntegrationStageDefinition[] = [
  {
    id: "lock-destination",
    kind: "runner",
    role: null,
    predicate: "destination-lock-held",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "create-candidate", false: "parked" },
    retry: null,
  },
  {
    id: "create-candidate",
    kind: "runner",
    role: null,
    predicate: "candidate-worktree-created",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "replay-task", false: "parked" },
    retry: null,
  },
  {
    id: "replay-task",
    kind: "runner",
    role: null,
    predicate: "replay-clean",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "verify-candidate", false: "parked" },
    retry: null,
  },
  {
    id: "verify-candidate",
    kind: "runner",
    role: null,
    predicate: "candidate-checks-pass",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "cross-task-review", false: "ready-to-implement" },
    retry: null,
  },
  {
    id: "cross-task-review",
    kind: "agent",
    role: "code-quality-reviewer",
    predicate: null,
    authority: "read-only",
    freshSession: true,
    verdicts: CROSS_TASK_REVIEW_VERDICTS,
    transitions: CROSS_TASK_REVIEW_TRANSITIONS,
    retry: CROSS_TASK_REVIEW_RETRY,
  },
  {
    id: "advance-destination",
    kind: "runner",
    role: null,
    predicate: "destination-advanced",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "persist-integration", false: "create-candidate" },
    retry: null,
  },
  {
    id: "persist-integration",
    kind: "runner",
    role: null,
    predicate: "integration-evidence-durable",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "cleanup", false: "parked" },
    retry: null,
  },
  {
    id: "cleanup",
    kind: "runner",
    role: null,
    predicate: "worktrees-removed",
    authority: null,
    freshSession: null,
    verdicts: ["true", "false"],
    transitions: { true: "integrated", false: "parked" },
    retry: null,
  },
];

export const INTEGRATION_ENTRY_STAGE = "lock-destination";

export const INTEGRATION_CAPS: Readonly<Record<string, number>> = {
  crossTaskReviewGate: 3,
};

export const INTEGRATION_TERMINAL_OUTCOMES: Readonly<{
  success: readonly string[];
  attention: readonly string[];
  neutral: readonly string[];
}> = {
  success: ["integrated"],
  attention: ["waiting-operator", "parked"],
  neutral: ["ready-to-implement"],
};

const TERMINAL_OUTCOME_IDS = new Set<string>([
  ...INTEGRATION_TERMINAL_OUTCOMES.success,
  ...INTEGRATION_TERMINAL_OUTCOMES.attention,
  ...INTEGRATION_TERMINAL_OUTCOMES.neutral,
]);

const INTEGRATION_STAGES_BY_ID = new Map(INTEGRATION_STAGES.map((stage) => [stage.id, stage]));

export interface IntegrationStagesInput {
  db: DatabaseSync;
  adapter: ProcessAdapter;
  runId: string;
  taskId: string;
  now: () => number;

  // The operator's own repository: the destination ref lives here, and this
  // directory is never mutated directly by this driver (only `git
  // update-ref` on the destination ref, and only inside `advanceDestination`).
  projectRoot: string;
  destinationRef: string;
  // The task's own worktree, created earlier by the development pipeline.
  // Read for its `branch` and removed at `cleanup`; never checked out to a
  // different commit.
  taskWorkspace: WorkspaceHandle;
  // Directory under which this run's candidate worktrees are created.
  candidateRoot: string;

  // Verification barrier surface for `verify-candidate`.
  taskDir: string;
  requiredArtifacts: readonly string[];
  checks: Record<string, unknown>;
  env: NodeJS.ProcessEnv;

  // Optional dispatch placeholders for `cross-task-review`.
  vendor?: string;
  model?: string;
  configJson?: string;
  timeoutBudget?: TimeoutBudget;
  packet?: (stageId: string, role: string, priorReport: Record<string, unknown> | null) => string;

  // Test seam only: invoked immediately before `advance-destination` reads
  // the candidate's head and calls `update-ref`, so a test can move the
  // destination ref out from under a specific attempt deterministically
  // rather than racing a real concurrent process. Absent in production.
  beforeAdvanceDestination?: () => Promise<void> | void;
}

const DEFAULT_TIMEOUT_BUDGET: TimeoutBudget = { spawnMs: 30000, idleMs: 30000, wallMs: 300000 };

export interface IntegrationStageVisit {
  stageId: string;
  verdict: string;
}

export type IntegrationOutcomeId = "integrated" | "ready-to-implement" | "waiting-operator" | "parked";

export interface IntegrationStagesOutcome {
  // `cleanup-pending` is not a manifest outcome (see the module comment): a
  // caller maps it to "no verdict for this task this tick", not to any of
  // `integration-outcome`'s declared return values.
  outcome: IntegrationOutcomeId | "cleanup-pending";
  stages: readonly IntegrationStageVisit[];
  gateRounds: Readonly<Record<string, number>>;
  resultCommit?: string;
  schemaInvalid?: { stageId: string; verdict: string };
}

export class IntegrationCleanupPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationCleanupPendingError";
  }
}

// `cli/config.ts`'s own project/user/environment layering isn't threaded
// into this driver, so this reads the environment layer only, with the same
// `ORGA_`-prefixed name and the same `positiveInt` validator `loadConfig`
// itself uses for every other bounded integer setting.
const configRead: Read = (name) => process.env[`ORGA_${name}`];

function integrationRebuildCap(): number {
  return positiveInt(configRead, "INTEGRATION_REBUILD_CAP", 3);
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed/.test(err.message)
  );
}

interface LastAgentAttempt {
  attemptId: string;
  pgid: number;
}

interface IntegrationDriverContext {
  input: IntegrationStagesInput;
  integrationId: string;
  lockId: string | null;
  destinationSha: string | null;
  candidate: WorkspaceHandle | null;
  rebuildCount: number;
  observedDestinationShas: string[];
  lastAgentAttempt: LastAgentAttempt | null;
  lastAgentReport: Record<string, unknown> | null;
  resultCommit: string | null;
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

function extractVerdict(outcome: AttemptOutcome): string {
  if (!outcome.ok || outcome.report === null) {
    return outcome.failureClass ?? "no-report";
  }
  const value = outcome.report.verdict;
  return typeof value === "string" ? value : "no-verdict";
}

// The `integrations` row for this attempt is created on its first write
// (during `create-candidate`) and merged into thereafter: `checks` is
// replaced wholesale each call rather than deep-merged, so every caller
// passes the full evidence object it wants durable, not a delta.
function upsertIntegrationRow(
  ctx: IntegrationDriverContext,
  patch: {
    baseCommit?: string;
    candidateRef?: string;
    resultCommit?: string | null;
    checks?: unknown;
    disposition?: string;
    completedAt?: number | null;
  },
): void {
  const { input } = ctx;
  const checksJson = patch.checks !== undefined ? JSON.stringify(patch.checks) : undefined;

  withTransaction(input.db, () => {
    const existing = input.db.prepare(`SELECT id FROM integrations WHERE id = ?`).get(ctx.integrationId) as
      | { id: string }
      | undefined;

    if (!existing) {
      input.db
        .prepare(
          `INSERT INTO integrations (id, run_id, task_id, base_commit, candidate_ref, result_commit, checks, disposition, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ctx.integrationId,
          input.runId,
          input.taskId,
          patch.baseCommit ?? "",
          patch.candidateRef ?? "",
          patch.resultCommit ?? null,
          checksJson ?? "{}",
          patch.disposition ?? "pending",
          input.now(),
          patch.completedAt ?? null,
        );
      return;
    }

    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.baseCommit !== undefined) {
      sets.push("base_commit = ?");
      values.push(patch.baseCommit);
    }
    if (patch.candidateRef !== undefined) {
      sets.push("candidate_ref = ?");
      values.push(patch.candidateRef);
    }
    if (patch.resultCommit !== undefined) {
      sets.push("result_commit = ?");
      values.push(patch.resultCommit);
    }
    if (checksJson !== undefined) {
      sets.push("checks = ?");
      values.push(checksJson);
    }
    if (patch.disposition !== undefined) {
      sets.push("disposition = ?");
      values.push(patch.disposition);
    }
    if (patch.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(patch.completedAt);
    }
    if (sets.length === 0) return;
    values.push(ctx.integrationId);
    input.db.prepare(`UPDATE integrations SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  });
}

function acquireDestinationLock(ctx: IntegrationDriverContext): "true" | "false" {
  const { input } = ctx;
  const lockId = randomUUID();
  const nowMs = input.now();
  try {
    withTransaction(input.db, () => {
      input.db
        .prepare(
          `INSERT INTO locks (id, run_id, kind, resource, owner_pid, acquired_at, heartbeat_at, released_at)
           VALUES (?, ?, 'integration', ?, ?, ?, ?, NULL)`,
        )
        .run(lockId, input.runId, input.destinationRef, process.pid, nowMs, nowMs);
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) return "false";
    throw err;
  }
  ctx.lockId = lockId;
  return "true";
}

function releaseDestinationLock(ctx: IntegrationDriverContext): void {
  if (!ctx.lockId) return;
  const lockId = ctx.lockId;
  withTransaction(ctx.input.db, () => {
    ctx.input.db.prepare(`UPDATE locks SET released_at = ? WHERE id = ?`).run(ctx.input.now(), lockId);
  });
  ctx.lockId = null;
}

// Always re-reads the destination ref: the first call (following
// `lock-destination`) and every rebuild call alike, so a candidate is always
// built from the destination sha actually observed at build time, and
// `advance-destination`'s compare-and-swap always compares against the sha
// its own candidate was built from.
async function buildCandidateWorkspace(ctx: IntegrationDriverContext): Promise<"true" | "false"> {
  const { input } = ctx;
  const destinationSha = readRefSha(input.projectRoot, input.destinationRef);
  ctx.destinationSha = destinationSha;
  ctx.observedDestinationShas.push(destinationSha);
  ctx.rebuildCount += 1;

  upsertIntegrationRow(ctx, {
    baseCommit: destinationSha,
    checks: { rebuildCount: ctx.rebuildCount, observedDestinationShas: [...ctx.observedDestinationShas] },
  });

  if (ctx.rebuildCount > integrationRebuildCap()) {
    return "false";
  }

  const candidatePath = path.join(input.candidateRoot, input.runId, `${input.taskId}-candidate-${ctx.rebuildCount}`);
  const handle = createCandidateWorkspace({
    db: input.db,
    runId: input.runId,
    taskId: input.taskId,
    projectRoot: input.projectRoot,
    candidatePath,
    destinationSha,
  });
  ctx.candidate = handle;
  upsertIntegrationRow(ctx, { candidateRef: candidatePath });
  return "true";
}

async function replayCandidate(ctx: IntegrationDriverContext): Promise<"true" | "false"> {
  const { input, candidate, destinationSha } = ctx;
  if (!candidate || !destinationSha) {
    throw new Error("replay-task reached with no candidate on record");
  }

  const result = replayTaskBranch({
    candidatePath: candidate.path,
    baseCommit: destinationSha,
    taskBranch: input.taskWorkspace.branch,
  });
  if (result.ok) return "true";

  await removeWorkspace(candidate, { db: input.db, projectRoot: input.projectRoot, runId: input.runId });
  ctx.candidate = null;
  upsertIntegrationRow(ctx, {
    disposition: "rejected",
    checks: {
      rebuildCount: ctx.rebuildCount,
      observedDestinationShas: [...ctx.observedDestinationShas],
      integrationConflict: {
        conflictingPaths: result.conflict.conflictingPaths,
        taskBranch: input.taskWorkspace.branch,
        destinationSha,
      },
    },
  });
  return "false";
}

async function verifyCandidate(ctx: IntegrationDriverContext): Promise<"true" | "false"> {
  const { input, candidate } = ctx;
  if (!candidate) {
    throw new Error("verify-candidate reached with no candidate on record");
  }

  const result = await runVerificationBarrier({
    attemptId: ctx.integrationId,
    taskId: input.taskId,
    taskDir: input.taskDir,
    executionRoot: candidate.path,
    pgids: [],
    requiredArtifacts: input.requiredArtifacts,
    checks: input.checks,
    env: input.env,
  });

  upsertIntegrationRow(ctx, {
    checks: {
      rebuildCount: ctx.rebuildCount,
      observedDestinationShas: [...ctx.observedDestinationShas],
      verifyCandidate: { verdict: result.verdict, failedCondition: result.failedCondition },
    },
  });

  return taskChecksPass({ verdict: result.verdict });
}

async function advanceDestinationStage(ctx: IntegrationDriverContext): Promise<"true" | "false"> {
  const { input, candidate, destinationSha } = ctx;
  if (!candidate || !destinationSha) {
    throw new Error("advance-destination reached with no candidate on record");
  }

  if (input.beforeAdvanceDestination) {
    await input.beforeAdvanceDestination();
  }

  const newSha = headSha(candidate.path);
  const ok = advanceIntegration({
    strategy: "replay-and-fast-forward",
    projectRoot: input.projectRoot,
    ref: input.destinationRef,
    newSha,
    expectedOldSha: destinationSha,
  });

  if (ok) {
    ctx.resultCommit = newSha;
    return "true";
  }

  await removeWorkspace(candidate, { db: input.db, projectRoot: input.projectRoot, runId: input.runId });
  ctx.candidate = null;
  return "false";
}

function persistIntegrationEvidence(ctx: IntegrationDriverContext): "true" {
  const { input, resultCommit } = ctx;
  if (!resultCommit) {
    throw new Error("persist-integration reached with no result commit on record");
  }
  upsertIntegrationRow(ctx, {
    resultCommit,
    disposition: "integrated",
    completedAt: input.now(),
    checks: { rebuildCount: ctx.rebuildCount, observedDestinationShas: [...ctx.observedDestinationShas] },
  });
  return "true";
}

async function removeIntegrationWorktrees(ctx: IntegrationDriverContext): Promise<"true"> {
  const { input, candidate } = ctx;
  const removalCtx = { db: input.db, projectRoot: input.projectRoot, runId: input.runId };

  const taskResult = await removeWorkspace(input.taskWorkspace, removalCtx);
  const candidateResult: WorkspaceRemovalResult = candidate
    ? await removeWorkspace(candidate, removalCtx)
    : { ok: true, cleanupState: "cleaned" };

  if (taskResult.ok && candidateResult.ok) return "true";
  throw new IntegrationCleanupPendingError("cleanup: worktree removal failed; retry on next tick");
}

async function resolveRunnerStage(stage: IntegrationStageDefinition, ctx: IntegrationDriverContext): Promise<string> {
  switch (stage.predicate) {
    case "destination-lock-held":
      return acquireDestinationLock(ctx);
    case "candidate-worktree-created":
      return await buildCandidateWorkspace(ctx);
    case "replay-clean":
      return await replayCandidate(ctx);
    case "candidate-checks-pass":
      return await verifyCandidate(ctx);
    case "destination-advanced":
      return await advanceDestinationStage(ctx);
    case "integration-evidence-durable":
      return persistIntegrationEvidence(ctx);
    case "worktrees-removed":
      return await removeIntegrationWorktrees(ctx);
    default:
      throw new Error(`unknown integration runner predicate: ${String(stage.predicate)}`);
  }
}

async function runAgentStage(stage: IntegrationStageDefinition, ctx: IntegrationDriverContext): Promise<string> {
  const { input } = ctx;
  const round = nextAttemptRound(input.db, input.runId, input.taskId, stage.id);
  const inputVersion = computeInputVersion({ taskId: input.taskId, stageId: stage.id, round: String(round) });
  const packetFn = input.packet ?? ((stageId: string) => `packet for task ${input.taskId} at stage ${stageId}`);
  const packetText = packetFn(stage.id, stage.role ?? "", ctx.lastAgentReport);
  const workingDirectory = ctx.candidate?.path ?? input.projectRoot;

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
    mutating: false,
    timeoutBudget: input.timeoutBudget ?? DEFAULT_TIMEOUT_BUDGET,
    workingDirectory,
    environment: input.env,
    packet: packetText,
  };

  const dispatched = await dispatchAttempt(input.db, input.adapter, dispatchInput, input.now);
  if (!dispatched.dispatched) {
    throw new Error(`dispatch of stage ${stage.id} round ${round} collided with an already-recorded attempt`);
  }
  const { attemptId, handle } = dispatched;

  await waitForExit(handle);

  const reapedAt = input.now();
  withTransaction(input.db, () => {
    input.db
      .prepare(`UPDATE workers SET termination_state = 'exited', ended_at = ? WHERE attempt_id = ?`)
      .run(reapedAt, attemptId);
  });
  ctx.lastAgentAttempt = { attemptId, pgid: handle.pgid };

  const artifacts = await input.adapter.collect(handle);
  const outcome = await input.adapter.classify(artifacts);
  ctx.lastAgentReport = outcome.report;

  const normalizedAt = input.now();
  withTransaction(input.db, () => {
    input.db
      .prepare(`UPDATE attempts SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?`)
      .run(outcome.ok ? "completed" : "failed", artifacts.exitCode, normalizedAt, attemptId);
    appendEvent(input.db, {
      id: randomUUID(),
      run_id: input.runId,
      task_id: input.taskId,
      attempt_id: attemptId,
      type: "attempt.normalized",
      payload: JSON.stringify({ ok: outcome.ok, failureClass: outcome.failureClass, reason: outcome.reason }),
      created_at: normalizedAt,
    });
  });

  return extractVerdict(outcome);
}

function gateForEdge(stageId: string, verdict: string, target: string): string | null {
  if (
    stageId === "cross-task-review" &&
    (verdict === "fail-with-severity: critical" || verdict === "fail-with-severity: important") &&
    target === "ready-to-implement"
  ) {
    return "crossTaskReviewGate";
  }
  return null;
}

function gateForStage(stageId: string): string | null {
  if (stageId === "cross-task-review") return "crossTaskReviewGate";
  return null;
}

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

  const orphaned = db
    .prepare(`SELECT id FROM gates WHERE run_id = ? AND task_id = ? AND verdict IS NULL`)
    .all(runId, taskId) as Array<{ id: string }>;
  for (const orphan of orphaned) {
    discardPendingGate(db, orphan.id);
  }
}

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

function discardPendingGate(db: DatabaseSync, id: string): void {
  withTransaction(db, () => {
    db.prepare(`DELETE FROM gates WHERE id = ?`).run(id);
  });
}

function evidenceForStage(stage: IntegrationStageDefinition, ctx: IntegrationDriverContext): string | null {
  if (stage.kind !== "agent") return null;
  return ctx.lastAgentReport ? JSON.stringify(ctx.lastAgentReport) : null;
}

// Resumes a task whose `integrations` row already durably reports
// `disposition: 'integrated'` but whose worktrees are not all `cleaned`: the
// prior attempt's evidence is already committed, so this call retries only
// the removal rather than re-running the whole pipeline (which would rebuild
// a candidate, re-dispatch `cross-task-review`, and re-attempt an
// already-satisfied compare-and-swap).
async function resumePendingCleanup(input: IntegrationStagesInput): Promise<IntegrationStagesOutcome | null> {
  const row = input.db
    .prepare(
      `SELECT id, result_commit FROM integrations WHERE run_id = ? AND task_id = ? AND disposition = 'integrated' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.runId, input.taskId) as { id: string; result_commit: string | null } | undefined;
  if (!row) return null;

  const pending = input.db
    .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND task_id = ? AND cleanup_state != 'cleaned'`)
    .get(input.runId, input.taskId) as { n: number };
  if (pending.n === 0) {
    return { outcome: "integrated", stages: [], gateRounds: {}, resultCommit: row.result_commit ?? undefined };
  }

  const removalCtx = { db: input.db, projectRoot: input.projectRoot, runId: input.runId };
  const taskResult = await removeWorkspace(input.taskWorkspace, removalCtx);

  const candidateRow = input.db
    .prepare(
      `SELECT path, branch, base_commit FROM worktrees
         WHERE run_id = ? AND task_id = ? AND path != ? AND cleanup_state != 'cleaned'`,
    )
    .get(input.runId, input.taskId, input.taskWorkspace.path) as
    | { path: string; branch: string; base_commit: string }
    | undefined;

  let candidateResult: WorkspaceRemovalResult = { ok: true, cleanupState: "cleaned" };
  if (candidateRow) {
    const handle: WorkspaceHandle = {
      mode: "worktree",
      root: "",
      path: candidateRow.path,
      branch: candidateRow.branch,
      baseCommit: candidateRow.base_commit,
      recordedDirt: [],
    };
    candidateResult = await removeWorkspace(handle, removalCtx);
  }

  if (taskResult.ok && candidateResult.ok) {
    return { outcome: "integrated", stages: [], gateRounds: {}, resultCommit: row.result_commit ?? undefined };
  }
  return { outcome: "cleanup-pending", stages: [], gateRounds: {} };
}

export async function runIntegrationStages(input: IntegrationStagesInput): Promise<IntegrationStagesOutcome> {
  const resumed = await resumePendingCleanup(input);
  if (resumed) return resumed;

  const ctx: IntegrationDriverContext = {
    input,
    integrationId: randomUUID(),
    lockId: null,
    destinationSha: null,
    candidate: null,
    rebuildCount: 0,
    observedDestinationShas: [],
    lastAgentAttempt: null,
    lastAgentReport: null,
    resultCommit: null,
  };

  const gateRounds: Record<string, number> = Object.fromEntries(
    Object.keys(INTEGRATION_CAPS).map((name) => [name, 0]),
  );
  resumeGateRounds(input.db, input.runId, input.taskId, gateRounds);

  const stages: IntegrationStageVisit[] = [];
  let currentId = INTEGRATION_ENTRY_STAGE;

  try {
    for (;;) {
      const stage = INTEGRATION_STAGES_BY_ID.get(currentId);
      if (!stage) {
        throw new Error(`unknown integration stage id: ${currentId}`);
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
          INTEGRATION_CAPS[gateName]!,
          input.now(),
        );
      }

      let verdict: string;
      try {
        verdict = stage.kind === "agent" ? await runAgentStage(stage, ctx) : await resolveRunnerStage(stage, ctx);
      } catch (err) {
        if (err instanceof IntegrationCleanupPendingError) {
          if (pendingGateId) discardPendingGate(input.db, pendingGateId);
          return { outcome: "cleanup-pending", stages, gateRounds };
        }
        throw err;
      }

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

      if (resolvedGate && gateRounds[resolvedGate]! >= INTEGRATION_CAPS[resolvedGate]!) {
        return { outcome: "parked", stages, gateRounds };
      }

      if (TERMINAL_OUTCOME_IDS.has(target)) {
        const outcome = target as IntegrationOutcomeId;
        return {
          outcome,
          stages,
          gateRounds,
          ...(outcome === "integrated" ? { resultCommit: ctx.resultCommit ?? undefined } : {}),
        };
      }

      currentId = target;
    }
  } finally {
    releaseDestinationLock(ctx);
  }
}
