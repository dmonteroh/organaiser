// Supervisor process entry point. Spawned detached by supervisor-spawn.ts's
// startRun, it owns the only process.exit call in this child: it opens the
// store, acquires the run lease, runs startup reconciliation, then hands
// control to runTickShell. Every error from lease acquisition or the tick
// shell — a lease-acquire failure, a lease lost mid-run, or a thrown
// RunnerInvariantError — is caught here and mapped to exit code 4, per the
// process-health scheme fixed by tick.ts.
//
// Until P5d lands, the scheduler body is `restingStubBody`, fixed to
// `active`: there is nothing yet that can decide a real transition, and
// claiming any resting state (including `blocked`) would assert something
// this supervisor cannot yet know. `active` keeps the process ticking and
// alive — obeying the operator and holding the run open — until P5d's real
// body is wired in. This stays a stub for tests; production wiring swaps in
// P5d's real body.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { openStore } from "../store/db.ts";
import { acquireLease, releaseLease } from "../store/lease.ts";
import { reconcile } from "./reconcile.ts";
import { createProductionSchedulerTick } from "./scheduler.ts";
import {
  runTickShell,
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_OPERATOR_POLL_WINDOW_MS,
} from "./tick.ts";
import { withOperatorTermination } from "./control-commands.ts";

export interface SupervisorArgs {
  root: string;
  runId: string;
}

export function parseSupervisorArgv(argv: readonly string[]): SupervisorArgs {
  const [root, runId] = argv;
  if (!root || !runId) {
    throw new Error("usage: supervisor.ts <root> <runId>");
  }
  return { root, runId };
}

export async function runSupervisor(args: SupervisorArgs): Promise<number> {
  const db = openStore(args.root);
  const tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
  const operatorPollWindowMs = DEFAULT_OPERATOR_POLL_WINDOW_MS;

  try {
    acquireLease(db, {
      runId: args.runId,
      ownerPid: process.pid,
      tickIntervalMs,
      now: Date.now,
    });

    reconcile(db, {
      runId: args.runId,
      now: Date.now,
      staleThresholdMs: 3 * tickIntervalMs,
    });

    // Operational visibility for a detached, otherwise-silent process: one
    // line per tick interval to stderr, which spawn's stdio wiring already
    // points at supervisor.log. Cleared as soon as runTickShell settles.
    const heartbeatTimer = setInterval(() => {
      process.stderr.write(`[supervisor] run ${args.runId} heartbeat at ${Date.now()}\n`);
    }, tickIntervalMs);

    let exitCode: number;
    try {
      const body = await createProductionSchedulerTick({ db, runId: args.runId, root: args.root, env: process.env });
      const exit = await runTickShell({
        db,
        runId: args.runId,
        body: withOperatorTermination(body, { installSigtermTrap: true }),
        tickIntervalMs,
        operatorPollWindowMs,
      });
      exitCode = exit.exitCode;
    } finally {
      clearInterval(heartbeatTimer);
    }

    return exitCode;
  } catch {
    try {
      releaseLease(db, { runId: args.runId, ownerPid: process.pid, now: Date.now });
    } catch {
      // best-effort: if the lease is already gone or owned elsewhere there is
      // nothing left to release.
    }
    return 4;
  } finally {
    db.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runSupervisor(parseSupervisorArgv(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch(() => process.exit(4));
}
