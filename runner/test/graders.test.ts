import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STAGE_DEFINITIONS } from "../src/engine/scheduler.ts";
import { LEGAL_TRANSITIONS } from "../evals/graders/legal-order.ts";
import {
  gradeDiffScope,
  gradeGitAncestry,
  gradeProcessCount,
  gradeTaskDisposition,
  gradeTransitionOrder,
  readFrozenCell,
  type FrozenCellBundle,
} from "../evals/graders/index.ts";

function makeCellDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graders-test-"));
}

function writeArtifact(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, "utf8");
}

function jsonl(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function transitionRow(seq: number, taskId: string, fromStageId: string, result: string, target: string): Record<string, unknown> {
  return {
    id: `evt-${seq}`,
    run_id: "run-1",
    seq,
    task_id: taskId,
    attempt_id: null,
    type: "task.transitioned",
    payload: JSON.stringify({ fromStageId, result, target }),
    created_at: 0,
  };
}

const FULL_LIFECYCLE: ReadonlyArray<readonly [string, string, string]> = [
  ["admit-task", "true", "release-dependencies"],
  ["release-dependencies", "true", "acquire-claims"],
  ["acquire-claims", "true", "admit-to-batch"],
  ["admit-to-batch", "true", "product-specification"],
  ["product-specification", "specified", "task-refinement"],
  ["task-refinement", "ready-to-implement", "implementation"],
  ["implementation", "integrating", "integration-candidate"],
  ["integration-candidate", "true", "integration"],
  ["integration", "integrated", "reconcile-outcome"],
  ["reconcile-outcome", "integrated", "integrated"],
];

function fullLifecycleRows(taskId: string): Record<string, unknown>[] {
  return FULL_LIFECYCLE.map(([fromStageId, result, target], index) => transitionRow(index + 1, taskId, fromStageId, result, target));
}

function evalSnapshotJson(disposition: "pass" | "fail" | "skipped"): string {
  return (
    JSON.stringify(
      {
        cellId: "c1",
        evalRunId: "r1",
        unit: "u",
        profile: "p",
        fixtureId: "f",
        shape: "single",
        disposition,
        dispositionDetail: null,
        snapshot: {},
      },
      null,
      2,
    ) + "\n"
  );
}

function processJson(overrides: Partial<{ recordedPgids: unknown; pid: number | null; exitCode: number | null; wallTimeMs: number }> = {}): string {
  return JSON.stringify({ recordedPgids: [], pid: null, exitCode: 0, wallTimeMs: 0, ...overrides }, null, 2) + "\n";
}

test("transition-order: pass on a legal full lifecycle", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("transition-order: a task seeded mid-lifecycle (not starting at admit-task) still passes", () => {
  const dir = makeCellDir();
  const rows = [
    transitionRow(1, "t1", "implementation", "integrating", "integration-candidate"),
    transitionRow(2, "t1", "integration-candidate", "true", "integration"),
  ];
  writeArtifact(dir, "state-transitions.jsonl", jsonl(rows));
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
});

test("transition-order: missing state-transitions.jsonl yields operational-failure", () => {
  const dir = makeCellDir();
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("transition-order: unparseable state-transitions.jsonl yields operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "state-transitions.jsonl", "not-json\n");
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("transition-order: zero task.transitioned rows yields not-applicable", () => {
  const dir = makeCellDir();
  writeArtifact(
    dir,
    "state-transitions.jsonl",
    jsonl([{ id: "evt-1", run_id: "run-1", seq: 1, task_id: null, attempt_id: null, type: "other.event", payload: "{}", created_at: 0 }]),
  );
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "not-applicable");
  assert.equal(check.detail, null);
});

test("transition-order: fails on an event with an unknown fromStageId", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "state-transitions.jsonl", jsonl([transitionRow(1, "t1", "bogus-stage", "true", "release-dependencies")]));
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /no legal-order entry/);
});

test("transition-order: fails when the legal target for a result does not match the recorded target", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "state-transitions.jsonl", jsonl([transitionRow(1, "t1", "admit-task", "true", "acquire-claims")]));
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /expected "release-dependencies"/);
});

