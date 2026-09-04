// The operator control commands that stop work: `run pause`, `run cancel`,
// `run kill`, `kill-all`, and the `Ctrl-C` handler for `--foreground` mode.
// `pauseRun`/`cancelRun` only record intent (a `control` row, plus a SIGTERM
// nudge to the supervisor process for cancel) — the supervisor itself, via
// `withOperatorTermination`, is what actually walks `terminateGroups` over
// the worker groups it finds recorded in SQLite. `killRun`/`killAll` and the
// foreground interrupt handler assume no live supervisor and do that walk
// themselves, reading straight from SQLite.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { reconcile } from "./reconcile.ts";
import type { TickBody, TickContext, TickOutcome } from "./tick.ts";
import { DEFAULT_TICK_INTERVAL_MS } from "./tick.ts";
import { terminateGroups, type TerminationReport } from "./termination.ts";
import type { ControlKind, InterruptReason, RunRow, WorkerRow } from "../store/types.ts";

export const DEFAULT_CANCEL_GRACE_MS = 10000;

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);

function nowOr(now?: () => number): () => number {
  return now ?? Date.now;
}

function readRun(db: DatabaseSync, runId: string): RunRow {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
  if (!row) throw new Error(`no run row for ${runId}`);
  return row;
}

function readLiveWorkers(db: DatabaseSync, runId: string): WorkerRow[] {
  return db
    .prepare(`SELECT * FROM workers WHERE run_id = ? AND termination_state IS NULL`)
    .all(runId) as unknown as WorkerRow[];
}

function hasUnackedControl(db: DatabaseSync, runId: string, kind: ControlKind): boolean {
  const row = db
    .prepare(`SELECT 1 FROM control WHERE run_id = ? AND kind = ? AND acked_at IS NULL LIMIT 1`)
    .get(runId, kind);
  return row !== undefined;
}

function insertControlRow(db: DatabaseSync, runId: string, kind: ControlKind, now: number): string {
  const id = randomUUID();
  withTransaction(db, () => {
    db.prepare(`INSERT INTO control (id, run_id, kind, created_at) VALUES (?, ?, ?, ?)`).run(
      id,
      runId,
      kind,
      now,
    );
    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      type: "control.requested",
      payload: JSON.stringify({ kind }),
      created_at: now,
    });
  });
  return id;
}

function readActiveLeaseOwnerPid(db: DatabaseSync, runId: string): number | null {
  const row = db
    .prepare(`SELECT owner_pid FROM locks WHERE kind = 'run-lease' AND resource = ? AND released_at IS NULL`)
    .get(runId) as { owner_pid: number } | undefined;
  return row ? row.owner_pid : null;
}

function releaseAnyActiveLease(db: DatabaseSync, runId: string, now: number): void {
  db.prepare(
    `UPDATE locks SET released_at = ? WHERE kind = 'run-lease' AND resource = ? AND released_at IS NULL`,
  ).run(now, runId);
}

// Sends SIGTERM to every group recorded for the run's still-live workers,
// marks each of them `signalled`, and marks the attempt that owns each of
// them `interrupted`. Writes exactly one event summarizing the batch. Used
// both by the live-supervisor tick-body wrapper (awaited normally) and by
// the no-supervisor kill commands.
async function terminateLiveWorkers(
  db: DatabaseSync,
  runId: string,
  opts: { graceMs: number; now: () => number; reason: InterruptReason },
): Promise<{ workers: WorkerRow[]; reports: TerminationReport[] }> {
  const workers = readLiveWorkers(db, runId);
  const pgids = workers.map((worker) => worker.pgid);
  const reports = await terminateGroups(pgids, { graceMs: opts.graceMs, now: opts.now });

  const nowMs = opts.now();
  withTransaction(db, () => {
    for (const worker of workers) {
      db.prepare(`UPDATE workers SET termination_state = 'signalled', ended_at = ? WHERE id = ?`).run(
        nowMs,
        worker.id,
      );
      db.prepare(
        `UPDATE attempts SET status = 'interrupted', interrupt_reason = ?, ended_at = ? WHERE id = ? AND status != 'interrupted'`,
      ).run(opts.reason, nowMs, worker.attempt_id);
    }
    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      type: "run.terminated",
      payload: JSON.stringify({ reason: opts.reason, workerCount: workers.length }),
      created_at: nowMs,
    });
  });

  return { workers, reports };
}

