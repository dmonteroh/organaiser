// The eval cell-execution engine (P9f-b): given a suite (unit), a profile, and a
// fixture id already validated by `P9f-a`'s `resolveSuiteProfile`, runs the
// corresponding subject via `fixture-invocations.ts`'s dispatch table and captures,
// around that run, the section 29.7/29.8 evidence set that shape allows. Produces one
// in-memory `CapturedCellRecord` per execution; never writes to disk (`P9f-c`'s job).
//
// See that task's brief and refinement log for the full evidentiary trail behind every
// non-obvious choice below (Implementation Constraints C1-C9). In short: `harness.ts`'s
// additive `captureContext` (C2) is the only way to observe git/board/process evidence
// for Single/Sequence cells, since a fixture's own `(): Promise<void>` signature and
// `withFixtureWorkspace`'s teardown-before-resolution ordering expose nothing else.
// Parametrized-factory, Whole-test-file, and Live cells each have a structurally
// narrower capture scope (C3/C9) — this engine never opens a capture context for them,
// so `captureContext`'s hooks simply find nothing to record into.

import { spawn } from "node:child_process";

import {
  captureContext,
  type CaptureContextStore,
  type CaptureGitBoardSnapshot,
} from "./fixtures/harness.ts";
import {
  resolveInvocation,
  wholeTestFileBasename,
  type LiveVendor,
  type LiveSingleTaskResult,
  type LiveBoardDrainResult,
  type LiveReviewRepairResult,
  type LiveBlockedLaneResult,
  type SequenceConstituent,
} from "./fixture-invocations.ts";
import { resolveVendorProfile, serializeResolvedProfile } from "../src/cli/profiles.ts";

// -----------------------------------------------------------------------------------
// The data contract with P9f-c (Playbook item 4): one record per execution, fields
// corresponding to the fourteen section 29.8 artifacts P9f-c writes. Twelve of those
// (everything but the two board-snapshot YAML files) are plain serializations of a
// field below; the two YAML files come from `board.before`/`board.after`.
// -----------------------------------------------------------------------------------

export type EvalCellShape = "single" | "sequence" | "parametrized-factory" | "whole-test-file" | "live";

/** `"skipped"` is reachable only for Live cells (C9): a resolved `{skipped: true, reason}`. */
export type EvalCellDisposition = "pass" | "fail" | "skipped";

export interface EvalCellSnapshot {
  /** The fixture id itself — the closest available stand-in for a "prompt" in this engine's scope. */
  prompt: string;
  /** A human-readable identifier of what actually ran (function name(s), matched case name, or spawned file). */
  taskFixture: string;
  cliVersion: string | null;
  workflowRevision: string | null;
  model: string | null;
  /**
   * `{ vendor: "fake", model: "fake", cliVersion }` for the fake profile (AC8: no-op,
   * verbatim); a `serializeResolvedProfile`-shaped object for Live cells (C6/C9); `null`
   * for shapes that resolve no vendor configuration at all.
   */
  resolvedConfig: Record<string, unknown> | null;
}

export interface EvalCellBoardCapture {
  before: CaptureGitBoardSnapshot["board"] | null;
  after: CaptureGitBoardSnapshot["board"] | null;
}

export interface EvalCellGitCapture {
  before: string | null;
  after: string | null;
  /**
   * `git diff <headBefore>`: everything that changed since the "before" snapshot.
   * Computed by `harness.ts`'s `captureBeforeTeardown`, inside `withFixtureWorkspace`'s
   * `finally` block, before that block's own `fs.rmSync` deletes the workspace — not
   * here, and not lazily against `ctx.workspaceDir` after this engine's own call
   * returns, since by then the directory is already gone.
   */
  diff: string | null;
  /**
   * `harness.ts`'s `commitGraphSnapshot`: the workspace's commit-parent graph plus ref
   * tips, captured under the same "before `fs.rmSync`" constraint as `diff`.
   */
  commitGraph: string | null;
}

export interface EvalCellProcessCapture {
  recordedPgids: readonly number[] | null;
  pid: number | null;
  exitCode: number | null;
  wallTimeMs: number;
}

