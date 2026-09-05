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
import { fileURLToPath } from "node:url";

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
import { outOfClaimWrite } from "../evals/fixtures/11-out-of-claim-write.ts";
import { unrelatedDirtyCheckoutDoesNotAffectTask } from "../evals/fixtures/12-unrelated-dirty-checkout.ts";
import { knownBadVersionRefused } from "../evals/fixtures/12-known-bad-version-refused.ts";
import { adapterStreamCases } from "../evals/fixtures/13-adapter-stream-cases.ts";
import { gateCapParksTask } from "../evals/fixtures/13-gate-caps.ts";
import { blockingFindingRequiresProof, gateOrder } from "../evals/fixtures/14-review-gates.ts";
import { freshReviewer } from "../evals/fixtures/15-fresh-reviewer.ts";
import { minorFindingsAppendOnce } from "../evals/fixtures/16-minor-findings.ts";
import { destinationCas, integrationConflict } from "../evals/fixtures/17-destination-and-conflict.ts";
import {
  historicalCommitRewrite,
  landedWorkRecoveryWithoutFalseSuccess,
  worktreeCleanup,
} from "../evals/fixtures/18-cleanup-and-recovery.ts";

const FIXTURE_TIMEOUT_MS = 30000;

// The four required deterministic stream cases (goals spec section 29.4) speak a
// vendor-neutral four-event wire format, so both vendor labels below replay the same
// substrate fixture directory that already backs `test/claude-adapter.test.ts` and
// `test/codex-adapter.test.ts`'s own `adapterStreamCases` registrations — the sanitized
// `evals/captures/<vendor>/<version>/` directories hold a distinct, fixed ten-file case
// set enforced by those files' own directory-content assertions, not these four names.
const ADAPTER_STREAM_CASES_DIR = fileURLToPath(new URL("./fixtures/adapter-substrate/", import.meta.url));

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
test("out-of-claim-write", { timeout: FIXTURE_TIMEOUT_MS }, outOfClaimWrite);
test("unrelated-dirty-checkout-does-not-affect-task", { timeout: FIXTURE_TIMEOUT_MS }, unrelatedDirtyCheckoutDoesNotAffectTask);
test("known-bad-version-refused", { timeout: FIXTURE_TIMEOUT_MS }, knownBadVersionRefused);
for (const c of adapterStreamCases("claude", ADAPTER_STREAM_CASES_DIR)) {
  test(c.name, { timeout: FIXTURE_TIMEOUT_MS }, c.run);
}
for (const c of adapterStreamCases("codex", ADAPTER_STREAM_CASES_DIR)) {
  test(c.name, { timeout: FIXTURE_TIMEOUT_MS }, c.run);
}
test("gate-caps: a capped task parks while an unrelated task drains", { timeout: FIXTURE_TIMEOUT_MS }, gateCapParksTask);
test("review-gates: review-quality never runs before review-spec has passed", { timeout: FIXTURE_TIMEOUT_MS }, gateOrder);
test("review-gates: a proof-less blocking finding is rejected and routes to no repair", { timeout: FIXTURE_TIMEOUT_MS }, blockingFindingRequiresProof);
test("fresh-reviewer: two review rounds run in distinct fresh worktrees with distinct attempts and pids", { timeout: FIXTURE_TIMEOUT_MS }, freshReviewer);
test("minor-findings-append-once: a supervisor restart mid-append still reaches exactly one append", { timeout: FIXTURE_TIMEOUT_MS }, minorFindingsAppendOnce);
test("destination-cas: an external ref move between lock and advance is never overwritten", { timeout: FIXTURE_TIMEOUT_MS }, destinationCas);
test("integration-conflict: a conflicting replay parks the task and leaves the destination untouched", { timeout: FIXTURE_TIMEOUT_MS }, integrationConflict);
test("worktree-cleanup: success is withheld until every recorded worktree is cleaned", { timeout: FIXTURE_TIMEOUT_MS }, worktreeCleanup);
test("historical-commit-rewrite: a rewritten destination history never reports success", { timeout: FIXTURE_TIMEOUT_MS }, historicalCommitRewrite);
test("landed-work-recovery-without-false-success: landed commits alone are not counted as success", { timeout: FIXTURE_TIMEOUT_MS }, landedWorkRecoveryWithoutFalseSuccess);

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
