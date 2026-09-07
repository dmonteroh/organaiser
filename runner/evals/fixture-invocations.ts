// The fixture id -> invocation-shape lookup table for P9f-b's eval cell-execution
// engine. Cross-referenced against `registry-check.ts`'s `DETERMINISTIC_FIXTURE_IDS`,
// `runner/test/fixtures.test.ts`'s own import list, and `registry.json`'s actual usage
// (see that task's Implementation Constraint C3/C9 and its refinement log's Blockers
// A-D for the full evidence trail). Four dispatch shapes exist for the `deterministic`
// id space, plus a fifth (Live) reached through the `claude`/`codex` profiles rather
// than a distinct `deterministic` id:
//
//   - Single: one id, one exported `(): Promise<void>` function.
//   - Sequence: one id names two independently-`test()`-registered exports in the same
//     file; both run, in declared order, for one cell.
//   - Parametrized-factory: one id resolves through `adapterStreamCases(vendor,
//     captureDir)` rather than a top-level export; once resolved, its `run` callable is
//     invoked exactly like Single.
//   - Whole-test-file: one id names an entire `runner/test/<id>.test.ts` file with no
//     `evals/fixtures/` export at all; run only via a spawned `node --test <file>`.
//   - Live: `live-single-task`/`live-board-drain` resolve to `liveSingleTask(vendor)`/
//     `liveBoardDrain(vendor)`, a materially different `(vendor) => Promise<Result>`
//     signature reached only through the `claude`/`codex` profiles.
//
// No fixture file under `evals/fixtures/` is imported for its side effects only, or
// modified: every import below is exactly what `fixtures.test.ts` already imports for
// its own `test()` registrations, read the same way.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { callerExitSurvival } from "./fixtures/01-caller-exit-survival.ts";
import { workerFinalIsData } from "./fixtures/02-worker-final-is-data.ts";
import { boardNotDrained } from "./fixtures/03-board-not-drained.ts";
import { supervisorRestart } from "./fixtures/04-supervisor-restart.ts";
import {
  supervisorExitsAtRestDraining,
  supervisorExitsAtRestWaitingOperator,
} from "./fixtures/05-supervisor-exits-at-rest.ts";
import { duplicateDispatchSupervisorRace, duplicateDispatchRace } from "./fixtures/06-duplicate-dispatch.ts";
import {
  staleRunningRecoveryStaleCase,
  staleRunningRecoveryIndeterminateCase,
} from "./fixtures/07-stale-running-recovery.ts";
import {
  invalidReportMissingField,
  invalidReportUnknownVerdict,
} from "./fixtures/08-invalid-report-fails-closed.ts";
import { cancelRunGraceful, cancelRunNow } from "./fixtures/09-cancel-run.ts";
import {
  descendantProcessCleanupCancel,
  descendantProcessCleanupWallTimeout,
} from "./fixtures/10-descendant-process-cleanup.ts";
import { outOfClaimWrite } from "./fixtures/11-out-of-claim-write.ts";
import { unrelatedDirtyCheckoutDoesNotAffectTask } from "./fixtures/12-unrelated-dirty-checkout.ts";
import { knownBadVersionRefused } from "./fixtures/12-known-bad-version-refused.ts";
import { adapterStreamCases } from "./fixtures/13-adapter-stream-cases.ts";
import { gateCapParksTask } from "./fixtures/13-gate-caps.ts";
import { blockingFindingRequiresProof, gateOrder } from "./fixtures/14-review-gates.ts";
import { liveSingleTask, type LiveSingleTaskResult, type LiveVendor } from "./fixtures/14-live-single-task.ts";
import { freshReviewer } from "./fixtures/15-fresh-reviewer.ts";
import { minorFindingsAppendOnce } from "./fixtures/16-minor-findings.ts";
import { destinationCas, integrationConflict } from "./fixtures/17-destination-and-conflict.ts";
import {
  historicalCommitRewrite,
  landedWorkRecoveryWithoutFalseSuccess,
  worktreeCleanup,
} from "./fixtures/18-cleanup-and-recovery.ts";
import {
  inPlaceRefusesDirty,
  inPlaceSerializes,
  inPlaceClaimsExcludeRecordedDirt,
} from "./fixtures/19-in-place.ts";
import {
  dependencyOrder,
  operatorBlockDoesNotGlobalStop,
  terminalTaskNeverDispatches,
  claimOverlapSerializes,
  disjointClaimsParallelize,
} from "./fixtures/20-board-parallelism.ts";
import { liveBoardDrain, type LiveBoardDrainResult } from "./fixtures/23-live-board-drain.ts";
import { secretRedaction } from "./fixtures/24-secret-redaction.ts";

