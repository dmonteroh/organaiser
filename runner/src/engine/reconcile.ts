// Startup reconciliation (goals spec 23.1): on supervisor startup, after the
// lease is acquired and before any dispatch, every non-terminal `workers` and
// `attempts` record is classified against the observed system.
//
// classifyWorker is a pure function over already-gathered facts, mirroring
// predicates.ts's accept(facts) shape: no filesystem, database, or
// process-liveness call happens inside it. All of that I/O lives in
// `reconcile`, the sole exported function that touches the store or the
// system process table.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { AttemptRow, InterruptReason, TerminationState, WorkerRow } from "../store/types.ts";

export type WorkerClassification = "live" | "exited" | "stale" | "indeterminate";

export interface ClassifyFacts {
  pidAlive: boolean;
  groupAlive: boolean;
  heartbeatAgeMs: number;
  staleThresholdMs: number;
  worktreeExpected: boolean;
  worktreePresent: boolean;
}

// Four-way classification, in priority order: a missing expected worktree is
// never trustworthy regardless of process liveness; a process reporting dead
// on both the pid and its group is exited; a heartbeat older than the stale
// threshold is stale even if the process still answers (it may be a hung
// process or a different process that reused the pid); a pid/group pair that
// agrees and is within the threshold is live; anything else (pid and group
// liveness disagree) is indeterminate.
export function classifyWorker(facts: ClassifyFacts): WorkerClassification {
  if (facts.worktreeExpected && !facts.worktreePresent) return "indeterminate";
  if (!facts.pidAlive && !facts.groupAlive) return "exited";
  if (facts.heartbeatAgeMs >= facts.staleThresholdMs) return "stale";
  if (facts.pidAlive && facts.groupAlive) return "live";
  return "indeterminate";
}

// Goals spec 23.2: a crashed mutating worker requires worktree reconciliation
// first, which P5 does not implement, so a mutating attempt is never
// auto-redispatched regardless of its process classification.
export function interruptReasonFor(
  classification: WorkerClassification,
  mutating: boolean,
): InterruptReason | null {
  if (classification === "live") return null;
  if (mutating) return "indeterminate";
  if (classification === "exited") return "supervisor-crash";
  if (classification === "stale") return "stale-lease";
  return "indeterminate";
}

function terminationStateFor(classification: WorkerClassification): TerminationState | null {
  if (classification === "exited") return "exited";
  if (classification === "stale") return "reclaimed";
  return null;
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

export interface ReconcileOptions {
  runId: string;
  now: () => number;
  staleThresholdMs: number;
}

export interface ReconcileWorkerResult {
  workerId: string;
  attemptId: string;
  classification: WorkerClassification;
  interruptReason: InterruptReason | null;
}

export interface ReconcileResult {
  workers: ReconcileWorkerResult[];
}

export function reconcile(db: DatabaseSync, opts: ReconcileOptions): ReconcileResult {
  const nowMs = opts.now();
  const workers = db
    .prepare(`SELECT * FROM workers WHERE run_id = ? AND termination_state IS NULL`)
    .all(opts.runId) as unknown as WorkerRow[];

  const results: ReconcileWorkerResult[] = [];

  for (const worker of workers) {
    const attempt = db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(worker.attempt_id) as
      | AttemptRow
      | undefined;
    if (!attempt) continue;

    const worktreeExpected = worker.worktree_id !== null;
    const worktreePresent = worktreeExpected
      ? Boolean(
          db.prepare(`SELECT 1 FROM worktrees WHERE id = ?`).get(worker.worktree_id as string),
        )
      : false;

    const facts: ClassifyFacts = {
      pidAlive: pidAlive(worker.pid),
      groupAlive: groupAlive(worker.pgid),
      heartbeatAgeMs: nowMs - worker.heartbeat_at,
      staleThresholdMs: opts.staleThresholdMs,
      worktreeExpected,
      worktreePresent,
    };

    const classification = classifyWorker(facts);
    const interruptReason = interruptReasonFor(classification, attempt.mutating === 1);

    if (classification !== "live") {
      withTransaction(db, () => {
        const terminationState = terminationStateFor(classification);
        if (terminationState !== null) {
          db.prepare(
            `UPDATE workers SET termination_state = ?, ended_at = ? WHERE id = ?`,
          ).run(terminationState, nowMs, worker.id);
        }
        if (attempt.status !== "interrupted") {
          db.prepare(
            `UPDATE attempts SET status = 'interrupted', interrupt_reason = ?, ended_at = ? WHERE id = ?`,
          ).run(interruptReason, nowMs, attempt.id);
        }
        appendEvent(db, {
          id: randomUUID(),
          run_id: opts.runId,
          task_id: attempt.task_id,
          attempt_id: attempt.id,
          type: "reconcile.classified",
          payload: JSON.stringify({ classification, interruptReason }),
          created_at: nowMs,
        });
      });
    }

    results.push({
      workerId: worker.id,
      attemptId: attempt.id,
      classification,
      interruptReason,
    });
  }

  return { workers: results };
}