// Synchronous twin of `terminateLiveWorkers`, for the one call site
// (`installForegroundInterruptHandler`) that must not `await` anything: a
// SIGINT delivered to a `--foreground` run reaches this handler and
// `process-supervisor.ts`'s own `installParentExitCleanup` handler in the
// same synchronous listener pass, and that second handler hard-exits with no
// durable record. `terminateGroups(pgids, { graceMs: 0 })` never awaits
// internally, so calling it here (ignoring the promise it returns, since its
// synchronous body has already run every signal by the time the call
// expression completes) keeps this whole path synchronous end to end.
function terminateLiveWorkersSync(
  db: DatabaseSync,
  runId: string,
  reason: InterruptReason,
  now: () => number,
): void {
  const workers = readLiveWorkers(db, runId);
  const pgids = workers.map((worker) => worker.pgid);
  void terminateGroups(pgids, { graceMs: 0, now }).catch(() => {});

  const nowMs = now();
  withTransaction(db, () => {
    for (const worker of workers) {
      db.prepare(`UPDATE workers SET termination_state = 'signalled', ended_at = ? WHERE id = ?`).run(
        nowMs,
        worker.id,
      );
      db.prepare(
        `UPDATE attempts SET status = 'interrupted', interrupt_reason = ?, ended_at = ? WHERE id = ? AND status != 'interrupted'`,
      ).run(reason, nowMs, worker.attempt_id);
    }
    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      type: "run.terminated",
      payload: JSON.stringify({ reason, workerCount: workers.length }),
      created_at: nowMs,
    });
  });
}

export interface PauseCancelOptions {
  runId: string;
  now?: () => number;
  immediate?: boolean;
}

export interface ControlCommandResult {
  ok: true;
  inserted: boolean;
  controlId: string | null;
}

// Records intent only: inserts a `pause`/`pause-now` control row for the tick
// shell (already shipped in P5b) to ack and act on. Never terminates a
// worker itself — a plain pause lets in-flight attempts finish naturally.
export function pauseRun(db: DatabaseSync, opts: PauseCancelOptions): ControlCommandResult {
  const now = nowOr(opts.now);
  const run = readRun(db, opts.runId);
  if ((run.state as string) === "paused") return { ok: true, inserted: false, controlId: null };

  const kind: ControlKind = opts.immediate ? "pause-now" : "pause";
  if (hasUnackedControl(db, opts.runId, kind)) return { ok: true, inserted: false, controlId: null };

  const controlId = insertControlRow(db, opts.runId, kind, now());
  return { ok: true, inserted: true, controlId };
}

// Records intent and, when a live supervisor holds the run lease, nudges it
// with SIGTERM so it does not wait a full tick interval to notice the
// control row. Termination of the worker groups themselves is the live
// supervisor's job (`withOperatorTermination`) or, with no live supervisor,
// `killRun`'s.
export function cancelRun(db: DatabaseSync, opts: PauseCancelOptions): ControlCommandResult {
  const now = nowOr(opts.now);
  const run = readRun(db, opts.runId);
  if (run.state === "cancelled") return { ok: true, inserted: false, controlId: null };

  const kind: ControlKind = opts.immediate ? "cancel-now" : "cancel";
  if (hasUnackedControl(db, opts.runId, kind)) return { ok: true, inserted: false, controlId: null };

  const controlId = insertControlRow(db, opts.runId, kind, now());

  const supervisorPid = readActiveLeaseOwnerPid(db, opts.runId);
  if (supervisorPid !== null) {
    try {
      process.kill(supervisorPid, "SIGTERM");
    } catch {
      // best-effort nudge only: the control row is the durable record, so a
      // signal delivery failure (already gone, not permitted) never blocks
      // recording the request.
    }
  }

  return { ok: true, inserted: true, controlId };
}

export interface KillOptions {
  runId: string;
  now?: () => number;
  graceMs?: number;
}

export interface KillResult {
  ok: true;
  workers: TerminationReport[];
}

