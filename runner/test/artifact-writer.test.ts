import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeCellArtifacts } from "../evals/artifact-writer.ts";
import type { CapturedCellRecord } from "../evals/cell-runner.ts";

const FOURTEEN_ARTIFACT_NAMES = [
  "eval-snapshot.json",
  "fixture-base.txt",
  "resolved-config.json",
  "process.json",
  "events.jsonl",
  "vendor-stdout.jsonl",
  "vendor-stderr.log",
  "worker-report.json",
  "board-before.yaml",
  "board-after.yaml",
  "state-transitions.jsonl",
  "git-before.txt",
  "git-after.txt",
  "diff.patch",
];

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fullRecord(overrides: Partial<CapturedCellRecord> = {}): CapturedCellRecord {
  return {
    cellId: "cell-1",
    evalRunId: "eval-run-1",
    unit: "scheduler",
    profile: "fake",
    fixtureId: "fixture-1",
    shape: "sequence",
    disposition: "pass",
    dispositionDetail: null,
    constituents: [
      {
        name: "step-1",
        disposition: "pass",
        error: null,
        evidence: {
          git: null,
          board: null,
          recordedPgids: null,
          vendorStdout: null,
          events: null,
          stateTransitions: null,
          workerReport: null,
        },
      },
      {
        name: "step-2",
        disposition: "pass",
        error: null,
        evidence: {
          git: null,
          board: null,
          recordedPgids: null,
          vendorStdout: null,
          events: null,
          stateTransitions: null,
          workerReport: null,
        },
      },
    ],
    snapshot: {
      prompt: "fixture-1",
      taskFixture: "step-1 | step-2",
      cliVersion: "fake-adapter-stream/1",
      workflowRevision: "wf-rev-1",
      model: "fake",
      resolvedConfig: { vendor: "fake", model: "fake", cliVersion: "fake-adapter-stream/1" },
    },
    git: {
      before: "HEAD abc123\nclean",
      after: "HEAD def456\nclean",
      diff: "diff --git a/x b/x\n+hello\n",
    },
    board: {
      before: {
        run: { id: "run-1", state: "active", config_snapshot_ref: JSON.stringify({ a: 1 }) },
        tasks: [{ id: "t1", task_key: "k1", depends_on: JSON.stringify(["t0"]) }],
      },
      after: {
        run: { id: "run-1", state: "done", config_snapshot_ref: JSON.stringify({ a: 1 }) },
        tasks: [{ id: "t1", task_key: "k1", depends_on: JSON.stringify(["t0"]) }],
      },
    },
    process: { recordedPgids: [111, 222], pid: 999, exitCode: 0, wallTimeMs: 1234 },
    vendorStdout: { "worker.jsonl": '{"op":"report"}' },
    vendorStderr: null,
    events: [{ type: "task.transitioned", seq: 1 }],
    stateTransitions: [{ type: "task.transitioned", seq: 1 }],
    workerReport: { status: "ok" },
    ...overrides,
  };
}