test("transition-order: fails when a successor's fromStageId does not match its predecessor's target", () => {
  const dir = makeCellDir();
  const rows = [transitionRow(1, "t1", "admit-task", "true", "release-dependencies"), transitionRow(2, "t1", "acquire-claims", "true", "admit-to-batch")];
  writeArtifact(dir, "state-transitions.jsonl", jsonl(rows));
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /does not match predecessor's target/);
});

test("transition-order: fails on an event recorded after the task already reached a terminal disposition", () => {
  const dir = makeCellDir();
  const rows = [transitionRow(1, "t1", "reconcile-outcome", "integrated", "integrated"), transitionRow(2, "t1", "admit-task", "true", "release-dependencies")];
  writeArtifact(dir, "state-transitions.jsonl", jsonl(rows));
  const check = gradeTransitionOrder(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /reached terminal disposition "integrated"/);
});

test("process-count: pass with distinct pgids not equal to pid", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: [200, 300], pid: 999 }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("process-count: pass on an empty recordedPgids array", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: [] }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
});

test("process-count: missing process.json yields operational-failure", () => {
  const dir = makeCellDir();
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("process-count: unparseable process.json yields operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", "{not valid json");
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("process-count: recordedPgids null yields not-applicable", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: null }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "not-applicable");
  assert.equal(check.detail, null);
});

test("process-count: fails on a non-integer entry", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: [200.5] }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /not an integer/);
});

test("process-count: fails on an entry <= 1", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: [1] }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /<= 1/);
});

test("process-count: fails on a duplicate entry", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: [200, 200] }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /duplicate/);
});

test("process-count: fails when an entry equals the cell's own pid", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", processJson({ recordedPgids: [500], pid: 500 }));
  const check = gradeProcessCount(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /equals the cell's own pid/);
});

test("task-disposition: pass when derived terminal target matches the recorded disposition", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("pass"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    disposition: integrated\n");
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("task-disposition: fails when the recorded disposition differs from the derived one", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("pass"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    disposition: shelved\n");
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /derived disposition integrated, recorded disposition shelved/);
});

test("task-disposition: fails when the board task has no recorded disposition but a terminal transition was derived", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("pass"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    task_key: k1\n");
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /derived disposition integrated, recorded disposition \(none\)/);
});

test("task-disposition: not-applicable when the eval cell disposition is not pass", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("fail"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    disposition: integrated\n");
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "not-applicable");
  assert.equal(check.detail, null);
});

test("task-disposition: not-applicable when board-after.yaml has zero tasks", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("pass"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks: []\n");
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "not-applicable");
});

test("task-disposition: missing board-after.yaml yields operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("pass"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("task-disposition: unparseable board-after.yaml yields operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "eval-snapshot.json", evalSnapshotJson("pass"));
  writeArtifact(dir, "state-transitions.jsonl", jsonl(fullLifecycleRows("t1")));
  writeArtifact(dir, "board-after.yaml", "run: null\n\ttasks: []\n");
  const check = gradeTaskDisposition(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("process-count and task-disposition: top-level null JSON artifact yields operational-failure, not a throw", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "process.json", "null");
  writeArtifact(dir, "eval-snapshot.json", "null");
  writeArtifact(dir, "board-after.yaml", "tasks: []\n");
  writeArtifact(dir, "state-transitions.jsonl", "");
  const bundle = readFrozenCell(dir);
  const processCheck = gradeProcessCount(bundle);
  assert.equal(processCheck.outcome, "operational-failure");
  const dispositionCheck = gradeTaskDisposition(bundle);
  assert.equal(dispositionCheck.outcome, "operational-failure");
});