// Assumes no live supervisor: reads recorded pids/pgids straight from SQLite
// and terminates them directly, then finalizes the run itself (a live
// supervisor would otherwise be the one recording its own terminal state).
export async function killRun(db: DatabaseSync, opts: KillOptions): Promise<KillResult> {
  const now = nowOr(opts.now);
  const run = readRun(db, opts.runId);
  if (TERMINAL_RUN_STATES.has(run.state)) return { ok: true, workers: [] };

  const graceMs = opts.graceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const { reports } = await terminateLiveWorkers(db, opts.runId, {
    graceMs,
    now,
    reason: "operator-cancel",
  });

  const nowMs = now();
  withTransaction(db, () => {
    releaseAnyActiveLease(db, opts.runId, nowMs);
    db.prepare(
      `UPDATE runs SET state = 'cancelled', terminal_reason = 'operator-cancel', ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
    ).run(nowMs, opts.runId);
  });

  return { ok: true, workers: reports };
}

export interface KillAllOptions {
  now?: () => number;
  graceMs?: number;
}

// Kills every non-terminal run, one at a time, via `killRun`.
export async function killAll(db: DatabaseSync, opts: KillAllOptions = {}): Promise<Map<string, KillResult>> {
  const runIds = (
    db.prepare(`SELECT id FROM runs WHERE state NOT IN ('succeeded', 'failed', 'cancelled')`).all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);

  const results = new Map<string, KillResult>();
  for (const runId of runIds) {
    results.set(runId, await killRun(db, { runId, now: opts.now, graceMs: opts.graceMs }));
  }
  return results;
}

function readLastControlKind(db: DatabaseSync, runId: string): ControlKind | null {
  const row = db
    .prepare(`SELECT kind FROM control WHERE run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(runId) as { kind: ControlKind } | undefined;
  return row ? row.kind : null;
}

export interface WithOperatorTerminationOptions {
  now?: () => number;
  defaultCancelGraceMs?: number;
  installSigtermTrap?: boolean;
}

let sigtermTrapInstalled = false;

// `cancelRun` sends the live supervisor a SIGTERM nudge (AC-mandated) so it
// does not have to wait a full tick interval to notice the control row it
// already wrote. With nothing else trapping SIGTERM at supervisor startup,
// the OS default disposition would terminate the process outright before it
// ever reaches its next tick, dropping the control row on the floor. This
// no-op trap only prevents that default kill: the actual termination
// sequence still runs from the ordinary tick loop below, once it observes
// the abort.
function installSigtermTrapOnce(): void {
  if (sigtermTrapInstalled) return;
  sigtermTrapInstalled = true;
  process.on("SIGTERM", () => {});
}

// The tick-body wrapper the supervisor registers: once `ctx.signal` is
// aborted by an acknowledged `pause`/`pause-now`/`cancel`/`cancel-now`
// control row (P5b's `applyControlRow` already does the abort and the
// `desired_state` write; it does not terminate anything), this decides
// whether the abort demands forceful termination and, if so, drives it
// before handing back the resting outcome the tick shell records.
export function withOperatorTermination(inner: TickBody, opts: WithOperatorTerminationOptions = {}): TickBody {
  const now = nowOr(opts.now);
  const defaultCancelGraceMs = opts.defaultCancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  if (opts.installSigtermTrap) installSigtermTrapOnce();

  return async (ctx: TickContext): Promise<TickOutcome> => {
    if (!ctx.signal.aborted) return inner(ctx);

    const run = readRun(ctx.db, ctx.runId);
    const lastKind = readLastControlKind(ctx.db, ctx.runId);

    if (run.desired_state === "cancelled") {
      ctx.db.prepare(`UPDATE runs SET state = 'cancelling' WHERE id = ?`).run(ctx.runId);
      const graceMs = lastKind === "cancel-now" ? 0 : defaultCancelGraceMs;
      await terminateLiveWorkers(ctx.db, ctx.runId, { graceMs, now, reason: "operator-cancel" });
      reconcile(ctx.db, { runId: ctx.runId, now, staleThresholdMs: 3 * DEFAULT_TICK_INTERVAL_MS });
      return { kind: "resting", state: "cancelled", reason: "operator-cancel" };
    }

    if (run.desired_state === "paused") {
      if (lastKind === "pause-now") {
        await terminateLiveWorkers(ctx.db, ctx.runId, { graceMs: 0, now, reason: "operator-pause" });
        reconcile(ctx.db, { runId: ctx.runId, now, staleThresholdMs: 3 * DEFAULT_TICK_INTERVAL_MS });
        return { kind: "resting", state: "paused", reason: null };
      }
      const liveWorkers = readLiveWorkers(ctx.db, ctx.runId);
      if (liveWorkers.length > 0) return { kind: "active" };
      return { kind: "resting", state: "paused", reason: null };
    }

    return inner(ctx);
  };
}

export interface ForegroundInterruptContext {
  db: DatabaseSync;
  runId: string;
  now?: () => number;
}

// Installed by P5f's `--foreground` code path before the first attempt is
// spawned, so it sits ahead of `process-supervisor.ts`'s own
// `installParentExitCleanup`, registered lazily on the first
// `superviseProcess` call. `process.on` invokes same-event listeners
// synchronously in registration order and does not await what an earlier one
// returns, so this handler calls `process.exit` itself as its last
// synchronous statement: that is what keeps the later, non-durable handler
// from ever running for this signal.
export function installForegroundInterruptHandler(ctx: ForegroundInterruptContext): () => void {
  const now = nowOr(ctx.now);

  function handleSigint(): void {
    const nowMs = now();
    const run = readRun(ctx.db, ctx.runId);
    if (run.state === "cancelled") {
      process.exit(130);
      return;
    }

    withTransaction(ctx.db, () => {
      ctx.db.prepare(`UPDATE runs SET state = 'cancelling' WHERE id = ?`).run(ctx.runId);
      appendEvent(ctx.db, {
        id: randomUUID(),
        run_id: ctx.runId,
        type: "run.resting",
        payload: JSON.stringify({ state: "cancelling", reason: "operator-cancel" }),
        created_at: nowMs,
      });
    });

    terminateLiveWorkersSync(ctx.db, ctx.runId, "operator-cancel", now);

    const endMs = now();
    withTransaction(ctx.db, () => {
      releaseAnyActiveLease(ctx.db, ctx.runId, endMs);
      ctx.db
        .prepare(
          `UPDATE runs SET state = 'cancelled', terminal_reason = 'operator-cancel', ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
        )
        .run(endMs, ctx.runId);
      appendEvent(ctx.db, {
        id: randomUUID(),
        run_id: ctx.runId,
        type: "run.resting",
        payload: JSON.stringify({ state: "cancelled", reason: "operator-cancel" }),
        created_at: endMs,
      });
    });

    process.exit(130);
  }

  process.on("SIGINT", handleSigint);
  return () => process.removeListener("SIGINT", handleSigint);
}
