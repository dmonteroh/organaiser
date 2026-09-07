// Tests for P9f-b's eval cell-execution engine: the fixture-id-to-invocation-shape
// dispatch table (`evals/fixture-invocations.ts`) and the engine that runs a cell and
// assembles a `CapturedCellRecord` around it (`evals/cell-runner.ts`), plus a direct
// regression check that the additive `harness.ts` capture-context hooks are true no-ops
// for every call site that never opens a context (which is every one of the ~40
// existing fixtures — `test/fixtures.test.ts` is the exhaustive version of this check;
// this is a narrower, fast, dedicated check colocated with the engine that needed the
// hook added).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCellRunner, runSequenceInvocation, runLiveInvocation, mapLiveOutcome, runWholeTestFile } from "../evals/cell-runner.ts";
import { boardNotDrained } from "../evals/fixtures/03-board-not-drained.ts";
import { captureContext } from "../evals/fixtures/harness.ts";

const TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Single shape
// ---------------------------------------------------------------------------

test(
  "single shape: full capture for a non-git deterministic fixture",
  { timeout: TIMEOUT_MS },
  async () => {
    const runner = createCellRunner("evalrun-single");
    const record = await runner.runCell("store", "fake", "board-not-drained");

    assert.equal(record.shape, "single");
    assert.equal(record.disposition, "pass");
    assert.equal(record.dispositionDetail, null);
    assert.equal(record.cellId, "store--fake--board-not-drained--1");
    assert.equal(record.constituents, null);

    assert.equal(record.fixtureId, "board-not-drained");
    assert.equal(record.snapshot.prompt, "board-not-drained");
    assert.equal(record.snapshot.model, "fake");
    assert.equal(record.snapshot.cliVersion, "fake-adapter-stream/1");
    assert.deepEqual(record.snapshot.resolvedConfig, { vendor: "fake", model: "fake", cliVersion: "fake-adapter-stream/1" });

    // board-not-drained never calls `git init`; git capture must be present (a context
    // was opened) but empty (no `.git` directory to read).
    assert.notEqual(record.git, null);
    assert.equal(record.git?.before, null);
    assert.equal(record.git?.after, null);
    assert.equal(record.git?.diff, null);

    assert.notEqual(record.board, null);
    const tasksAfter = record.board?.after?.tasks ?? [];
    const taskA = tasksAfter.find((t) => t.id === "task-a");
    assert.equal(taskA?.disposition, "parked", "task-a's fixture-internal outcome must be visible on the after-snapshot");

    assert.ok(record.process.recordedPgids && record.process.recordedPgids.length >= 1);
    assert.ok(record.process.wallTimeMs >= 0);

    assert.ok(record.events && record.events.length > 0);
    assert.ok(record.stateTransitions && record.stateTransitions.length > 0);
    assert.ok(record.stateTransitions?.every((e) => e.type === "task.transitioned"));

    assert.ok(record.vendorStdout, "the fixture's scripted stream file content must be captured");
    const streamKeys = Object.keys(record.vendorStdout ?? {});
    assert.ok(streamKeys.some((k) => k.includes("implement--task-a")));

    const report = record.workerReport as { status?: string; summary?: string } | null;
    assert.equal(report?.status, "failed");
    assert.equal(report?.summary, "could not implement");

    assert.equal(record.vendorStderr, null, "the scripted wire format has no distinct stderr channel");
  },
);

test("cell id counter increments per (unit, profile, fixtureId) triple", { timeout: TIMEOUT_MS }, async () => {
  const runner = createCellRunner("evalrun-counter");
  const first = await runner.runCell("claude-adapter", "fake", "partial-jsonl");
  const second = await runner.runCell("claude-adapter", "fake", "partial-jsonl");
  const other = await runner.runCell("codex-adapter", "fake", "partial-jsonl");

  assert.equal(first.cellId, "claude-adapter--fake--partial-jsonl--1");
  assert.equal(second.cellId, "claude-adapter--fake--partial-jsonl--2");
  assert.equal(other.cellId, "codex-adapter--fake--partial-jsonl--1", "a distinct triple starts its own counter at 1");
});

// ---------------------------------------------------------------------------
// Sequence shape
// ---------------------------------------------------------------------------

test("sequence shape: both constituents run and capture is present", { timeout: TIMEOUT_MS }, async () => {
  const runner = createCellRunner("evalrun-sequence");
  const record = await runner.runCell("store", "fake", "stale-running-recovery");

  assert.equal(record.shape, "sequence");
  assert.equal(record.disposition, "pass");
  assert.equal(record.constituents?.length, 2);
  assert.ok(record.constituents?.every((c) => c.disposition === "pass"));
  assert.equal(record.constituents?.[0]?.name, "stale-running-recovery: stale case");
  assert.equal(record.constituents?.[1]?.name, "stale-running-recovery: indeterminate case");

  // Representative capture comes from the last constituent that ran.
  assert.notEqual(record.board, null);
  const tasksAfter = record.board?.after?.tasks ?? [];
  assert.ok(tasksAfter.some((t) => t.id === "task-a"));
});

