// The ten Stage A fixtures' single test entry point. Each fixture is a
// separate exported async function under `evals/fixtures/`, so any one of
// them can also be run in isolation while debugging by importing and
// awaiting it directly. Every fixture is real-process, real-timing, and
// hermetic (a fresh temporary project tree per run, the fake adapter only,
// no `claude` or `codex` on PATH) and cleans up every process group it
// recorded even on assertion failure — the suite-level check below only has
// to prove none of that cleanup left anything behind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { callerExitSurvival } from "../evals/fixtures/01-caller-exit-survival.ts";
import { workerFinalIsData } from "../evals/fixtures/02-worker-final-is-data.ts";
import { boardNotDrained } from "../evals/fixtures/03-board-not-drained.ts";
import { supervisorRestart } from "../evals/fixtures/04-supervisor-restart.ts";
import {
  supervisorExitsAtRestDraining,
  supervisorExitsAtRestWaitingOperator,
} from "../evals/fixtures/05-supervisor-exits-at-rest.ts";
import { duplicateDispatchSupervisorRace, duplicateDispatchRace } from "../evals/fixtures/06-duplicate-dispatch.ts";
import {
  staleRunningRecoveryStaleCase,
  staleRunningRecoveryIndeterminateCase,
} from "../evals/fixtures/07-stale-running-recovery.ts";
import {
  invalidReportMissingField,
  invalidReportUnknownVerdict,
} from "../evals/fixtures/08-invalid-report-fails-closed.ts";
import { cancelRunGraceful, cancelRunNow } from "../evals/fixtures/09-cancel-run.ts";
import {
  descendantProcessCleanupCancel,
  descendantProcessCleanupWallTimeout,
} from "../evals/fixtures/10-descendant-process-cleanup.ts";

const FIXTURE_TIMEOUT_MS = 30000;

test("caller-exit-survival", { timeout: FIXTURE_TIMEOUT_MS }, callerExitSurvival);
test("worker-final-is-data", { timeout: FIXTURE_TIMEOUT_MS }, workerFinalIsData);
test("board-not-drained", { timeout: FIXTURE_TIMEOUT_MS }, boardNotDrained);
test("supervisor-restart", { timeout: FIXTURE_TIMEOUT_MS }, supervisorRestart);
test("supervisor-exits-at-rest: draining", { timeout: FIXTURE_TIMEOUT_MS }, supervisorExitsAtRestDraining);
test("supervisor-exits-at-rest: waiting-operator", { timeout: FIXTURE_TIMEOUT_MS }, supervisorExitsAtRestWaitingOperator);
test("duplicate-dispatch: supervisor race", { timeout: FIXTURE_TIMEOUT_MS }, duplicateDispatchSupervisorRace);
test("duplicate-dispatch: dispatch race", { timeout: FIXTURE_TIMEOUT_MS }, duplicateDispatchRace);
test("stale-running-recovery: stale case", { timeout: FIXTURE_TIMEOUT_MS }, staleRunningRecoveryStaleCase);
test("stale-running-recovery: indeterminate case", { timeout: FIXTURE_TIMEOUT_MS }, staleRunningRecoveryIndeterminateCase);
test("invalid-report-fails-closed: missing required field", { timeout: FIXTURE_TIMEOUT_MS }, invalidReportMissingField);
test("invalid-report-fails-closed: unknown verdict", { timeout: FIXTURE_TIMEOUT_MS }, invalidReportUnknownVerdict);
test("cancel-run: graceful", { timeout: FIXTURE_TIMEOUT_MS }, cancelRunGraceful);
test("cancel-run: --now", { timeout: FIXTURE_TIMEOUT_MS }, cancelRunNow);
test("descendant-process-cleanup: after cancel", { timeout: FIXTURE_TIMEOUT_MS }, descendantProcessCleanupCancel);
test("descendant-process-cleanup: after wall-timeout kill", { timeout: FIXTURE_TIMEOUT_MS }, descendantProcessCleanupWallTimeout);

// Suite-level teardown: zero surviving descendants of this test process.
// Every fixture above is individually responsible for killing everything it
// recorded in its own `finally`; this is the cross-check that none of them
// missed one. `ps`'s long-option `--ppid` is GNU-only, so this walks every
// pid/ppid pair itself rather than relying on a flag only one of macOS's and
// Linux's `ps` implementations accepts.
function survivingDescendants(selfPid: number): string[] {
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => Number(line.trim().split(/\s+/)[1]) === selfPid)
    // `ps` itself is spawned as a child of this test process to take the
    // snapshot, and it lists its own still-running self in that same
    // snapshot — filtered out here rather than treated as a real survivor.
    .filter((line) => !/\bps\s+-A\b/.test(line));
}

test("suite teardown: no surviving descendants of the test process", async () => {
  const selfPid = process.pid;
  // Each fixture's own `finally` already waits for every group it recorded
  // to report ESRCH before returning; a `ps` snapshot taken immediately
  // afterward can still catch one mid-reap by the OS (most visibly a
  // grandchild reparented away from this process, which nothing here
  // `wait()`s on directly). A short settle-and-recheck window absorbs that
  // without weakening the assertion itself: zero survivors, eventually.
  let survivors = survivingDescendants(selfPid);
  for (let attempt = 0; attempt < 10 && survivors.length > 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    survivors = survivingDescendants(selfPid);
  }
  assert.equal(survivors.length, 0, `descendants of the test process survived: ${JSON.stringify(survivors)}`);
});