test("diff-scope: pass when every touched path is covered by a claim", () => {
  const dir = makeCellDir();
  const boardAfter =
    ["run: null", "tasks:", "  - id: t1", "    claims:", "      - src/foo.ts", "      - src/bar/", "      - src/baz/**"].join("\n") + "\n";
  writeArtifact(dir, "board-after.yaml", boardAfter);
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  const diff =
    [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 111..222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/bar/qux.ts b/src/bar/qux.ts",
      "new file mode 100644",
      "index 000..333",
      "--- /dev/null",
      "+++ b/src/bar/qux.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/src/baz/deep/thing.ts b/src/baz/deep/thing.ts",
      "index 444..555 100644",
      "--- a/src/baz/deep/thing.ts",
      "+++ b/src/baz/deep/thing.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n") + "\n";
  writeArtifact(dir, "diff.patch", diff);
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("diff-scope: fails when a touched path is not covered by any claim", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    claims:\n      - src/foo.ts\n");
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  const diff =
    ["diff --git a/src/other.ts b/src/other.ts", "index 111..222 100644", "--- a/src/other.ts", "+++ b/src/other.ts", "@@ -1 +1 @@", "-old", "+new"].join(
      "\n",
    ) + "\n";
  writeArtifact(dir, "diff.patch", diff);
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.match(check.detail ?? "", /src\/other\.ts" is not covered/);
});

test("diff-scope: not-applicable when no claim set is recorded on any task", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    task_key: k1\n");
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks:\n  - id: t1\n    task_key: k1\n");
  writeArtifact(dir, "diff.patch", "diff --git a/x b/x\n+hello\n");
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "not-applicable");
  assert.equal(check.detail, null);
});

test("diff-scope: falls back to board-before.yaml's claims when board-after.yaml has none", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    task_key: k1\n");
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks:\n  - id: t1\n    claims:\n      - src/foo.ts\n");
  writeArtifact(dir, "diff.patch", "diff --git a/src/foo.ts b/src/foo.ts\n+hi\n");
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
});

test("diff-scope: an empty diff.patch is valid (not missing) and passes when nothing is touched", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    claims:\n      - src/foo.ts\n");
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "diff.patch", "");
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
});

test("diff-scope: missing diff.patch yields operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("diff-scope: unparseable board-before.yaml yields operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "board-before.yaml", "run: null\n\ttasks: []\n");
  writeArtifact(dir, "diff.patch", "");
  const check = gradeDiffScope(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
});

test("every grader returns a GradingCheck rather than throwing on an all-missing bundle", () => {
  const allMissingBundle: FrozenCellBundle = {
    cellDir: "unused",
    snapshot: { status: "missing" },
    process: { status: "missing" },
    stateTransitions: { status: "missing" },
    boardBefore: { status: "missing" },
    boardAfter: { status: "missing" },
    diff: { status: "missing" },
    gitBefore: { status: "missing" },
    gitAfter: { status: "missing" },
    commitGraph: { status: "missing" },
  };
  for (const grader of [gradeTransitionOrder, gradeProcessCount, gradeTaskDisposition, gradeDiffScope, gradeGitAncestry]) {
    const check = grader(allMissingBundle);
    assert.equal(check.grader, "deterministic");
    assert.equal(check.outcome, "operational-failure");
    assert.equal(typeof check.id, "string");
  }
});

const GRADER_DIR = fileURLToPath(new URL("../evals/graders/", import.meta.url));
const GRADER_FILES = [
  "types.ts",
  "legal-order.ts",
  "frozen-cell-reader.ts",
  "transition-order.ts",
  "process-count.ts",
  "task-disposition.ts",
  "diff-scope.ts",
  "git-ancestry.ts",
  "index.ts",
];
const FORBIDDEN_ALWAYS = ["src/store/", "src/reports/replay.ts", "src/reports/run-replay.ts", '"node:child_process"', "'node:child_process'"];
const FORBIDDEN_FS = ['"node:fs"', "'node:fs'"];

test("no grader-library module imports src/store/, src/reports/replay.ts, src/reports/run-replay.ts, or node:child_process; only frozen-cell-reader.ts imports node:fs", () => {
  for (const file of GRADER_FILES) {
    const source = fs.readFileSync(path.join(GRADER_DIR, file), "utf8");
    for (const specifier of FORBIDDEN_ALWAYS) {
      assert.ok(!source.includes(specifier), `${file} must not reference ${specifier}`);
    }
    if (file === "frozen-cell-reader.ts") continue;
    for (const specifier of FORBIDDEN_FS) {
      assert.ok(!source.includes(specifier), `${file} must not import node:fs`);
    }
  }
});

test("LEGAL_TRANSITIONS equals the {id, transitions} projection of STAGE_DEFINITIONS, id-for-id and target-for-target", () => {
  const projected = STAGE_DEFINITIONS.map((stage) => ({ id: stage.id, transitions: stage.transitions })).sort((a, b) => a.id.localeCompare(b.id));
  const actual = LEGAL_TRANSITIONS.map((stage) => ({ id: stage.id, transitions: stage.transitions })).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(actual, projected);
});