test("sequence shape: first rejection ends the cell as failed", { timeout: TIMEOUT_MS }, async () => {
  const order: string[] = [];
  const { outcome, constituentResults } = await runSequenceInvocation([
    {
      name: "first",
      run: async () => {
        order.push("first");
      },
    },
    {
      name: "second",
      run: async () => {
        order.push("second");
        throw new Error("second boomed");
      },
    },
    {
      name: "third",
      run: async () => {
        order.push("third");
      },
    },
  ]);

  assert.equal(outcome.disposition, "fail");
  assert.match(outcome.dispositionDetail ?? "", /constituent "second" failed: second boomed/);
  assert.deepEqual(order, ["first", "second"], "a constituent after the failing one must never run");
  assert.equal(constituentResults.length, 2, "the record names only the constituents that actually ran");
  assert.equal(constituentResults[0]?.disposition, "pass");
  assert.equal(constituentResults[1]?.disposition, "fail");
  assert.equal(constituentResults[1]?.error, "second boomed");
});

test("sequence shape: a failure on the very first constituent never runs the second", { timeout: TIMEOUT_MS }, async () => {
  const order: string[] = [];
  const { outcome, constituentResults } = await runSequenceInvocation([
    {
      name: "only-runs-once",
      run: async () => {
        order.push("only-runs-once");
        throw new Error("boom");
      },
    },
    {
      name: "never-runs",
      run: async () => {
        order.push("never-runs");
      },
    },
  ]);

  assert.equal(outcome.disposition, "fail");
  assert.deepEqual(order, ["only-runs-once"]);
  assert.equal(constituentResults.length, 1);
});

// ---------------------------------------------------------------------------
// Parametrized-factory shape
// ---------------------------------------------------------------------------

test("parametrized-factory shape: resolves via the factory and captures nothing", { timeout: TIMEOUT_MS }, async () => {
  const runner = createCellRunner("evalrun-factory");
  const record = await runner.runCell("claude-adapter", "fake", "exit-zero-permission-denial");

  assert.equal(record.shape, "parametrized-factory");
  assert.equal(record.disposition, "pass");
  assert.equal(record.git, null, "Parametrized-factory never opens a workspace (C3): git capture is negative scope");
  assert.equal(record.board, null);
  assert.equal(record.vendorStdout, null);
  assert.equal(record.workerReport, null);
  assert.equal(record.snapshot.model, "fake");
});

test("parametrized-factory shape: derives vendor from the unit, not the profile", { timeout: TIMEOUT_MS }, async () => {
  const runner = createCellRunner("evalrun-factory-vendor");
  // Both units run the same fixture id under the fake profile; each must resolve its
  // own vendor's case (`codex: partial-stream-survives-kill` vs `claude: ...`), not
  // silently share one.
  const claudeRecord = await runner.runCell("claude-adapter", "fake", "partial-stream-survives-kill");
  const codexRecord = await runner.runCell("codex-adapter", "fake", "partial-stream-survives-kill");
  assert.equal(claudeRecord.disposition, "pass");
  assert.equal(codexRecord.disposition, "pass");
});

// ---------------------------------------------------------------------------
// Whole-test-file shape
// ---------------------------------------------------------------------------

test("whole-test-file shape: spawns node --test and captures exit-code disposition", { timeout: TIMEOUT_MS }, async () => {
  const runner = createCellRunner("evalrun-wholefile");
  const record = await runner.runCell("importer", "fake", "legacy-import");

  assert.equal(record.shape, "whole-test-file");
  assert.equal(record.disposition, "pass");
  assert.equal(record.process.exitCode, 0);
  assert.ok(typeof record.process.pid === "number");
  assert.equal(record.git, null, "Whole-test-file has no single coherent workspace boundary (C3): negative scope");
  assert.equal(record.board, null);
  assert.ok(record.vendorStdout && Object.keys(record.vendorStdout).length === 1);
});

