// Dispatch eligibility (goals spec section 12) and atomic dispatch (goals spec
// section 23.3). Eligibility is expressed as ten named conditions rather than
// section 12's nine bullets: "a worker slot and vendor slot are available" is
// two independent conditions, split here so each can be toggled on its own.
// All ten are evaluated for real, each computed directly from the store
// (`claims`, `locks`, `attempts`, `workers`) the same way `claimSetComplete`/
// `worktreeMatchesRecordedBase` are — this module has no dependency on the
// scheduler's in-memory runtime state.
//
// Atomic dispatch creates the `attempts` row and its worker inside one
// transaction keyed by P5a's `(run_id, task_id, stage_id, round,
// input_version)` unique index: a second caller racing the same key observes
// the unique-constraint violation as a duplicate rather than spawning a
// second worker.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  AttemptDescriptor,
  ExecutionSurface,
  ProcessAdapter,
  ProcessHandle,
  TimeoutBudget,
} from "../adapters/adapter.ts";
import { positiveInt, type Read } from "../cli/config.ts";
import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { sha256 } from "../store/evidence.ts";
import type { AttemptRow } from "../store/types.ts";

export interface DispatchConditions {
  // In P5 scope: evaluated for real.
  dependenciesSatisfied: boolean;
  noUnresolvedBlockingQuestion: boolean;
  stageInputArtifactsValid: boolean;
  workerSlotAvailable: boolean;

  // Evaluated for real: computed from the claims and worktrees rows.
  claimSetComplete: boolean;
  worktreeMatchesRecordedBase: boolean;

  // Evaluated for real: computed from the claims, locks, attempts, and
  // workers rows, or from caller-supplied vendor/concurrency/probe facts.
  claimsDoNotOverlapActive: boolean;
  vendorSlotAvailable: boolean;
  readinessProbePassed: boolean;
  noControllerOrIntegrationLockConflict: boolean;
}

function parseClaimPaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

// A worker row with no `ended_at` that has not been marked `exited` by
// `reapWorkers` counts as an active, non-reaped attempt for the task named.
function hasActiveNonReapedAttempt(db: DatabaseSync, runId: string, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM attempts a
         JOIN workers w ON w.attempt_id = a.id
        WHERE a.run_id = ? AND a.task_id = ?
          AND w.ended_at IS NULL
          AND (w.termination_state IS NULL OR w.termination_state != 'exited')`,
    )
    .get(runId, taskId) as { n: number };
  return row.n > 0;
}

export interface ClaimsDoNotOverlapActiveInput {
  runId: string;
  taskId: string;
}

// False when another task holds an intersecting `dimension = 'files'` claim
// value while that other task also has an active, non-reaped attempt; true
// otherwise, including when the candidate holds no claim of its own to
// intersect with anything.
export function claimsDoNotOverlapActive(db: DatabaseSync, input: ClaimsDoNotOverlapActiveInput): boolean {
  const ownRow = db
    .prepare(`SELECT value FROM claims WHERE run_id = ? AND task_id = ? AND dimension = 'files'`)
    .get(input.runId, input.taskId) as { value: string } | undefined;
  if (!ownRow) return true;
  const own = new Set(parseClaimPaths(ownRow.value));
  if (own.size === 0) return true;

  const others = db
    .prepare(`SELECT task_id, value FROM claims WHERE run_id = ? AND task_id != ? AND dimension = 'files'`)
    .all(input.runId, input.taskId) as Array<{ task_id: string; value: string }>;

  for (const other of others) {
    const intersects = parseClaimPaths(other.value).some((path) => own.has(path));
    if (intersects && hasActiveNonReapedAttempt(db, input.runId, other.task_id)) {
      return false;
    }
  }
  return true;
}

export interface VendorSlotAvailableInput {
  vendor: "claude" | "codex" | "fake";
  runId: string;
  vendorSlots: Readonly<Record<"codex" | "claude", number>> | undefined;
}

// True only when the count of active, non-reaped attempts for the
// candidate's resolved vendor is below that vendor's configured slot count.
// The candidate's vendor being `"fake"` (never a member of `RunnerId`) or no
// `vendorSlots` map reaching the call at all both return true unconditionally
// — an unguarded `count < vendorSlots[vendor]` comparison against `undefined`
// would otherwise evaluate to false and permanently block the fake-vendor
// dispatch path most of the test suite relies on.
export function vendorSlotAvailable(db: DatabaseSync, input: VendorSlotAvailableInput): boolean {
  if (input.vendor !== "codex" && input.vendor !== "claude") return true;
  if (input.vendorSlots === undefined) return true;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM attempts a
         JOIN workers w ON w.attempt_id = a.id
        WHERE a.run_id = ? AND a.vendor = ?
          AND w.ended_at IS NULL
          AND (w.termination_state IS NULL OR w.termination_state != 'exited')`,
    )
    .get(input.runId, input.vendor) as { n: number };
  return row.n < input.vendorSlots[input.vendor];
}