/**
 * The same section 29.7/29.8 evidence `assembleCapturedEvidence` assembles for a
 * Single cell, scoped to exactly the one constituent it ran for. Added so a
 * `runSequenceInvocation` caller can recover *each* constituent's own git/board/
 * vendor-stdout/events/report evidence, not only whichever constituent happened to run
 * last (see `CapturedCellRecord.constituents`'s doc comment).
 */
export interface EvalSequenceConstituentEvidence {
  git: EvalCellGitCapture | null;
  board: EvalCellBoardCapture | null;
  recordedPgids: readonly number[] | null;
  vendorStdout: Record<string, string> | null;
  events: readonly Record<string, unknown>[] | null;
  stateTransitions: readonly Record<string, unknown>[] | null;
  workerReport: unknown | null;
}

export interface EvalSequenceConstituentResult {
  name: string;
  disposition: "pass" | "fail";
  error: string | null;
  /**
   * This constituent's own full evidence bundle — independent of every other
   * constituent's, and independent of the cell's top-level `git`/`board`/`vendorStdout`/
   * `events`/`workerReport` fields (which remain the *representative* — last-run —
   * constituent's evidence, kept for backward compatibility with existing consumers).
   */
  evidence: EvalSequenceConstituentEvidence;
}

export interface CapturedCellRecord {
  cellId: string;
  evalRunId: string;
  unit: string;
  profile: string;
  fixtureId: string;
  shape: EvalCellShape;
  disposition: EvalCellDisposition;
  /** Fail message, skip reason, or a "constituent X failed: ..." note. `null` on a plain pass. */
  dispositionDetail: string | null;
  /**
   * Populated for Sequence cells only; `null` for every other shape. Each entry carries
   * its own full evidence bundle (`evidence`) in addition to name/disposition/error, so
   * a non-final constituent's git/board/vendor-stdout/events/report evidence is never
   * silently unrecoverable — only the cell's top-level `git`/`board`/`vendorStdout`/
   * `events`/`workerReport` fields below are scoped to the *representative*
   * (last-run) constituent.
   */
  constituents: readonly EvalSequenceConstituentResult[] | null;
  snapshot: EvalCellSnapshot;
  /**
   * `null` for Parametrized-factory/Whole-test-file/Live (negative scope; see C3/C9).
   * For Sequence, this is the representative (last-run) constituent's evidence only —
   * see each entry's own `evidence` field on `constituents` for every constituent's.
   */
  git: EvalCellGitCapture | null;
  /** Same representative-constituent scoping as `git` for Sequence; see that field's doc comment. */
  board: EvalCellBoardCapture | null;
  process: EvalCellProcessCapture;
  /**
   * Single/Sequence/Parametrized-factory: the fixture's own scripted stream files' raw
   * text, keyed by filename. Same representative-constituent scoping as `git` for
   * Sequence.
   */
  vendorStdout: Record<string, string> | null;
  /** No distinct stderr channel exists in the scripted wire format or in any live fixture's return value; always `null`. */
  vendorStderr: string | null;
  /**
   * The store's full event log for the run (Single/Sequence only), ordered by `seq`.
   * Same representative-constituent scoping as `git` for Sequence.
   */
  events: readonly Record<string, unknown>[] | null;
  /** `events` filtered to `type === "task.transitioned"` (Single/Sequence only). */
  stateTransitions: readonly Record<string, unknown>[] | null;
  /** The scripted `{op: "report", report: {...}}` payload(s) the fixture's own stream files carry, if any. */
  workerReport: unknown | null;
}

const FAKE_CLI_VERSION = "fake-adapter-stream/1";

const PARAMETRIZED_FACTORY_MARKER: Readonly<Record<string, true>> = {
  "exit-zero-permission-denial": true,
  "partial-jsonl": true,
  "partial-stream-survives-kill": true,
  "structured-error-source": true,
};

