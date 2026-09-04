// Dispatch eligibility (goals spec section 12) and atomic dispatch (goals spec
// section 23.3). Eligibility is expressed as ten named conditions rather than
// section 12's nine bullets: "a worker slot and vendor slot are available" is
// two independent conditions, split here so each can be toggled on its own.
// Four are evaluated for real in P5's scope; six are hard-coded to their
// permissive value behind a marker naming the phase that replaces them.
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

  // Out of P5 scope: hard-coded permissive, named for a later phase.
  claimSetComplete: boolean; // P7: claim-set assignment is not implemented.
  claimsDoNotOverlapActive: boolean; // P7: claim overlap checking is not implemented.
  vendorSlotAvailable: boolean; // P6: per-vendor concurrency slots are not implemented.
  readinessProbePassed: boolean; // P6: readiness-probe-gated dispatch is not implemented.
  worktreeMatchesRecordedBase: boolean; // P7: worktrees are not implemented.
  noControllerOrIntegrationLockConflict: boolean; // P8: controller/integration lock arbitration is not implemented.
}

export function permissiveOutOfScopeConditions(): Pick<
  DispatchConditions,
  | "claimSetComplete"
  | "claimsDoNotOverlapActive"
  | "vendorSlotAvailable"
  | "readinessProbePassed"
  | "worktreeMatchesRecordedBase"
  | "noControllerOrIntegrationLockConflict"
> {
  return {
    claimSetComplete: true, // P7:
    claimsDoNotOverlapActive: true, // P7:
    vendorSlotAvailable: true, // P6:
    readinessProbePassed: true, // P6:
    worktreeMatchesRecordedBase: true, // P7:
    noControllerOrIntegrationLockConflict: true, // P8:
  };
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