test("whole-test-file shape: a failing spawned file maps to disposition fail", { timeout: TIMEOUT_MS }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cell-runner-wholefile-"));
  const failingFile = path.join(tmpDir, "synthetic-failing.test.ts");
  fs.writeFileSync(
    failingFile,
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("this deliberately fails", () => { assert.equal(1, 2); });',
      "",
    ].join("\n"),
  );
  try {
    const outcome = await runWholeTestFile(failingFile);
    assert.equal(outcome.disposition, "fail");
    assert.notEqual(outcome.exitCode, 0);
    assert.match(outcome.dispositionDetail ?? "", /exited with code/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Live shape
// ---------------------------------------------------------------------------

test("live shape: ORGA_LIVE unset resolves to a skipped disposition, no re-probed snapshot fields", { timeout: TIMEOUT_MS }, async () => {
  assert.notEqual(process.env.ORGA_LIVE, "1", "this test assumes ORGA_LIVE is not set in the test environment");
  const runner = createCellRunner("evalrun-live-skip");

  const singleRecord = await runner.runCell("git-integrator", "claude", "live-single-task");
  assert.equal(singleRecord.shape, "live");
  assert.equal(singleRecord.disposition, "skipped");
  assert.match(singleRecord.dispositionDetail ?? "", /ORGA_LIVE/);
  assert.equal(singleRecord.snapshot.cliVersion, null);
  assert.equal(singleRecord.snapshot.workflowRevision, null);
  assert.equal(singleRecord.snapshot.model, null);
  assert.ok(singleRecord.snapshot.resolvedConfig, "the engine's own resolveVendorProfile call must still populate this");
  assert.equal((singleRecord.snapshot.resolvedConfig as { executable?: string }).executable, "claude");
  assert.equal(singleRecord.git, null);
  assert.equal(singleRecord.board, null);

  const drainRecord = await runner.runCell("scheduler", "codex", "live-board-drain");
  assert.equal(drainRecord.shape, "live");
  assert.equal(drainRecord.disposition, "skipped");
  assert.equal((drainRecord.snapshot.resolvedConfig as { executable?: string }).executable, "codex");
});

test("live shape: mapLiveOutcome — live-single-task maps all four state values", () => {
  const succeeded = mapLiveOutcome("live-single-task", {
    skipped: false,
    runId: "r1",
    state: "succeeded",
    vendor: "claude",
    model: "sonnet",
    effort: "medium",
    cliVersion: "1.2.3",
    workflowRevision: "abc",
    wallTimeMs: 10,
    stages: [],
  });
  assert.equal(succeeded.disposition, "pass");
  assert.equal(succeeded.snapshotFields.cliVersion, "1.2.3");
  assert.equal(succeeded.snapshotFields.model, "sonnet");

  for (const state of ["failed", "blocked", "cancelled"] as const) {
    const outcome = mapLiveOutcome("live-single-task", {
      skipped: false,
      runId: "r1",
      state,
      vendor: "claude",
      model: "sonnet",
      effort: "medium",
      cliVersion: "1.2.3",
      workflowRevision: "abc",
      wallTimeMs: 10,
      stages: [],
    });
    assert.equal(outcome.disposition, "fail", `state "${state}" must map to fail`);
    assert.match(outcome.dispositionDetail ?? "", new RegExp(state));
  }
});

test("live shape: mapLiveOutcome — live-board-drain's resolved branch is always pass with null snapshot fields", () => {
  const outcome = mapLiveOutcome("live-board-drain", {
    skipped: false,
    runId: "r1",
    state: "succeeded",
    vendor: "codex",
    wallTimeMs: 10,
    taskDispositions: {},
    attempts: [],
  });
  assert.equal(outcome.disposition, "pass");
  assert.equal(outcome.dispositionDetail, null);
  assert.deepEqual(outcome.snapshotFields, { cliVersion: null, workflowRevision: null, model: null });
});

test("live shape: a resolved {skipped: true} maps to disposition skipped for either id", () => {
  const single = mapLiveOutcome("live-single-task", { skipped: true, reason: "claude CLI is not installed" });
  assert.equal(single.disposition, "skipped");
  assert.equal(single.dispositionDetail, "claude CLI is not installed");

  const drain = mapLiveOutcome("live-board-drain", { skipped: true, reason: "codex CLI is not installed" });
  assert.equal(drain.disposition, "skipped");
  assert.equal(drain.dispositionDetail, "codex CLI is not installed");
});

test(
  "live shape: a thrown rejection is disposition fail for either id — live-board-drain's realistic fail path",
  { timeout: TIMEOUT_MS },
  async () => {
    const boardDrainOutcome = await runLiveInvocation("live-board-drain", "codex", async () => {
      throw new Error("live-board-drain (codex): run did not rest succeeded; run={...}");
    });
    assert.equal(boardDrainOutcome.disposition, "fail");
    assert.match(boardDrainOutcome.dispositionDetail ?? "", /did not rest succeeded/);
    assert.deepEqual(boardDrainOutcome.snapshotFields, { cliVersion: null, workflowRevision: null, model: null });

    const singleTaskOutcome = await runLiveInvocation("live-single-task", "claude", async () => {
      throw new Error("live-single-task (claude): run did not reach a terminal state");
    });
    assert.equal(singleTaskOutcome.disposition, "fail");
    assert.match(singleTaskOutcome.dispositionDetail ?? "", /did not reach a terminal state/);
  },
);

// ---------------------------------------------------------------------------
// harness.ts additive-change regression check
// ---------------------------------------------------------------------------

test(
  "harness.ts capture-context hooks are true no-ops outside an opened context",
  { timeout: TIMEOUT_MS },
  async () => {
    assert.equal(captureContext.getStore(), undefined, "no context should be active outside the engine");
    // Calling a real fixture directly, exactly as `test/fixtures.test.ts` does for all
    // ~40 fixtures, must behave identically whether or not this file's capture-context
    // hooks were ever added.
    await boardNotDrained();
    assert.equal(captureContext.getStore(), undefined, "the hooks must never leak an active context");
  },
);
