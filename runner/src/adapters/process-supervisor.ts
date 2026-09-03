// Progress-observing process watchdog.
//
// Replaces a wall-clock `timeout Ns` SIGKILL — which kills regardless of
// whether the orchestrator is making progress — with a supervisor that resets
// its deadline whenever an injected snapshot of structural progress changes, and
// kills only a genuinely stalled tree. Killing is complementary to acceptance: a
// killed attempt still leaves its commits on disk, so this module only needs to
// reliably detect stalls and reap the whole process group.
//
// The child is spawned `detached: true` so it leads its own process group; that
// is what makes `process.kill(-pid, sig)` reach the entire tree (child plus any
// grandchildren) rather than just the immediate child. There is intentionally no
// intermediate shell wrapper — a shell would become the group leader and the
// signal would not propagate to the orchestrator's descendants.
//
// Unit convention: every budget value is a number of SECONDS (matching the
// documented defaults). Internally each is multiplied by 1000 for the timer APIs.
// Tests pass fractional seconds (e.g. 0.05) so the whole suite runs in well under
// a second while exercising the same code paths as production.

import { spawn } from "node:child_process";

const OUTCOMES = {
  exitedClean: "exited_clean",
  exitedNonzero: "exited_nonzero",
  stalledKilled: "stalled_killed",
  ceilingExceeded: "ceiling_exceeded",
} as const;

export type Outcome = (typeof OUTCOMES)[keyof typeof OUTCOMES];

export interface Budgets {
  POLL_SECS: number;
  NO_PROGRESS_SECS: number;
  GRACE_SECS: number;
  HARD_CEILING_SECS: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  POLL_SECS: 15,
  NO_PROGRESS_SECS: 300,
  GRACE_SECS: 10,
  HARD_CEILING_SECS: 2400,
};

export interface RecordedProcess {
  pid: number;
  pgid: number;
}

export interface SuperviseProcessOptions {
  command: string;
  args?: readonly string[];
  snapshot?: () => unknown;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  budgets?: Partial<Budgets>;
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  recordProcess?: (info: RecordedProcess) => void;
}

export interface SuperviseProcessResult {
  outcome: Outcome;
  exitCode: number | null;
}

// ── Orphan defense: reap detached child groups if the controller itself dies ──
//
// Each supervised child is spawned `detached: true`, which lets the in-loop
// watchdog kill the whole tree via `process.kill(-pid)` — but it ALSO decouples
// the child's lifetime from this process. If the operator closes the terminal
// (SIGHUP), Ctrl-C's (SIGINT), or the controller is otherwise terminated, the
// watchdog loop dies WITHOUT reaping the group, leaving the orchestrator and its
// spawned subagents orphaned and still burning tokens. The registry + handlers
// below guarantee that when the controller exits for any catchable reason, every
// still-running child group dies too. State is process-global and idempotent so it
// stays correct across many sequential superviseProcess calls in one run.
const activeChildGroups = new Set<number>();
let parentCleanupInstalled = false;

// Best-effort hard/soft signal to every registered group. One dead group (ESRCH)
// or a not-permitted error never blocks reaping the others.
function killActiveGroups(sig: NodeJS.Signals): void {
  for (const pid of activeChildGroups) {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone (ESRCH) or not permitted — best-effort, keep going.
    }
  }
}

function installParentExitCleanup(): void {
  if (parentCleanupInstalled) return;
  parentCleanupInstalled = true;

  // 'exit' fires on normal termination and after a handled signal calls
  // process.exit below. Only synchronous work runs here, so we hard-kill the
  // groups outright — there is no opportunity to await a graceful grace window.
  process.on("exit", () => killActiveGroups("SIGKILL"));

  // Catchable termination signals: reap the tree, then re-exit so the signal is
  // not silently swallowed (130 = 128 + SIGINT, the conventional Ctrl-C code).
  // SIGTERM then SIGKILL in the same tick: SIGTERM lets a child that traps it
  // flush, SIGKILL guarantees death. Graceful grace-window waiting is intentionally
  // NOT attempted here — on operator interrupt the priority is "no orphans", and
  // the in-loop watchdog already does graceful SIGTERM→grace→SIGKILL for its OWN
  // timeout kills.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      killActiveGroups("SIGTERM");
      killActiveGroups("SIGKILL");
      process.exit(130);
    });
  }
}

