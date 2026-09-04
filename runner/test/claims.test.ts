import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { observedPaths, validateClaims } from "../src/git/claims.ts";
import type { WorkspaceHandle } from "../src/git/workspace.ts";

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function commitFile(dir: string, relPath: string, contents: string, message: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    message,
    "--",
    relPath,
  ]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function makeRepo(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  return commitFile(dir, "seed.txt", "seed\n", "seed");
}

function handleFor(dir: string, baseCommit: string): WorkspaceHandle {
  return {
    mode: "worktree",
    root: ".orga/worktrees",
    path: dir,
    branch: "orga/task/task-1",
    baseCommit,
    recordedDirt: [],
  };
}

test("observedPaths: reports a modified tracked file and an untracked file relative to baseCommit", async () => {
  await withTempWorkspace(async (dir) => {
    const base = makeRepo(dir);
    fs.writeFileSync(path.join(dir, "seed.txt"), "changed\n", "utf8");
    fs.writeFileSync(path.join(dir, "new-file.txt"), "new\n", "utf8");

    const paths = await observedPaths(handleFor(dir, base));
    assert.deepEqual([...paths].sort(), ["new-file.txt", "seed.txt"]);
  });
});

test("observedPaths: reports nothing when the worktree is unchanged since baseCommit", async () => {
  await withTempWorkspace(async (dir) => {
    const base = makeRepo(dir);
    const paths = await observedPaths(handleFor(dir, base));
    assert.deepEqual(paths, []);
  });
});

test("observedPaths: a committed change since baseCommit is reported too", async () => {
  await withTempWorkspace(async (dir) => {
    const base = makeRepo(dir);
    commitFile(dir, "src/code.txt", "work\n", "worker change");

    const paths = await observedPaths(handleFor(dir, base));
    assert.deepEqual(paths, ["src/code.txt"]);
  });
});

// validateClaims is pure: every case here drives it with literal arrays only.
test("validateClaims: ok is true and outOfClaim is empty when every observed path is claimed", () => {
  const result = validateClaims({
    observed: ["a.txt", "b.txt"],
    claimed: ["a.txt", "b.txt", "c.txt"],
    recordedDirt: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.outOfClaim, []);
});

test("validateClaims: an observed path outside the claim set is reported and fails ok", () => {
  const result = validateClaims({
    observed: ["a.txt", "unclaimed.txt"],
    claimed: ["a.txt"],
    recordedDirt: [],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.outOfClaim, ["unclaimed.txt"]);
});

test("validateClaims: paths in recordedDirt are subtracted from observed before comparison", () => {
  const result = validateClaims({
    observed: ["a.txt", "dirty.txt"],
    claimed: ["a.txt"],
    recordedDirt: ["dirty.txt"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.outOfClaim, []);
});

test("validateClaims: a dirty path outside the claim set is still subtracted, not reported", () => {
  const result = validateClaims({
    observed: ["a.txt", "dirty-and-unclaimed.txt", "unclaimed.txt"],
    claimed: ["a.txt"],
    recordedDirt: ["dirty-and-unclaimed.txt"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.outOfClaim, ["unclaimed.txt"]);
});
