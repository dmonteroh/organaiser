// POSIX process-group primitives, extracted out of process-supervisor.ts so
// other terminators (the runner-owned cancel/kill sequence) can reuse the
// exact same negative-pid convention instead of redefining it.

// True when the process group led by `pid` still has at least one live member.
// `process.kill(pid, 0)` is the POSIX liveness probe: it sends no signal and
// throws ESRCH when no such process exists.
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Signal the whole process group led by `pid`. Swallows ESRCH (group already
// gone) but lets other errors surface — a real teardown failure must not be
// silently hidden.
export function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch (err) {
    if (err && (err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }
}
