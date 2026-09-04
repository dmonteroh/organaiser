// The tick shell: the fixed seam between "keeping the run alive and obeying
// the operator" (this module) and "deciding what the board should do next"
// (a TickBody supplied by the caller, P5d in production). This file owns lease
// renewal, control-row read/ack, resting-state exit, and the bounded polling
// window used while waiting on operator input at `waiting-operator`. It never
// decides board transitions.
//
// Every deadline here is derived from the injected `now()` passed into
// runTickShell (or Date.now by default): no bare Date.now() call appears
// below. The per-tick wait on an `active` outcome uses a real timer (it is
// ordinary loop pacing, not a lease or window deadline), but it is always
// abortable via the shell's own AbortSignal so a pause/cancel is not delayed
// by a slow tick interval.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { renewLease, releaseLease } from "../store/lease.ts";
import { appendEvent } from "../store/events.ts";
import type { ControlRow } from "../store/types.ts";

export type RestingRunState =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "paused"
  | "waiting-operator"
  | "blocked";

export interface TickContext {
  db: DatabaseSync;
  runId: string;
  tickIndex: number;
  now: () => number;
  leaseDeadlineMs: number;
  signal: AbortSignal;
}

export type TickOutcome =
  | { kind: "progress" }
  | { kind: "active" }
  | { kind: "resting"; state: RestingRunState; reason: string | null };

export type TickBody = (ctx: TickContext) => Promise<TickOutcome>;

export interface SupervisorExit {
  state: RestingRunState;
  exitCode: number;
}

export interface RunTickShellOptions {
  db: DatabaseSync;
  runId: string;
  body: TickBody;
  tickIntervalMs: number;
  operatorPollWindowMs: number;
  now?: () => number;
}

export const DEFAULT_TICK_INTERVAL_MS = 1000;
export const DEFAULT_OPERATOR_POLL_WINDOW_MS = 300000;

// At least one poll always happens, and a window shorter than one tick
// interval yields exactly one poll and then exit.
export function computeOperatorPollCount(operatorPollWindowMs: number, tickIntervalMs: number): number {
  return Math.max(1, Math.ceil(operatorPollWindowMs / tickIntervalMs));
}

export class RunnerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerInvariantError";
  }
}

// A fixed outcome (or a short scripted sequence, whose last entry repeats once
// exhausted) for driving the shell in tests before P5d's scheduler body lands.
export function restingStubBody(outcomes: TickOutcome | readonly TickOutcome[]): TickBody {
  const sequence = Array.isArray(outcomes) ? outcomes : [outcomes as TickOutcome];
  let index = 0;
  return async () => {
    const outcome = sequence[Math.min(index, sequence.length - 1)] as TickOutcome;
    index += 1;
    return outcome;
  };
}

