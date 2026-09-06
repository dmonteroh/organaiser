// The fixture suite's own supervisor entry point: structurally identical to
// `src/engine/supervisor.ts` (same lease-acquire / reconcile / tick-shell
// sequence, same exit-4-on-any-error fallback), but with its tick interval,
// operator-poll window, cancel grace, and `FakeAdapter` stream directory all
// taken from argv instead of `tick.ts`/`control-commands.ts`'s
// production defaults — the ten fixtures need real wall-clock windows
// measured in tens of milliseconds, not this phase's 1-second tick / 5-minute
// operator-poll production defaults. `createSchedulerTick`, `FakeAdapter`,
// `runTickShell`, and `withOperatorTermination` are the same P5b/P5c/P5d
// exports `supervisor.ts` itself wires together; this file is composition,
// not a reimplementation of any of them.

import { fileURLToPath } from "node:url";

import { openStore } from "../../src/store/db.ts";
import { acquireLease, releaseLease } from "../../src/store/lease.ts";
import { reconcile } from "../../src/engine/reconcile.ts";
import { createSchedulerTick, DEFAULT_SCHEDULER_STEPS, type WorkspaceProvider } from "../../src/engine/scheduler.ts";
import { runTickShell } from "../../src/engine/tick.ts";
import { withOperatorTermination } from "../../src/engine/control-commands.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../../src/adapters/adapter.ts";
import { DEFAULT_WORKTREE_ROOT, DEFAULT_BRANCH_PREFIX } from "../../src/git/workspace.ts";

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Real SIGTERM-then-SIGKILL escalation over the group `FakeAdapter.start`
// actually spawned, mirroring `fake-adapter.test.ts`'s own `terminate`.
const terminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && groupAlive(pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (groupAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return { signalSent: "SIGTERM", exitCode: null, killedProcessTree: !groupAlive(pgid), timedOutWaitingForExit: groupAlive(pgid) };
};

export interface TestSupervisorArgs {
  root: string;
  runId: string;
  tickIntervalMs: number;
  operatorPollWindowMs: number;
  cancelGraceMs: number;
  streamsDir: string;
  workspaceMode: "none" | "worktree" | "in-place";
}

export function parseArgs(argv: readonly string[]): TestSupervisorArgs {
  const [root, runId, tickIntervalMs, operatorPollWindowMs, cancelGraceMs, streamsDir, workspaceModeArg] = argv;
  if (!root || !runId || !tickIntervalMs || !operatorPollWindowMs || !cancelGraceMs || !streamsDir) {
    throw new Error(
      "usage: test-supervisor.ts <root> <runId> <tickIntervalMs> <operatorPollWindowMs> <cancelGraceMs> <streamsDir> [workspaceMode]",
    );
  }
  const workspaceMode = workspaceModeArg === undefined ? "none" : workspaceModeArg;
  if (workspaceMode !== "none" && workspaceMode !== "worktree" && workspaceMode !== "in-place") {
    throw new Error(
      `usage: workspaceMode must be "none", "worktree", or "in-place", got ${JSON.stringify(workspaceModeArg)}`,
    );
  }
  return {
    root,
    runId,
    tickIntervalMs: Number(tickIntervalMs),
    operatorPollWindowMs: Number(operatorPollWindowMs),
    cancelGraceMs: Number(cancelGraceMs),
    streamsDir,
    workspaceMode,
  };
}

// Deterministic per fixture: a task's scenario is its own id, so a stream
// file named `<stageId>--<taskId>.jsonl` under the fixture's own streams
// directory is exactly what a given task's attempt replays.
function scenarioFor(attempt: AttemptDescriptor): string {
  return attempt.taskId;
}

function isLockedError(err: unknown): boolean {
  return err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message);
}

// `openStore`'s own `PRAGMA busy_timeout` (`db.ts`, P5a) only applies once a
// connection is open; a fresh connection's very first pragma
// (`journal_mode = WAL`) can itself observe "database is locked" against
// another process's write, before that timeout is in effect. Several
// fixtures spawn more than one of these processes in quick succession
// against the same store, so this absorbs that one narrow startup race
// rather than letting it masquerade as a stale-lease failure.
function openStoreWithRetry(root: string): ReturnType<typeof openStore> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      return openStore(root);
    } catch (err) {
      if (!isLockedError(err) || Date.now() >= deadline) throw err;
    }
  }
}

export async function runTestSupervisor(args: TestSupervisorArgs): Promise<number> {
  const db = openStoreWithRetry(args.root);
  const adapter = new FakeAdapter({ terminate, streamsDir: args.streamsDir, scenarioFor });

  try {
    acquireLease(db, {
      runId: args.runId,
      ownerPid: process.pid,
      tickIntervalMs: args.tickIntervalMs,
      now: Date.now,
    });

    reconcile(db, {
      runId: args.runId,
      now: Date.now,
      staleThresholdMs: 3 * args.tickIntervalMs,
    });

    const heartbeatTimer = setInterval(() => {
      process.stderr.write(`[test-supervisor] run ${args.runId} heartbeat at ${Date.now()}\n`);
    }, args.tickIntervalMs);

    const workspace: WorkspaceProvider | undefined =
      args.workspaceMode === "worktree" || args.workspaceMode === "in-place"
        ? {
            projectRoot: args.root,
            root: DEFAULT_WORKTREE_ROOT,
            branchPrefix: DEFAULT_BRANCH_PREFIX,
            mode: args.workspaceMode,
          }
        : undefined;

    let exitCode: number;
    try {
      const exit = await runTickShell({
        db,
        runId: args.runId,
        body: withOperatorTermination(createSchedulerTick(adapter, DEFAULT_SCHEDULER_STEPS, workspace), {
          installSigtermTrap: true,
          defaultCancelGraceMs: args.cancelGraceMs,
        }),
        tickIntervalMs: args.tickIntervalMs,
        operatorPollWindowMs: args.operatorPollWindowMs,
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
      // best-effort
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
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runTestSupervisor(parseArgs(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[test-supervisor] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(4);
    });
}