// Duplicated verbatim from `src/engine/scheduler.ts`'s module-private `parseWorkflowRevision`
// per that task's Implementation Constraint C5, which leaves "export or duplicate" to the
// implementer; `scheduler.ts` is not in this task's claim set, so this engine duplicates the
// five-line body rather than touching a file outside its claims.
function parseWorkflowRevision(configSnapshotRef: string | null | undefined): string | null {
  if (!configSnapshotRef) return null;
  try {
    const snapshot = JSON.parse(configSnapshotRef) as { workflow?: { sha256?: unknown } };
    return typeof snapshot.workflow?.sha256 === "string" ? snapshot.workflow.sha256 : null;
  } catch {
    return null;
  }
}

function formatGitText(snapshot: CaptureGitBoardSnapshot | undefined): string | null {
  if (!snapshot || snapshot.gitHead === null) return null;
  return `HEAD ${snapshot.gitHead}\n${snapshot.gitStatus ?? ""}`;
}

function stateTransitionsOf(events: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((event) => event.type === "task.transitioned");
}

function vendorStdoutOf(streamFiles: CaptureContextStore["streamFiles"]): Record<string, string> | null {
  if (!streamFiles || streamFiles.length === 0) return null;
  const out: Record<string, string> = {};
  for (const file of streamFiles) out[file.name] = file.text;
  return out;
}

function workerReportOf(reports: CaptureContextStore["workerReports"]): unknown | null {
  if (!reports || reports.length === 0) return null;
  return reports.length === 1 ? reports[0] : reports;
}

function fakeResolvedConfig(): Record<string, unknown> {
  return { vendor: "fake", model: "fake", cliVersion: FAKE_CLI_VERSION };
}

/** Assembles the `git`/`board`/process/events/report fields shared by Single/Sequence/one Sequence constituent. */
function assembleCapturedEvidence(ctx: CaptureContextStore): {
  git: EvalCellGitCapture | null;
  board: EvalCellBoardCapture | null;
  recordedPgids: readonly number[] | null;
  events: readonly Record<string, unknown>[] | null;
  stateTransitions: readonly Record<string, unknown>[] | null;
  workerReport: unknown | null;
  vendorStdout: Record<string, string> | null;
  workflowRevision: string | null;
} {
  const before = ctx.before;
  const after = ctx.after;

  const git: EvalCellGitCapture | null =
    before || after
      ? {
          before: formatGitText(before),
          after: formatGitText(after),
          // Computed inside `captureBeforeTeardown` (harness.ts), while the workspace
          // directory still existed — see `CaptureContextStore.gitDiff`'s doc comment
          // for why this can no longer be recomputed here against `ctx.workspaceDir`
          // (by this point `withFixtureWorkspace`'s `finally` has already deleted it).
          diff: ctx.gitDiff ?? null,
          commitGraph: ctx.commitGraph ?? null,
        }
      : null;

  const board: EvalCellBoardCapture | null =
    before || after ? { before: before?.board ?? null, after: after?.board ?? null } : null;

  const events = after?.events ?? before?.events ?? null;
  const workflowRevision = parseWorkflowRevision(
    (after?.board?.run?.config_snapshot_ref as string | null | undefined) ??
      (before?.board?.run?.config_snapshot_ref as string | null | undefined) ??
      null,
  );

  return {
    git,
    board,
    recordedPgids: after?.recordedPgids ?? before?.recordedPgids ?? null,
    events,
    stateTransitions: events ? stateTransitionsOf(events) : null,
    workerReport: workerReportOf(ctx.workerReports),
    vendorStdout: vendorStdoutOf(ctx.streamFiles),
    workflowRevision,
  };
}

