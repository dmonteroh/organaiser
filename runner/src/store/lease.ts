// Run-lease primitives over the `locks` entity (kind = "run-lease", resource =
// run id). A lease's heartbeat is the sole staleness signal: a row older than
// `3 * tickIntervalMs` is reclaimable by a different owner. Every timestamp
// here comes from a caller-supplied `now()`; nothing in this module reads the
// system clock itself.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { withTransaction } from "./db.ts";
import type { LockRow } from "./types.ts";

const RUN_LEASE_KIND = "run-lease";

export class LeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseError";
  }
}

export class LeaseUnavailableError extends LeaseError {
  constructor(runId: string) {
    super(`run lease for ${runId} is held by another owner and is not stale`);
    this.name = "LeaseUnavailableError";
  }
}

export class LeaseLostError extends LeaseError {
  constructor(runId: string) {
    super(`run lease for ${runId} is no longer held by this owner`);
    this.name = "LeaseLostError";
  }
}

export function readActiveLease(db: DatabaseSync, runId: string): LockRow | null {
  const row = db
    .prepare(
      `SELECT * FROM locks WHERE kind = ? AND resource = ? AND released_at IS NULL`,
    )
    .get(RUN_LEASE_KIND, runId) as LockRow | undefined;
  return row ?? null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isSupervisorLive(
  db: DatabaseSync,
  { runId, tickIntervalMs, now }: { runId: string; tickIntervalMs: number; now: () => number },
): boolean {
  const existing = readActiveLease(db, runId);
  if (!existing) return false;
  const staleThresholdMs = 3 * tickIntervalMs;
  if (now() - existing.heartbeat_at > staleThresholdMs) return false;
  return pidAlive(existing.owner_pid);
}

function insertLease(db: DatabaseSync, runId: string, ownerPid: number, now: number): LockRow {
  const row: LockRow = {
    id: randomUUID(),
    run_id: runId,
    kind: RUN_LEASE_KIND,
    resource: runId,
    owner_pid: ownerPid,
    acquired_at: now,
    heartbeat_at: now,
    released_at: null,
  };
  db.prepare(
    `INSERT INTO locks (id, run_id, kind, resource, owner_pid, acquired_at, heartbeat_at, released_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.run_id, row.kind, row.resource, row.owner_pid, row.acquired_at, row.heartbeat_at, row.released_at);
  return row;
}

export interface AcquireLeaseOptions {
  runId: string;
  ownerPid: number;
  tickIntervalMs: number;
  now: () => number;
}

// Conditional insert-or-reclaim: succeeds when no active lease row exists, or
// when the existing row's heartbeat is at least `3 * tickIntervalMs` old.
// Throws LeaseUnavailableError when a fresher lease is held by someone else.
export function acquireLease(db: DatabaseSync, opts: AcquireLeaseOptions): LockRow {
  return withTransaction(db, () => {
    const existing = readActiveLease(db, opts.runId);
    const nowMs = opts.now();
    if (existing) {
      // "older than" is strict: a heartbeat exactly `3 * tickIntervalMs` old is
      // not yet stale.
      const staleThresholdMs = 3 * opts.tickIntervalMs;
      if (nowMs - existing.heartbeat_at <= staleThresholdMs) {
        throw new LeaseUnavailableError(opts.runId);
      }
      reclaimLease(db, existing, nowMs);
    }
    return insertLease(db, opts.runId, opts.ownerPid, nowMs);
  });
}

// Marks an existing lock row released so a fresh row can be inserted in its
// place. Callers are responsible for having already established staleness;
// this primitive performs no staleness check of its own.
export function reclaimLease(db: DatabaseSync, row: LockRow, now: number): void {
  db.prepare(`UPDATE locks SET released_at = ? WHERE id = ?`).run(now, row.id);
}

export interface RenewLeaseOptions {
  runId: string;
  ownerPid: number;
  now: () => number;
}

// Renews the heartbeat of the caller's own active lease. Throws LeaseLostError
// when no active row exists, or when the active row is owned by a different
// pid (another supervisor already reclaimed it).
export function renewLease(db: DatabaseSync, opts: RenewLeaseOptions): LockRow {
  return withTransaction(db, () => {
    const existing = readActiveLease(db, opts.runId);
    if (!existing || existing.owner_pid !== opts.ownerPid) {
      throw new LeaseLostError(opts.runId);
    }
    const heartbeatAt = opts.now();
    db.prepare(`UPDATE locks SET heartbeat_at = ? WHERE id = ?`).run(heartbeatAt, existing.id);
    return { ...existing, heartbeat_at: heartbeatAt };
  });
}

export interface ReleaseLeaseOptions {
  runId: string;
  ownerPid: number;
  now: () => number;
}

// Releases the caller's own active lease. A no-op (not an error) when the
// lease is already gone or owned by someone else, so shutdown paths can call
// it unconditionally.
export function releaseLease(db: DatabaseSync, opts: ReleaseLeaseOptions): void {
  withTransaction(db, () => {
    const existing = readActiveLease(db, opts.runId);
    if (!existing || existing.owner_pid !== opts.ownerPid) return;
    db.prepare(`UPDATE locks SET released_at = ? WHERE id = ?`).run(opts.now(), existing.id);
  });
}