export interface ReadinessProbeFacts {
  authenticationOutcome: string;
  isKnownBadVersion: boolean;
}

export interface ReadinessProbePassedInput {
  vendor: "claude" | "codex" | "fake";
  probe: ReadinessProbeFacts | undefined;
}

// Reads the capability-report facts a caller's most recent readiness probe
// already established (never runs a new probe itself): not on the known-bad
// version list, and authenticated. The candidate's vendor being `"fake"` or
// no probe facts reaching the call at all (every call site with no
// `DispatchProfile` in scope) both return true unconditionally, mirroring
// `vendorSlotAvailable`'s fallback for the same undefined-comparison hazard.
export function readinessProbePassed(input: ReadinessProbePassedInput): boolean {
  if (input.vendor !== "codex" && input.vendor !== "claude") return true;
  if (input.probe === undefined) return true;
  return !input.probe.isKnownBadVersion && input.probe.authenticationOutcome === "authenticated";
}

const lockStaleRead: Read = (name) => process.env[`ORGA_${name}`];

function controllerOrIntegrationLockStaleMs(): number {
  return positiveInt(lockStaleRead, "INTEGRATION_LOCK_STALE_MS", 300000);
}

export interface LockConflictInput {
  runId: string;
  now: number;
}

// The `locks` table has no `task_id` column and its `owner_pid` is always
// the scheduler process's own pid, so "held by a task other than the
// candidate" cannot be a task-keyed join: it reduces to a run-scoped
// existence check. The single-lane dispatch invariant means a candidate
// being evaluated has not yet dispatched, so any live, non-stale
// `kind = 'integration'` row for this run necessarily belongs to a
// different, already-dispatched task.
export function noControllerOrIntegrationLockConflict(db: DatabaseSync, input: LockConflictInput): boolean {
  const rows = db
    .prepare(`SELECT heartbeat_at FROM locks WHERE run_id = ? AND kind = 'integration' AND released_at IS NULL`)
    .all(input.runId) as Array<{ heartbeat_at: number }>;
  const staleMs = controllerOrIntegrationLockStaleMs();
  return !rows.some((row) => input.now - row.heartbeat_at <= staleMs);
}

export interface ClaimSetCompleteInput {
  runId: string;
  taskId: string;
  mutating: boolean;
  workspaceProviderPresent: boolean;
}

// True unless the dispatch is mutating, a workspace provider is in play, and
// the task has no claims recorded at all: a non-mutating dispatch or a
// scheduler with no workspace provider never requires a claim set.
export function claimSetComplete(db: DatabaseSync, input: ClaimSetCompleteInput): boolean {
  if (!input.mutating || !input.workspaceProviderPresent) return true;
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM claims WHERE run_id = ? AND task_id = ?`)
    .get(input.runId, input.taskId) as { n: number };
  return row.n > 0;
}

export interface WorktreeMatchesRecordedBaseInput {
  runId: string;
  taskId: string;
  heldBaseCommit: string | null;
}

// A pure store-and-argument computation: no Git call, no ref resolution. A
// task with no active worktrees row has nothing to match against. A task
// with one is eligible only when the scheduler currently holds an in-memory
// workspace handle for it whose base commit string-matches the row; an
// active row with no matching held handle is a leftover from an attempt the
// scheduler no longer tracks, and a leftover blocks dispatch.
export function worktreeMatchesRecordedBase(db: DatabaseSync, input: WorktreeMatchesRecordedBaseInput): boolean {
  const row = db
    .prepare(`SELECT base_commit FROM worktrees WHERE run_id = ? AND task_id = ? AND cleanup_state = 'active'`)
    .get(input.runId, input.taskId) as { base_commit: string } | undefined;
  if (!row) return true;
  return input.heldBaseCommit !== null && input.heldBaseCommit === row.base_commit;
}

// Priority filtering happens only after this conjunction: eligibility never
// bypasses dependencies, claims, or gates regardless of a task's priority.
export function isDispatchEligible(conditions: DispatchConditions): boolean {
  return (
    conditions.dependenciesSatisfied &&
    conditions.noUnresolvedBlockingQuestion &&
    conditions.stageInputArtifactsValid &&
    conditions.workerSlotAvailable &&
    conditions.claimSetComplete &&
    conditions.claimsDoNotOverlapActive &&
    conditions.vendorSlotAvailable &&
    conditions.readinessProbePassed &&
    conditions.worktreeMatchesRecordedBase &&
    conditions.noControllerOrIntegrationLockConflict
  );
}

export function nextAttemptRound(db: DatabaseSync, runId: string, taskId: string, stageId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(round) AS maxRound FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = ?`,
    )
    .get(runId, taskId, stageId) as { maxRound: number | null };
  return (row.maxRound ?? 0) + 1;
}