// Register a freshly spawned detached group leader (installs the parent-exit
// cleanup on first use). A missing pid (spawn error before a process existed) is
// a no-op.
function registerChildGroup(pid: number | undefined): void {
  if (typeof pid !== "number") return;
  installParentExitCleanup();
  activeChildGroups.add(pid);
}

function unregisterChildGroup(pid: number | undefined): void {
  if (typeof pid !== "number") return;
  activeChildGroups.delete(pid);
}

// True when the process group led by `pid` still has at least one live member.
// `process.kill(pid, 0)` is the POSIX liveness probe: it sends no signal and
// throws ESRCH when no such process exists.
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Supervise a single child process, returning { outcome, exitCode }.
 *
 *   command, args   passed straight to child_process.spawn
 *   snapshot        injected () => comparable value (object or string); the
 *                   watchdog compares successive snapshots for equality (via
 *                   JSON serialization) and resets the no-progress deadline on
 *                   any change. In production this snapshots {head sha,
 *                   dispatch-log line count, max report mtime, streamed stdout+
 *                   stderr byte total} — the byte total keeps a live-but-streaming
 *                   orchestrator from being reaped between structural events; tests
 *                   inject a fake.
 *   onStdout/onStderr  optional sinks; each receives forwarded chunk strings.
 *   budgets         partial override of DEFAULT_BUDGETS (all in seconds).
 *   input           optional string written to the child's stdin, then stdin is
 *                   closed (codex reads its packet this way: `codex exec … -`).
 *                   When omitted, stdin is closed immediately so the child sees an
 *                   empty EOF (equivalent to v1's `</dev/null` for claude). A
 *                   stdin 'error' (EPIPE if the child exits early) is swallowed.
 *   cwd, env        passed straight to child_process.spawn (default: inherit).
 *   recordProcess   optional callback invoked synchronously, in the same turn
 *                   that spawn returns, with { pid, pgid } — before the group is
 *                   registered and before any await, timer, or stream handler is
 *                   attached, so nothing can observe the process running before
 *                   the record exists. Not called when spawn returns a child with
 *                   no pid.
 *
 * exitCode semantics:
 *   'exited_clean'    → exitCode: 0
 *   'exited_nonzero'  → exitCode: the process exit code (integer), OR null on
 *                       a spawn error (command not found, permission denied,
 *                       etc.) because no process was started and child.exitCode
 *                       is null at that point.
 *   'stalled_killed'  → exitCode: null (or the last-known child.exitCode if the
 *                       child happened to exit during the grace window, which is
 *                       also null unless the OS has already reported it).
 *   'ceiling_exceeded'→ exitCode: null (same reasoning as stalled_killed).
 *
 * In short: exitCode is a reliable integer only for natural exits. Killed and
 * spawn-error paths return null and callers must not rely on a numeric value.
 */
export async function superviseProcess({
  command,
  args = [],
  snapshot = () => null,
  onStdout,
  onStderr,
  budgets = {},
  input,
  cwd,
  env,
  recordProcess,
}: SuperviseProcessOptions): Promise<SuperviseProcessResult> {
  const { POLL_SECS, NO_PROGRESS_SECS, GRACE_SECS, HARD_CEILING_SECS } = {
    ...DEFAULT_BUDGETS,
    ...budgets,
  };

  const child = spawn(command, args, { detached: true, cwd, env });

  // The record must exist before anything else can observe the process running:
  // synchronous, same turn as spawn, before registration and before any stream
  // handler is attached below. pgid equals pid because the child is its own
  // group leader (detached: true).
  if (typeof child.pid === "number") {
    recordProcess?.({ pid: child.pid, pgid: child.pid });
  }

  // Track this detached group so a controller-death (terminal close, Ctrl-C) reaps
  // it instead of orphaning the orchestrator + its subagents. Unregistered on every
  // terminal path via settle().
  registerChildGroup(child.pid);

  // Deliver the prompt over stdin then close it so the child sees EOF. `input` is
  // the packet for codex; for callers that pass nothing this still closes stdin
  // (empty EOF = v1 `</dev/null`). EPIPE on early child exit is swallowed.
  if (child.stdin) {
    child.stdin.on("error", () => {});
    if (input !== undefined && input !== null) child.stdin.write(input);
    child.stdin.end();
  }

  if (onStdout && child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onStdout(chunk));
  }
  if (onStderr && child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => onStderr(chunk));
  }

  return new Promise<SuperviseProcessResult>((resolve) => {
    const start = Date.now();
    let lastProgress = start;
    let baseline = serialize(snapshot());

    let pollTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let settled = false;

    function clearTimers(): void {
      if (pollTimer) clearInterval(pollTimer);
      if (graceTimer) clearTimeout(graceTimer);
      pollTimer = null;
      graceTimer = null;
    }

    function settle(outcome: Outcome, exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimers();
      // The group is no longer ours to reap on controller-death: it has either
      // exited naturally or just been killed by the watchdog itself.
      unregisterChildGroup(child.pid);
      resolve({ outcome, exitCode });
    }

    // SIGTERM the group, wait GRACE_SECS, then SIGKILL if anything survives.
    function teardownThenSettle(outcome: Outcome): void {
      if (settled) return;
      // Stop polling immediately so we do not double-fire while tearing down,
      // but keep the exit handler live: a clean SIGTERM exit still resolves via
      // the outcome we are committing to here.
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;

      signalGroup(child.pid as number, "SIGTERM");

      graceTimer = setTimeout(() => {
        if (groupAlive(child.pid as number)) {
          signalGroup(child.pid as number, "SIGKILL");
        }
        // Resolve on the next tick regardless; if the child's 'exit' has not yet
        // fired we still return the kill outcome the watchdog decided on.
        settle(outcome, child.exitCode);
      }, GRACE_SECS * 1000);
    }

    function poll(): void {
      if (settled) return;
      const now = Date.now();

      const cur = serialize(snapshot());
      if (cur !== baseline) {
        baseline = cur;
        lastProgress = now;
      }

      if (now - start >= HARD_CEILING_SECS * 1000) {
        teardownThenSettle(OUTCOMES.ceilingExceeded);
        return;
      }
      if (now - lastProgress >= NO_PROGRESS_SECS * 1000) {
        teardownThenSettle(OUTCOMES.stalledKilled);
        return;
      }
    }

    pollTimer = setInterval(poll, POLL_SECS * 1000);

    child.on("error", () => {
      // spawn failure (e.g. command not found) — treat as a non-zero exit.
      // exitCode is null here (no process ran); callers must not rely on a
      // numeric value — see JSDoc above.
      settle(OUTCOMES.exitedNonzero, null);
    });

    child.on("exit", (code) => {
      // Natural exit: never kill. If a teardown was already committed (settled or
      // grace pending) the chosen kill outcome stands; otherwise classify by code.
      if (settled) return;
      if (graceTimer) {
        // Child died on its own during the grace window after we sent SIGTERM —
        // the teardown outcome is still the right answer; let the grace timer
        // resolve it (no SIGKILL needed because groupAlive will be false).
        return;
      }
      settle(code === 0 ? OUTCOMES.exitedClean : OUTCOMES.exitedNonzero, code);
    });
  });
}

// Equality basis for snapshots. JSON serialization gives a stable comparable for
// both object and string snapshot shapes.
function serialize(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// Signal the whole process group led by `pid`. Swallows ESRCH (group already
// gone) but lets other errors surface — a real teardown failure must not be
// silently hidden.
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }
}