export type { LiveVendor, LiveSingleTaskResult, LiveBoardDrainResult };

const ADAPTER_STREAM_CASES_DIR = fileURLToPath(new URL("../test/fixtures/adapter-substrate/", import.meta.url));

export class UnknownFixtureIdError extends Error {
  constructor(fixtureId: string) {
    super(`no known invocation for fixture id "${fixtureId}"`);
    this.name = "UnknownFixtureIdError";
  }
}

export class UnknownVendorUnitError extends Error {
  constructor(unit: string) {
    super(`cannot derive a vendor from unit "${unit}" (expected "claude-adapter" or "codex-adapter")`);
    this.name = "UnknownVendorUnitError";
  }
}

/** `claude-adapter` -> `"claude"`, `codex-adapter` -> `"codex"` (C3's Parametrized-factory lookup). */
export function vendorForUnit(unit: string): LiveVendor {
  if (unit === "claude-adapter") return "claude";
  if (unit === "codex-adapter") return "codex";
  throw new UnknownVendorUnitError(unit);
}

export interface SequenceConstituent {
  name: string;
  run: () => Promise<void>;
}

export interface SingleInvocation {
  shape: "single";
  run: () => Promise<void>;
}

export interface SequenceInvocation {
  shape: "sequence";
  constituents: readonly SequenceConstituent[];
}

export interface WholeTestFileInvocation {
  shape: "whole-test-file";
  testFilePath: string;
}

export interface LiveInvocation {
  shape: "live";
  run: (vendor: LiveVendor) => Promise<LiveSingleTaskResult | LiveBoardDrainResult>;
}

export type ResolvedInvocation =
  | SingleInvocation
  | SequenceInvocation
  | WholeTestFileInvocation
  | LiveInvocation;

const LIVE_IDS: Readonly<Record<string, LiveInvocation["run"]>> = {
  "live-single-task": liveSingleTask,
  "live-board-drain": liveBoardDrain,
};

// Whole-test-file ids have no `evals/fixtures/` export at all (C3): they name an entire
// `runner/test/<id>.test.ts` file, run only via a spawned `node --test <file>`.
const WHOLE_TEST_FILE_IDS: ReadonlySet<string> = new Set([
  "board-validate",
  "board-render",
  "import-markdown",
  "legacy-import",
]);

function wholeTestFilePath(fixtureId: string): string {
  return fileURLToPath(new URL(`../test/${fixtureId}.test.ts`, import.meta.url));
}

// Six ids each cover two exported functions in one file (C3's Sequence shape); both
// constituents are run, in this declared order, for one cell.
const SEQUENCE_IDS: Readonly<Record<string, readonly SequenceConstituent[]>> = {
  "cancel-run": [
    { name: "cancel-run: graceful", run: cancelRunGraceful },
    { name: "cancel-run: --now", run: cancelRunNow },
  ],
  "duplicate-dispatch": [
    { name: "duplicate-dispatch: supervisor race", run: duplicateDispatchSupervisorRace },
    { name: "duplicate-dispatch: dispatch race", run: duplicateDispatchRace },
  ],
  "descendant-process-cleanup": [
    { name: "descendant-process-cleanup: after cancel", run: descendantProcessCleanupCancel },
    { name: "descendant-process-cleanup: after wall-timeout kill", run: descendantProcessCleanupWallTimeout },
  ],
  "stale-running-recovery": [
    { name: "stale-running-recovery: stale case", run: staleRunningRecoveryStaleCase },
    { name: "stale-running-recovery: indeterminate case", run: staleRunningRecoveryIndeterminateCase },
  ],
  "invalid-report-fails-closed": [
    { name: "invalid-report-fails-closed: missing required field", run: invalidReportMissingField },
    { name: "invalid-report-fails-closed: unknown verdict", run: invalidReportUnknownVerdict },
  ],
  "supervisor-exits-at-rest": [
    { name: "supervisor-exits-at-rest: draining", run: supervisorExitsAtRestDraining },
    { name: "supervisor-exits-at-rest: waiting-operator", run: supervisorExitsAtRestWaitingOperator },
  ],
};

// Four ids under `claude-adapter`/`codex-adapter` resolve through `adapterStreamCases`
// rather than a top-level export (C3's Parametrized-factory shape). None of the four
// case functions ever call `withFixtureWorkspace`/`startFixtureRun`/any store helper, so
// the capture-context hook structurally never fires for this shape; the engine invokes
// the resolved `run` callable exactly like Single.
const PARAMETRIZED_FACTORY_IDS: ReadonlySet<string> = new Set([
  "exit-zero-permission-denial",
  "partial-jsonl",
  "partial-stream-survives-kill",
  "structured-error-source",
]);