// A deterministic version tag for the inputs an attempt was dispatched
// against: two dispatches over identical task inputs share the same tag, so
// the idempotency key correctly recognizes them as the same attempt.
export function computeInputVersion(parts: Readonly<Record<string, string>>): string {
  const canonical = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${parts[key]}`)
    .join("\n");
  return sha256(canonical);
}

export interface AttemptRecordInput {
  attemptId: string;
  runId: string;
  taskId: string;
  stageId: string;
  role: string;
  round: number;
  inputVersion: string;
  vendor: string;
  model: string;
  configJson: string;
  mutating: boolean;
}

export type CreateAttemptResult =
  | { created: true; attemptId: string }
  | { created: false; reason: "duplicate" };

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed/.test(err.message)
  );
}

// The atomic half of goals spec 23.3: the INSERT and its idempotency-key
// uniqueness check happen inside one transaction. A second caller racing the
// same (run_id, task_id, stage_id, round, input_version) key observes the
// unique-index violation and returns `duplicate` rather than a second row.
export function createAttemptRecord(
  db: DatabaseSync,
  input: AttemptRecordInput,
  now: number,
): CreateAttemptResult {
  try {
    return withTransaction(db, () => {
      db.prepare(
        `INSERT INTO attempts
           (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, interrupt_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
      ).run(
        input.attemptId,
        input.runId,
        input.taskId,
        input.stageId,
        input.role,
        input.round,
        input.inputVersion,
        input.vendor,
        input.model,
        input.configJson,
        input.mutating ? 1 : 0,
        now,
      );
      appendEvent(db, {
        id: randomUUID(),
        run_id: input.runId,
        task_id: input.taskId,
        attempt_id: input.attemptId,
        type: "attempt.created",
        payload: JSON.stringify({ stageId: input.stageId, round: input.round }),
        created_at: now,
      });
      return { created: true, attemptId: input.attemptId };
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return { created: false, reason: "duplicate" };
    }
    throw err;
  }
}

export interface DispatchAttemptInput {
  runId: string;
  taskId: string;
  stageId: string;
  role: string;
  round: number;
  inputVersion: string;
  vendor: string;
  model: string;
  configJson: string;
  mutating: boolean;
  timeoutBudget: TimeoutBudget;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  packet: string;
}

export type DispatchOutcome =
  | { dispatched: true; attemptId: string; handle: ProcessHandle }
  | { dispatched: false; reason: "duplicate" };

// The full dispatch sequence: atomically create the attempt row, then invoke
// the adapter. A spawn failure after a successful create marks the attempt
// `failed` rather than leaving it `pending` forever; the row itself was
// already the sole reservation of this idempotency key, so no other caller
// can retry it as a fresh dispatch without a new round.
export async function dispatchAttempt(
  db: DatabaseSync,
  adapter: ProcessAdapter,
  input: DispatchAttemptInput,
  now: () => number,
): Promise<DispatchOutcome> {
  const attemptId = randomUUID();
  const created = createAttemptRecord(
    db,
    {
      attemptId,
      runId: input.runId,
      taskId: input.taskId,
      stageId: input.stageId,
      role: input.role,
      round: input.round,
      inputVersion: input.inputVersion,
      vendor: input.vendor,
      model: input.model,
      configJson: input.configJson,
      mutating: input.mutating,
    },
    now(),
  );

  if (!created.created) {
    return { dispatched: false, reason: "duplicate" };
  }

  const descriptor: AttemptDescriptor = {
    attemptId,
    runId: input.runId,
    taskId: input.taskId,
    stageId: input.stageId,
    roleId: input.role,
    timeoutBudget: input.timeoutBudget,
  };
  const surface: ExecutionSurface = {
    workingDirectory: input.workingDirectory,
    environment: input.environment,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };

  let handle: ProcessHandle;
  try {
    handle = await adapter.start(descriptor, input.packet, surface);
  } catch (err) {
    const failedAt = now();
    withTransaction(db, () => {
      db.prepare(`UPDATE attempts SET status = 'failed', ended_at = ? WHERE id = ?`).run(failedAt, attemptId);
      appendEvent(db, {
        id: randomUUID(),
        run_id: input.runId,
        task_id: input.taskId,
        attempt_id: attemptId,
        type: "attempt.spawn-failed",
        payload: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
        created_at: failedAt,
      });
    });
    throw err;
  }

  const startedAt = now();
  withTransaction(db, () => {
    db.prepare(`UPDATE attempts SET status = 'running', started_at = ? WHERE id = ?`).run(startedAt, attemptId);
    db.prepare(
      `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, worktree_id, heartbeat_at, started_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(randomUUID(), input.runId, attemptId, handle.pid, handle.pgid, startedAt, startedAt);
    appendEvent(db, {
      id: randomUUID(),
      run_id: input.runId,
      task_id: input.taskId,
      attempt_id: attemptId,
      type: "attempt.started",
      payload: JSON.stringify({ pid: handle.pid, pgid: handle.pgid }),
      created_at: startedAt,
    });
  });

  return { dispatched: true, attemptId, handle };
}

export function getAttempt(db: DatabaseSync, attemptId: string): AttemptRow | undefined {
  return db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(attemptId) as AttemptRow | undefined;
}