interface DispositionOutcome {
  disposition: EvalCellDisposition;
  dispositionDetail: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrows `assembleCapturedEvidence`'s return shape to one constituent's own evidence bundle. */
function constituentEvidenceOf(ctx: CaptureContextStore): EvalSequenceConstituentEvidence {
  const evidence = assembleCapturedEvidence(ctx);
  return {
    git: evidence.git,
    board: evidence.board,
    recordedPgids: evidence.recordedPgids,
    vendorStdout: evidence.vendorStdout,
    events: evidence.events,
    stateTransitions: evidence.stateTransitions,
    workerReport: evidence.workerReport,
  };
}

/**
 * Runs one Single/Parametrized-factory-shaped call, wrapped in its own capture context.
 * Capture is captured regardless of outcome: `harness.ts`'s hooks fire from inside
 * `withFixtureWorkspace`'s own `try`/`finally`, which runs before this function's own
 * `await` ever settles either way.
 */
async function runSingleInvocation(
  run: () => Promise<void>,
): Promise<{ outcome: DispositionOutcome; ctx: CaptureContextStore }> {
  const ctx: CaptureContextStore = {};
  try {
    await captureContext.run(ctx, run);
    return { outcome: { disposition: "pass", dispositionDetail: null }, ctx };
  } catch (err) {
    return { outcome: { disposition: "fail", dispositionDetail: errorMessage(err) }, ctx };
  }
}

export async function runSequenceInvocation(
  constituents: readonly SequenceConstituent[],
): Promise<{
  outcome: DispositionOutcome;
  constituentResults: EvalSequenceConstituentResult[];
  ctx: CaptureContextStore;
}> {
  const constituentResults: EvalSequenceConstituentResult[] = [];
  let representativeCtx: CaptureContextStore = {};

  for (const constituent of constituents) {
    const ctx: CaptureContextStore = {};
    try {
      await captureContext.run(ctx, constituent.run);
      constituentResults.push({
        name: constituent.name,
        disposition: "pass",
        error: null,
        evidence: constituentEvidenceOf(ctx),
      });
      representativeCtx = ctx;
    } catch (err) {
      const message = errorMessage(err);
      constituentResults.push({
        name: constituent.name,
        disposition: "fail",
        error: message,
        evidence: constituentEvidenceOf(ctx),
      });
      representativeCtx = ctx;
      return {
        outcome: {
          disposition: "fail",
          dispositionDetail: `constituent "${constituent.name}" failed: ${message}`,
        },
        constituentResults,
        ctx: representativeCtx,
      };
    }
  }

  return {
    outcome: { disposition: "pass", dispositionDetail: null },
    constituentResults,
    ctx: representativeCtx,
  };
}

interface WholeTestFileOutcome {
  disposition: "pass" | "fail";
  dispositionDetail: string | null;
  pid: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// Node's own test runner marks a worker process it spawns with `NODE_TEST_CONTEXT`/
// `NODE_TEST_WORKER_ID`, which switches that process's `node --test` reporting onto an
// IPC channel coordinated with its parent instead of a plain top-level run with normal
// exit-code semantics. When this engine's own test suite (or, in principle, any future
// caller) runs under `node --test` itself, those two variables would otherwise leak into
// the spawned `node --test <file>` child by plain environment inheritance and silently
// break this shape's exit-code disposition (confirmed directly: a deliberately failing
// spawned file still exited 0 with these two variables inherited). Stripped here so this
// shape's child process always runs as an independent, top-level `node --test`
// invocation, regardless of the caller's own execution context.
function wholeTestFileChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

/** Spawns `node --test <file>` as a real child process; exit code 0 is the cell's pass. */
export function runWholeTestFile(testFilePath: string): Promise<WholeTestFileOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", testFilePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: wholeTestFileChildEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({
        disposition: code === 0 ? "pass" : "fail",
        dispositionDetail:
          code === 0 ? null : `node --test ${wholeTestFileBasename(testFilePath)} exited with code ${code}`,
        pid: typeof child.pid === "number" ? child.pid : null,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

const LIVE_TASK_FIXTURE_NAMES: Readonly<Record<string, string>> = {
  "live-single-task": "liveSingleTask",
  "live-board-drain": "liveBoardDrain",
  "live-review-repair": "liveReviewRepair",
  "live-blocked-lane": "liveBlockedLane",
};

interface LiveOutcome {
  disposition: EvalCellDisposition;
  dispositionDetail: string | null;
  snapshotFields: { cliVersion: string | null; workflowRevision: string | null; model: string | null };
}

/**
 * Live disposition mapping per C9's per-id split (architect pass 2): every id shares a
 * thrown-rejection -> "fail" and a resolved `{skipped: true}` -> "skipped" branch.
 * `live-single-task`'s resolved, non-skipped branch maps all four `state` values; every
 * other id's resolved, non-skipped branch is always a pass in practice (each one's own
 * code throws on any other outcome — the rejection branch above is that id's realistic
 * fail path, not a state-based mapping).
 */
export function mapLiveOutcome(
  fixtureId: string,
  result: LiveSingleTaskResult | LiveBoardDrainResult | LiveReviewRepairResult | LiveBlockedLaneResult,
): LiveOutcome {
  if (result.skipped) {
    return {
      disposition: "skipped",
      dispositionDetail: result.reason,
      snapshotFields: { cliVersion: null, workflowRevision: null, model: null },
    };
  }

  if (fixtureId === "live-single-task") {
    const r = result as Extract<LiveSingleTaskResult, { skipped: false }>;
    const pass = r.state === "succeeded";
    return {
      disposition: pass ? "pass" : "fail",
      dispositionDetail: pass ? null : `run rested at state "${r.state}"`,
      snapshotFields: { cliVersion: r.cliVersion, workflowRevision: r.workflowRevision, model: r.model },
    };
  }

  // live-board-drain, live-review-repair, live-blocked-lane: each fixture's own code
  // throws on any non-passing resting state, so this branch is always a pass in practice
  // (see C9/AC3), and none of these three result types carries a
  // cliVersion/workflowRevision/model field.
  return {
    disposition: "pass",
    dispositionDetail: null,
    snapshotFields: { cliVersion: null, workflowRevision: null, model: null },
  };
}

export async function runLiveInvocation(
  fixtureId: string,
  vendor: LiveVendor,
  run: (
    vendor: LiveVendor,
  ) => Promise<LiveSingleTaskResult | LiveBoardDrainResult | LiveReviewRepairResult | LiveBlockedLaneResult>,
): Promise<LiveOutcome> {
  try {
    const result = await run(vendor);
    return mapLiveOutcome(fixtureId, result);
  } catch (err) {
    return {
      disposition: "fail",
      dispositionDetail: errorMessage(err),
      snapshotFields: { cliVersion: null, workflowRevision: null, model: null },
    };
  }
}

export interface CellRunner {
  runCell(unit: string, profile: string, fixtureId: string): Promise<CapturedCellRecord>;
}

/**
 * `<n>` is a 1-based counter per distinct `(unit, profile, fixtureId)` triple within one
 * eval-run id (C4): a private `Map` keyed by that triple, incremented per call, so a
 * repeated cell is structurally distinct and never merged with another.
 */
export function createCellRunner(evalRunId: string): CellRunner {
  const counters = new Map<string, number>();

  function nextCellId(unit: string, profile: string, fixtureId: string): string {
    const key = `${unit}--${profile}--${fixtureId}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return `${key}--${n}`;
  }

  return {
    async runCell(unit: string, profile: string, fixtureId: string): Promise<CapturedCellRecord> {
      const cellId = nextCellId(unit, profile, fixtureId);
      const invocation = resolveInvocation(unit, profile, fixtureId);
      const startedAt = Date.now();

      if (invocation.shape === "live") {
        const vendor = profile as LiveVendor;
        const live = await runLiveInvocation(fixtureId, vendor, invocation.run);
        const resolvedProfile = resolveVendorProfile("default", { vendor });
        return {
          cellId,
          evalRunId,
          unit,
          profile,
          fixtureId,
          shape: "live",
          disposition: live.disposition,
          dispositionDetail: live.dispositionDetail,
          constituents: null,
          snapshot: {
            prompt: fixtureId,
            taskFixture: LIVE_TASK_FIXTURE_NAMES[fixtureId] ?? fixtureId,
            cliVersion: live.snapshotFields.cliVersion,
            workflowRevision: live.snapshotFields.workflowRevision,
            model: live.snapshotFields.model,
            resolvedConfig: JSON.parse(serializeResolvedProfile(resolvedProfile)) as Record<string, unknown>,
          },
          git: null,
          board: null,
          process: {
            recordedPgids: null,
            pid: null,
            exitCode: null,
            wallTimeMs: Date.now() - startedAt,
          },
          vendorStdout: null,
          vendorStderr: null,
          events: null,
          stateTransitions: null,
          workerReport: null,
        };
      }

      if (invocation.shape === "whole-test-file") {
        const outcome = await runWholeTestFile(invocation.testFilePath);
        return {
          cellId,
          evalRunId,
          unit,
          profile,
          fixtureId,
          shape: "whole-test-file",
          disposition: outcome.disposition,
          dispositionDetail: outcome.dispositionDetail,
          constituents: null,
          snapshot: {
            prompt: fixtureId,
            taskFixture: wholeTestFileBasename(invocation.testFilePath),
            cliVersion: FAKE_CLI_VERSION,
            workflowRevision: null,
            model: "fake",
            resolvedConfig: fakeResolvedConfig(),
          },
          git: null,
          board: null,
          process: {
            recordedPgids: null,
            pid: outcome.pid,
            exitCode: outcome.exitCode,
            wallTimeMs: Date.now() - startedAt,
          },
          vendorStdout: { [wholeTestFileBasename(invocation.testFilePath)]: outcome.stdout },
          vendorStderr: outcome.stderr,
          events: null,
          stateTransitions: null,
          workerReport: null,
        };
      }

      if (invocation.shape === "sequence") {
        const { outcome, constituentResults, ctx } = await runSequenceInvocation(invocation.constituents);
        const evidence = assembleCapturedEvidence(ctx);
        return {
          cellId,
          evalRunId,
          unit,
          profile,
          fixtureId,
          shape: "sequence",
          disposition: outcome.disposition,
          dispositionDetail: outcome.dispositionDetail,
          constituents: constituentResults,
          snapshot: {
            prompt: fixtureId,
            taskFixture: invocation.constituents.map((c) => c.name).join(" | "),
            cliVersion: FAKE_CLI_VERSION,
            workflowRevision: evidence.workflowRevision,
            model: "fake",
            resolvedConfig: fakeResolvedConfig(),
          },
          git: evidence.git,
          board: evidence.board,
          process: {
            recordedPgids: evidence.recordedPgids,
            pid: null,
            exitCode: null,
            wallTimeMs: Date.now() - startedAt,
          },
          vendorStdout: evidence.vendorStdout,
          vendorStderr: null,
          events: evidence.events,
          stateTransitions: evidence.stateTransitions,
          workerReport: evidence.workerReport,
        };
      }

      // Single and Parametrized-factory share one code path: the resolved `run`
      // callable is awaited identically. The capture context simply never populates for
      // Parametrized-factory, since none of its case functions ever call
      // `withFixtureWorkspace`/`startFixtureRun` (C3) — no special-casing needed here.
      const { outcome, ctx } = await runSingleInvocation(invocation.run);
      const evidence = assembleCapturedEvidence(ctx);
      const shape: EvalCellShape = fixtureId in PARAMETRIZED_FACTORY_MARKER ? "parametrized-factory" : "single";
      return {
        cellId,
        evalRunId,
        unit,
        profile,
        fixtureId,
        shape,
        disposition: outcome.disposition,
        dispositionDetail: outcome.dispositionDetail,
        constituents: null,
        snapshot: {
          prompt: fixtureId,
          taskFixture: fixtureId,
          cliVersion: FAKE_CLI_VERSION,
          workflowRevision: evidence.workflowRevision,
          model: "fake",
          resolvedConfig: fakeResolvedConfig(),
        },
        git: evidence.git,
        board: evidence.board,
        process: {
          recordedPgids: evidence.recordedPgids,
          pid: null,
          exitCode: null,
          wallTimeMs: Date.now() - startedAt,
        },
        vendorStdout: evidence.vendorStdout,
        vendorStderr: null,
        events: evidence.events,
        stateTransitions: evidence.stateTransitions,
        workerReport: evidence.workerReport,
      };
    },
  };
}
