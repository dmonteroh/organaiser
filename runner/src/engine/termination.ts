// The runner-owned process-group termination sequence: SIGTERM every recorded
// group, wait up to a grace window polling liveness, then SIGKILL whatever
// survives. Every group acted on comes from a caller-supplied list of pids
// read out of the `workers` table — this module never discovers a process by
// scanning, by name, or by parent traversal.

import { groupAlive, signalGroup } from "../adapters/process-group.ts";

export interface TerminationReport {
  pgid: number;
  signalled: boolean;
  aliveAfterGrace: boolean;
  killed: boolean;
}

export interface TerminateGroupsOptions {
  graceMs: number;
  now?: () => number;
}

const GRACE_POLL_INTERVAL_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends SIGTERM to every group, then polls `groupAlive` at a short interval
// (rather than sleeping the full window) so a group that dies immediately is
// not waited on, then SIGKILLs whatever is still alive once the grace window
// elapses. `graceMs: 0` sends SIGTERM then SIGKILL with no wait at all. Pgids
// that are not a positive integer are dropped up front: `-0` and negative
// values would signal something other than the intended group.
export async function terminateGroups(
  pgids: readonly number[],
  opts: TerminateGroupsOptions,
): Promise<TerminationReport[]> {
  const now = opts.now ?? Date.now;
  const graceMs = Math.max(0, opts.graceMs);
  const targets = [...new Set(pgids)].filter((pgid) => Number.isInteger(pgid) && pgid > 0);

  const reports = new Map<number, TerminationReport>();
  for (const pgid of targets) {
    signalGroup(pgid, "SIGTERM");
    reports.set(pgid, { pgid, signalled: true, aliveAfterGrace: true, killed: false });
  }

  if (targets.length === 0) return [];

  const deadline = now() + graceMs;
  while (graceMs > 0 && now() < deadline) {
    if (!targets.some((pgid) => groupAlive(pgid))) break;
    await sleep(Math.min(GRACE_POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }

  for (const pgid of targets) {
    const report = reports.get(pgid) as TerminationReport;
    const alive = groupAlive(pgid);
    report.aliveAfterGrace = alive;
    if (alive) {
      signalGroup(pgid, "SIGKILL");
      report.killed = true;
    }
  }

  return targets.map((pgid) => reports.get(pgid) as TerminationReport);
}