function countLiveWorkers(db: DatabaseSync, runId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL`)
    .get(runId) as { n: number };
  return row.n;
}

function readUnackedControlRows(db: DatabaseSync, runId: string): ControlRow[] {
  return db
    .prepare(`SELECT * FROM control WHERE run_id = ? AND acked_at IS NULL ORDER BY created_at ASC, id ASC`)
    .all(runId) as unknown as ControlRow[];
}

// pause/cancel (and their -now variants, applied identically at this layer:
// the forceful group-termination those variants additionally demand is P5e's
// job, not this shell's) set the abort signal and the run's desired state.
// resume replaces the controller with a fresh, unaborted one and restores the
// desired state to running. Runs inside the caller's own transaction so the
// ack and the effect commit atomically with every other row in the batch.
function applyControlRow(db: DatabaseSync, runId: string, row: ControlRow, controller: { current: AbortController }): void {
  if (row.kind === "pause" || row.kind === "pause-now") {
    if (!controller.current.signal.aborted) controller.current.abort();
    db.prepare(`UPDATE runs SET desired_state = ? WHERE id = ?`).run("paused", runId);
  } else if (row.kind === "cancel" || row.kind === "cancel-now") {
    if (!controller.current.signal.aborted) controller.current.abort();
    db.prepare(`UPDATE runs SET desired_state = ? WHERE id = ?`).run("cancelled", runId);
  } else if (row.kind === "resume") {
    controller.current = new AbortController();
    db.prepare(`UPDATE runs SET desired_state = ? WHERE id = ?`).run("running", runId);
  }
}

function readAndAckControlRows(db: DatabaseSync, runId: string, now: number, controller: { current: AbortController }): void {
  const rows = readUnackedControlRows(db, runId);
  if (rows.length === 0) return;
  for (const row of rows) {
    db.exec("BEGIN IMMEDIATE");
    try {
      applyControlRow(db, runId, row, controller);
      db.prepare(`UPDATE control SET acked_at = ? WHERE id = ?`).run(now, row.id);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // rollback failure is secondary to the original error
      }
      throw err;
    }
  }
}

function recordRunStateDurable(
  db: DatabaseSync,
  runId: string,
  state: RestingRunState,
  reason: string | null,
  now: number,
): void {
  const isTerminal = state === "succeeded" || state === "failed" || state === "cancelled";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `UPDATE runs SET state = ?, terminal_reason = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
    ).run(state, reason, isTerminal ? now : null, runId);
    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      type: "run.resting",
      payload: JSON.stringify({ state, reason }),
      created_at: now,
    });
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback failure is secondary to the original error
    }
    throw err;
  }
}

function waitCapped(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function onAbort(): void {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface PollState {
  pollsDone: number;
}

export async function runTickShell(opts: RunTickShellOptions): Promise<SupervisorExit> {
  const now = opts.now ?? Date.now;
  const ownerPid = process.pid;
  const controller = { current: new AbortController() };
  let tickIndex = 0;
  let pollState: PollState | null = null;

  while (true) {
    const lease = renewLease(opts.db, { runId: opts.runId, ownerPid, now });
    const renewedAtMs = lease.heartbeat_at;

    const leaseDeadlineMs = renewedAtMs + 3 * opts.tickIntervalMs;

    readAndAckControlRows(opts.db, opts.runId, renewedAtMs, controller);

    const ctx: TickContext = {
      db: opts.db,
      runId: opts.runId,
      tickIndex,
      now,
      leaseDeadlineMs,
      signal: controller.current.signal,
    };

    const outcome = await opts.body(ctx);

    if (outcome.kind === "resting" && outcome.state === "waiting-operator") {
      const liveWorkers = countLiveWorkers(opts.db, opts.runId);
      if (liveWorkers > 0) {
        throw new RunnerInvariantError(
          `waiting-operator with ${liveWorkers} live worker row(s) for run ${opts.runId}: a live worker means the outcome should have been "active"`,
        );
      }

      if (pollState === null) {
        pollState = { pollsDone: 0 };
        recordRunStateDurable(opts.db, opts.runId, "waiting-operator", outcome.reason, renewedAtMs);
      }
      pollState.pollsDone += 1;

      const pollCount = computeOperatorPollCount(opts.operatorPollWindowMs, opts.tickIntervalMs);
      if (pollState.pollsDone >= pollCount) {
        releaseLease(opts.db, { runId: opts.runId, ownerPid, now });
        return { state: "waiting-operator", exitCode: 0 };
      }

      await waitCapped(opts.tickIntervalMs, controller.current.signal);
      tickIndex += 1;
      continue;
    }

    pollState = null;

    if (outcome.kind === "progress") {
      tickIndex += 1;
      continue;
    }

    if (outcome.kind === "active") {
      await waitCapped(opts.tickIntervalMs, controller.current.signal);
      tickIndex += 1;
      continue;
    }

    recordRunStateDurable(opts.db, opts.runId, outcome.state, outcome.reason, renewedAtMs);
    releaseLease(opts.db, { runId: opts.runId, ownerPid, now });
    return { state: outcome.state, exitCode: 0 };
  }
}
