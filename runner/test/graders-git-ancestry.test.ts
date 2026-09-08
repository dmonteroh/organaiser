import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gradeGitAncestry, readFrozenCell } from "../evals/graders/index.ts";

function makeCellDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graders-git-ancestry-test-"));
}

function writeArtifact(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, "utf8");
}

function graphText(commitLines: readonly string[], truncated = false): string {
  const lines = ["REFS:", "COMMITS:", ...commitLines];
  if (truncated) lines.push("TRUNCATED: 500");
  return lines.join("\n") + "\n";
}

function headText(sha: string): string {
  return `HEAD ${sha}\nclean`;
}

const ROOT = "0".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const BRANCH = "4".repeat(40);
const OTHER = "5".repeat(40);
const CLOSED_TIP = "6".repeat(40);
const DANGLING_PARENT = "7".repeat(40);
const UNRECORDED_COMMIT = "8".repeat(40);

test("git-ancestry: fast-forward (before is an ancestor of after) is pass", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C3));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C3} ${C2}`, `${C2} ${C1}`, `${C1} ${ROOT}`, ROOT]));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("git-ancestry: no-move (before equals after) is pass", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C1} ${ROOT}`, ROOT]));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("git-ancestry: rewritten-lineage (closed graph, before not reachable from after) is fail", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(BRANCH));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${BRANCH} ${ROOT}`, `${C1} ${ROOT}`, ROOT]));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.equal(check.detail, `before-HEAD ${C1} is not an ancestor of after-HEAD ${BRANCH}`);
});

test("git-ancestry: no-git-capture (all three git files empty) is not-applicable", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", "");
  writeArtifact(dir, "git-after.txt", "");
  writeArtifact(dir, "git-commit-graph.txt", "");
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "not-applicable");
  assert.equal(check.detail, null);
});

test("git-ancestry: missing git-commit-graph.txt (run frozen before P9f-e) is operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
  assert.equal(check.detail, "git-commit-graph.txt is missing");
});

test("git-ancestry: truncated graph, walk hits an unrecorded parent without finding before-HEAD, is operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(OTHER));
  writeArtifact(dir, "git-after.txt", headText(CLOSED_TIP));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${CLOSED_TIP} ${DANGLING_PARENT}`], true));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
  assert.equal(
    check.detail,
    `the frozen commit graph is incomplete: the walk from after-HEAD ${CLOSED_TIP} reached commits whose parents are not recorded (graph truncated at 500)`,
  );
});

test("git-ancestry: truncated graph but a closed walk that never finds before-HEAD is still fail", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(CLOSED_TIP));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${CLOSED_TIP} ${ROOT}`, ROOT], true));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.equal(check.detail, `before-HEAD ${C1} is not an ancestor of after-HEAD ${CLOSED_TIP}`);
});

test("git-ancestry: no before-HEAD recorded beside a populated after-HEAD and graph is pass", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", "");
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C1} ${ROOT}`, ROOT]));
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, "no before-HEAD recorded; graded after-HEAD presence in the frozen commit graph only");
});

test("git-ancestry: a board task recording a non-sha result_commit is fail", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C1} ${ROOT}`, ROOT]));
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "board-after.yaml", "run: null\ntasks:\n  - id: t1\n    result_commit: not-a-sha\n");
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.equal(check.detail, 'task t1 records commit identity "not-a-sha", which is not a concrete sha');
});

test("git-ancestry: a well-formed result_commit absent from a non-truncated graph is fail", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C1} ${ROOT}`, ROOT]));
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "board-after.yaml", `run: null\ntasks:\n  - id: t1\n    result_commit: "${UNRECORDED_COMMIT}"\n`);
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "fail");
  assert.equal(
    check.detail,
    `task t1 records commit identity ${UNRECORDED_COMMIT}, which is not present in the frozen commit graph`,
  );
});

test("git-ancestry: a well-formed result_commit absent from a truncated graph is operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C1} ${ROOT}`, ROOT], true));
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "board-after.yaml", `run: null\ntasks:\n  - id: t1\n    result_commit: "${UNRECORDED_COMMIT}"\n`);
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
  assert.equal(
    check.detail,
    `task t1 records commit identity ${UNRECORDED_COMMIT}, which is not present in the frozen commit graph`,
  );
});

test("git-ancestry: a well-formed result_commit present in the graph is pass (positive control)", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", graphText([`${C1} ${ROOT}`, ROOT]));
  writeArtifact(dir, "board-before.yaml", "run: null\ntasks: []\n");
  writeArtifact(dir, "board-after.yaml", `run: null\ntasks:\n  - id: t1\n    result_commit: "${ROOT}"\n`);
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "pass");
  assert.equal(check.detail, null);
});

test("git-ancestry: an empty commit graph beside a real after-HEAD is operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", "");
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", "");
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
  assert.equal(check.detail, "git-commit-graph.txt is empty for a cell that recorded a git HEAD");
});

test("git-ancestry: a commit graph missing the REFS:/COMMITS: markers is operational-failure", () => {
  const dir = makeCellDir();
  writeArtifact(dir, "git-before.txt", headText(C1));
  writeArtifact(dir, "git-after.txt", headText(C1));
  writeArtifact(dir, "git-commit-graph.txt", `${C1} ${ROOT}\n${ROOT}\n`);
  const check = gradeGitAncestry(readFrozenCell(dir));
  assert.equal(check.outcome, "operational-failure");
  assert.equal(check.detail, "git-commit-graph.txt is malformed");
});