test("artifact-writer: writes exactly the fourteen named artifacts and no others (AC1, AC9)", () => {
  const cellDir = path.join(makeTmpDir("artifact-writer-"), "nested", "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(fullRecord(), cellDir, root);

  const written = fs.readdirSync(cellDir).sort();
  assert.deepEqual(written, [...FOURTEEN_ARTIFACT_NAMES].sort());
});

test("artifact-writer: creates a non-existent cell directory recursively (AC1)", () => {
  const parent = makeTmpDir("artifact-writer-");
  const cellDir = path.join(parent, "a", "b", "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  assert.equal(fs.existsSync(cellDir), false);
  writeCellArtifacts(fullRecord(), cellDir, root);
  assert.equal(fs.existsSync(cellDir), true);
});

test("artifact-writer: never writes grading.json or metrics.json (AC6)", () => {
  const cellDir = path.join(makeTmpDir("artifact-writer-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(fullRecord(), cellDir, root);

  assert.equal(fs.existsSync(path.join(cellDir, "grading.json")), false);
  assert.equal(fs.existsSync(path.join(cellDir, "metrics.json")), false);
});

test("artifact-writer: writing the same record twice produces byte-identical artifacts (AC7)", () => {
  const record = fullRecord();
  const cellDirA = path.join(makeTmpDir("artifact-writer-a-"), "cell-1");
  const cellDirB = path.join(makeTmpDir("artifact-writer-b-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(record, cellDirA, root);
  writeCellArtifacts(record, cellDirB, root);

  for (const name of FOURTEEN_ARTIFACT_NAMES) {
    const contentA = fs.readFileSync(path.join(cellDirA, name));
    const contentB = fs.readFileSync(path.join(cellDirB, name));
    assert.ok(contentA.equals(contentB), `mismatch for ${name}`);
  }
});

test("artifact-writer: null/absent fields produce deterministic empty artifacts, still byte-identical across writes (AC7)", () => {
  const record = fullRecord({
    constituents: null,
    git: null,
    board: null,
    vendorStdout: null,
    vendorStderr: null,
    events: null,
    stateTransitions: null,
    workerReport: null,
    process: { recordedPgids: null, pid: null, exitCode: null, wallTimeMs: 0 },
    snapshot: {
      prompt: "fixture-1",
      taskFixture: "fixture-1",
      cliVersion: null,
      workflowRevision: null,
      model: null,
      resolvedConfig: null,
    },
  });
  const cellDirA = path.join(makeTmpDir("artifact-writer-null-a-"), "cell-1");
  const cellDirB = path.join(makeTmpDir("artifact-writer-null-b-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(record, cellDirA, root);
  writeCellArtifacts(record, cellDirB, root);

  assert.equal(fs.readFileSync(path.join(cellDirA, "events.jsonl"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "state-transitions.jsonl"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "vendor-stdout.jsonl"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "vendor-stderr.log"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "git-before.txt"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "git-after.txt"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "diff.patch"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(cellDirA, "board-before.yaml"), "utf8"), "run: null\ntasks: []\n");
  assert.equal(fs.readFileSync(path.join(cellDirA, "board-after.yaml"), "utf8"), "run: null\ntasks: []\n");

  for (const name of FOURTEEN_ARTIFACT_NAMES) {
    const contentA = fs.readFileSync(path.join(cellDirA, name));
    const contentB = fs.readFileSync(path.join(cellDirB, name));
    assert.ok(contentA.equals(contentB), `mismatch for ${name}`);
  }
});

test("artifact-writer: board-before.yaml and board-after.yaml are genuine YAML block form, not JSON (AC2)", () => {
  const cellDir = path.join(makeTmpDir("artifact-writer-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(fullRecord(), cellDir, root);

  const before = fs.readFileSync(path.join(cellDir, "board-before.yaml"), "utf8");
  assert.ok(before.startsWith("run:\n  id: run-1"), before);
  assert.ok(before.includes("tasks:\n  - id: t1"), before);
  assert.ok(!before.trimStart().startsWith("{"), before);
  assert.ok(before.includes('depends_on: "[\\"t0\\"]"'), before);
});

test("artifact-writer: an injected secret env value is redacted in the written artifacts, not left raw (AC5)", () => {
  const cellDir = path.join(makeTmpDir("artifact-writer-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");
  const secret = "sk-test-secret-value-1234567890";
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = secret;

  try {
    const record = fullRecord({
      vendorStdout: { "worker.jsonl": `token=${secret}` },
      git: {
        before: `HEAD abc123 ${secret}\nclean`,
        after: "HEAD def456\nclean",
        diff: "diff --git a/x b/x\n+hello\n",
      },
    });

    writeCellArtifacts(record, cellDir, root);

    const vendorStdout = fs.readFileSync(path.join(cellDir, "vendor-stdout.jsonl"), "utf8");
    const gitBefore = fs.readFileSync(path.join(cellDir, "git-before.txt"), "utf8");

    assert.ok(vendorStdout.includes("[REDACTED]"), vendorStdout);
    assert.ok(!vendorStdout.includes(secret), vendorStdout);
    assert.ok(gitBefore.includes("[REDACTED]"), gitBefore);
    assert.ok(!gitBefore.includes(secret), gitBefore);
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previous;
    }
  }
});

test("artifact-writer: eval-snapshot.json carries identity/outcome/snapshot fields but not resolvedConfig", () => {
  const cellDir = path.join(makeTmpDir("artifact-writer-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(fullRecord(), cellDir, root);

  const snapshot = JSON.parse(fs.readFileSync(path.join(cellDir, "eval-snapshot.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(snapshot.cellId, "cell-1");
  assert.equal(snapshot.evalRunId, "eval-run-1");
  assert.equal(snapshot.shape, "sequence");
  assert.equal(snapshot.disposition, "pass");
  const nestedSnapshot = snapshot.snapshot as Record<string, unknown>;
  assert.equal(nestedSnapshot.taskFixture, "step-1 | step-2");
  assert.equal("resolvedConfig" in nestedSnapshot, false);
  assert.equal("resolvedConfig" in snapshot, false);
});

test("artifact-writer: fixture-base.txt is the taskFixture value verbatim", () => {
  const cellDir = path.join(makeTmpDir("artifact-writer-"), "cell-1");
  const root = makeTmpDir("artifact-writer-root-");

  writeCellArtifacts(fullRecord(), cellDir, root);

  assert.equal(fs.readFileSync(path.join(cellDir, "fixture-base.txt"), "utf8"), "step-1 | step-2");
});