function resolveParametrizedFactory(unit: string, fixtureId: string): SingleInvocation {
  const vendor = vendorForUnit(unit);
  const cases = adapterStreamCases(vendor, ADAPTER_STREAM_CASES_DIR);
  const suffix = `: ${fixtureId}`;
  const match = cases.find((c) => c.name.endsWith(suffix));
  if (!match) {
    throw new UnknownFixtureIdError(fixtureId);
  }
  return { shape: "single", run: match.run };
}

// Every remaining id that has a real `evals/fixtures/` export today (C3's Single shape:
// the majority). Ids in `registry-check.ts`'s `DETERMINISTIC_FIXTURE_IDS` with no
// export anywhere in this file or in `fixtures.test.ts`'s own import list
// (`kill-without-supervisor`, `pause-resume-roundtrip`, `relocatable-artifacts`,
// `read-only-source-tests`, `typed-commit-identity-rejects-placeholder`,
// `importer-refuses-dead-running`, `idle-timeout`, `productive-no-commit`) are reserved,
// not-yet-implemented ids that no `registry.json` unit references today; they correctly
// fall through to `UnknownFixtureIdError` below rather than being fabricated here.
const SINGLE_IDS: Readonly<Record<string, () => Promise<void>>> = {
  "caller-exit-survival": callerExitSurvival,
  "worker-final-is-data": workerFinalIsData,
  "board-not-drained": boardNotDrained,
  "supervisor-restart": supervisorRestart,
  "out-of-claim-write": outOfClaimWrite,
  "unrelated-dirty-checkout-does-not-affect-task": unrelatedDirtyCheckoutDoesNotAffectTask,
  "known-bad-version-refused": knownBadVersionRefused,
  "gate-cap-parks-task": gateCapParksTask,
  "gate-order": gateOrder,
  "blocking-finding-requires-proof": blockingFindingRequiresProof,
  "fresh-reviewer": freshReviewer,
  "minor-findings-append-once": minorFindingsAppendOnce,
  "destination-cas": destinationCas,
  "integration-conflict": integrationConflict,
  "worktree-cleanup": worktreeCleanup,
  "historical-commit-rewrite": historicalCommitRewrite,
  "landed-work-recovery-without-false-success": landedWorkRecoveryWithoutFalseSuccess,
  "in-place-refuses-dirty": inPlaceRefusesDirty,
  "in-place-serializes": inPlaceSerializes,
  "in-place-claims-exclude-recorded-dirt": inPlaceClaimsExcludeRecordedDirt,
  "dependency-order": dependencyOrder,
  "operator-block-does-not-global-stop": operatorBlockDoesNotGlobalStop,
  "terminal-task-never-dispatches": terminalTaskNeverDispatches,
  "claim-overlap-serializes": claimOverlapSerializes,
  "disjoint-claims-parallelize": disjointClaimsParallelize,
  "secret-redaction": secretRedaction,
};

/**
 * Resolves which of the five shapes `(unit, profile, fixtureId)` uses. `unit` and
 * `profile` are assumed already validated by `P9f-a`'s `resolveSuiteProfile` — this
 * function only disambiguates dispatch shape, never suite/profile validity.
 */
export function resolveInvocation(unit: string, profile: string, fixtureId: string): ResolvedInvocation {
  if ((profile === "claude" || profile === "codex") && fixtureId in LIVE_IDS) {
    return { shape: "live", run: LIVE_IDS[fixtureId] };
  }

  if (WHOLE_TEST_FILE_IDS.has(fixtureId)) {
    return { shape: "whole-test-file", testFilePath: wholeTestFilePath(fixtureId) };
  }

  if (PARAMETRIZED_FACTORY_IDS.has(fixtureId)) {
    return resolveParametrizedFactory(unit, fixtureId);
  }

  const sequence = SEQUENCE_IDS[fixtureId];
  if (sequence) {
    return { shape: "sequence", constituents: sequence };
  }

  const single = SINGLE_IDS[fixtureId];
  if (single) {
    return { shape: "single", run: single };
  }

  throw new UnknownFixtureIdError(fixtureId);
}

/** Re-exported for the engine's Whole-test-file exit-code disposition (`node --test`). */
export function wholeTestFileBasename(testFilePath: string): string {
  return path.basename(testFilePath);
}
