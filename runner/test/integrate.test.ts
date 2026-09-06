import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import {
  advanceDestination,
  buildReviewTree,
  commitOnBranch,
  createCandidateWorkspace,
  headSha,
  readRefSha,
  replayTaskBranch,
  resolveDestinationRef,
} from "../src/git/integrate.ts";

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function commitFile(dir: string, relPath: string, contents: string, message: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", message, "--", relPath]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

// Mirrors `workspace.test.ts:52-69`'s own project setup: orga.yaml and
// .gitignore tracked, .orga/ gitignored, so a worktree checks out orga.yaml
// and no .orga/, per D18.
function setupProject(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  const seed = commitFile(dir, "seed.txt", "seed\n", "seed");
  initProject(dir);
  runGit(dir, ["add", "--", "orga.yaml", ".gitignore"]);
  runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init orga project"]);
  return seed;
}

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare("INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)").run(
      runId,
      "board.yaml",
      "running",
      "starting",
      now,
    );
  });
}

test("resolveDestinationRef: resolves to refs/heads/<current branch>", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const branch = runGit(dir, ["symbolic-ref", "--short", "HEAD"]);
    assert.equal(resolveDestinationRef(dir), `refs/heads/${branch}`);
  });
});

test("createCandidateWorkspace: a detached worktree at the given sha, distinct from the task's own worktree", async () => {
  await withTempWorkspace(async (dir) => {
    const destinationSha = setupProject(dir);
    const taskWorktreePath = path.join(dir, ".orga", "worktrees", "task-1");
    runGit(dir, ["worktree", "add", taskWorktreePath, "-b", "orga/task/task-1", destinationSha]);

    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const candidatePath = path.join(dir, ".orga", "worktrees", "run-1", "task-1-candidate-1");
      const handle = createCandidateWorkspace({
        db,
        runId: "run-1",
        taskId: "task-1",
        projectRoot: dir,
        candidatePath,
        destinationSha,
      });

      assert.equal(handle.path, candidatePath);
      assert.equal(handle.baseCommit, destinationSha);
      assert.notEqual(handle.path, taskWorktreePath, "the candidate is a distinct worktree from the task's own");
      assert.equal(headSha(candidatePath), destinationSha);
      assert.equal(headSha(taskWorktreePath), destinationSha, "the task worktree is never checked out to another commit");

      const row = db
        .prepare(`SELECT path, cleanup_state, base_commit FROM worktrees WHERE run_id = ? AND path = ?`)
        .get("run-1", candidatePath) as { path: string; cleanup_state: string; base_commit: string } | undefined;
      assert.ok(row, "a worktrees row is recorded for the candidate");
      assert.equal(row?.cleanup_state, "active");
      assert.equal(row?.base_commit, destinationSha);
    } finally {
      db.close();
    }
  });
});

test("createCandidateWorkspace: HEAD is detached (git symbolic-ref -q HEAD fails)", async () => {
  await withTempWorkspace(async (dir) => {
    const destinationSha = setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const candidatePath = path.join(dir, ".orga", "worktrees", "run-1", "task-1-candidate-1");
      createCandidateWorkspace({ db, runId: "run-1", taskId: "task-1", projectRoot: dir, candidatePath, destinationSha });

      assert.throws(() => runGit(candidatePath, ["symbolic-ref", "-q", "HEAD"]), /failed/i, "HEAD is detached, not on a branch");
    } finally {
      db.close();
    }
  });
});

test("replayTaskBranch: a clean cherry-pick lands the task branch's commits on the candidate", async () => {
  await withTempWorkspace(async (dir) => {
    const destinationSha = setupProject(dir);
    runGit(dir, ["branch", "task-branch", destinationSha]);
    runGit(dir, ["checkout", "task-branch"]);
    const taskCommit = commitFile(dir, "feature.txt", "feature\n", "add feature");
    runGit(dir, ["checkout", "-"]);

    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const candidatePath = path.join(dir, ".orga", "worktrees", "run-1", "task-1-candidate-1");
      createCandidateWorkspace({ db, runId: "run-1", taskId: "task-1", projectRoot: dir, candidatePath, destinationSha });

      const result = replayTaskBranch({ candidatePath, baseCommit: destinationSha, taskBranch: "task-branch" });
      assert.equal(result.ok, true);
      assert.ok(fs.existsSync(path.join(candidatePath, "feature.txt")), "the task branch's file landed in the candidate");
      assert.notEqual(headSha(candidatePath), taskCommit, "cherry-pick makes a new commit, not a ref move");
    } finally {
      db.close();
    }
  });
});

test("replayTaskBranch: a conflicting cherry-pick aborts, reports the conflicting paths, and leaves the candidate clean", async () => {
  await withTempWorkspace(async (dir) => {
    const seedSha = setupProject(dir);
    commitFile(dir, "shared.txt", "destination version\n", "destination edits shared.txt");
    const destinationSha = runGit(dir, ["rev-parse", "HEAD"]);

    runGit(dir, ["branch", "task-branch", seedSha]);
    runGit(dir, ["checkout", "task-branch"]);
    commitFile(dir, "shared.txt", "task version\n", "task edits shared.txt");
    runGit(dir, ["checkout", "-"]);

    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const candidatePath = path.join(dir, ".orga", "worktrees", "run-1", "task-1-candidate-1");
      createCandidateWorkspace({ db, runId: "run-1", taskId: "task-1", projectRoot: dir, candidatePath, destinationSha });

      const result = replayTaskBranch({ candidatePath, baseCommit: seedSha, taskBranch: "task-branch" });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.deepEqual(result.conflict.conflictingPaths, ["shared.txt"]);
      }
      assert.equal(runGit(candidatePath, ["status", "--porcelain"]), "", "the candidate's cherry-pick is aborted cleanly");
    } finally {
      db.close();
    }
  });
});

test("advanceDestination: succeeds and moves the ref when expectedOldSha matches", async () => {
  await withTempWorkspace(async (dir) => {
    const destinationSha = setupProject(dir);
    const newSha = commitFile(dir, "advanced.txt", "advanced\n", "advance");
    runGit(dir, ["update-ref", "refs/heads/scratch", destinationSha]);

    const ok = advanceDestination({ projectRoot: dir, ref: "refs/heads/scratch", newSha, expectedOldSha: destinationSha });
    assert.equal(ok, true);
    assert.equal(readRefSha(dir, "refs/heads/scratch"), newSha);
  });
});

test("advanceDestination: fails without moving the ref when expectedOldSha is stale", async () => {
  await withTempWorkspace(async (dir) => {
    const destinationSha = setupProject(dir);
    runGit(dir, ["update-ref", "refs/heads/scratch", destinationSha]);
    const externalSha = commitFile(dir, "external.txt", "external\n", "external move");
    runGit(dir, ["update-ref", "refs/heads/scratch", externalSha]);

    const staleNewSha = commitFile(dir, "stale.txt", "stale\n", "stale candidate");
    const ok = advanceDestination({ projectRoot: dir, ref: "refs/heads/scratch", newSha: staleNewSha, expectedOldSha: destinationSha });
    assert.equal(ok, false);
    assert.equal(readRefSha(dir, "refs/heads/scratch"), externalSha, "no forced update: the external move stands");
  });
});

test("buildReviewTree: excludes unrelated staged content from the returned tree and leaves the real index untouched", async () => {
  await withTempWorkspace(async (dir) => {
    const destinationSha = setupProject(dir);

    fs.writeFileSync(path.join(dir, "unrelated.txt"), "unrelated\n", "utf8");
    runGit(dir, ["add", "--", "unrelated.txt"]);
    fs.writeFileSync(path.join(dir, "claimed.txt"), "claimed\n", "utf8");

    const indexBefore = fs.readFileSync(path.join(dir, ".git", "index"));
    const statusBefore = runGit(dir, ["status", "--porcelain"]);

    const tree = buildReviewTree({ projectRoot: dir, destinationSha, claimedPaths: ["claimed.txt"] });

    const treeEntries = runGit(dir, ["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean);
    assert.deepEqual(
      treeEntries.sort(),
      ["claimed.txt", "seed.txt"],
      "the returned tree carries the destination's content plus only the claimed path, never the unrelated staged file",
    );

    const indexAfter = fs.readFileSync(path.join(dir, ".git", "index"));
    assert.ok(indexBefore.equals(indexAfter), "the real index is byte-for-byte unchanged");
    assert.equal(runGit(dir, ["status", "--porcelain"]), statusBefore, "git status is unchanged after building the review tree");
  });
});

test("commitOnBranch: excludes unrelated staged content from the landed commit but leaves it staged afterward", async () => {
  await withTempWorkspace(async (dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    const before = commitFile(dir, "seed.txt", "seed\n", "seed");

    fs.writeFileSync(path.join(dir, "unrelated.txt"), "unrelated\n", "utf8");
    runGit(dir, ["add", "--", "unrelated.txt"]);
    fs.writeFileSync(path.join(dir, "claimed.txt"), "claimed\n", "utf8");

    const sha = commitOnBranch({ projectRoot: dir, claimedPaths: ["claimed.txt"], message: "land claimed.txt" });

    assert.equal(runGit(dir, ["rev-parse", "HEAD"]), sha);
    assert.equal(runGit(dir, ["rev-parse", "HEAD^"]), before, "exactly one new commit, parented at the prior tip");
    const landed = runGit(dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
    assert.deepEqual(
      landed.sort(),
      ["claimed.txt", "seed.txt"],
      "the landed commit carries only seed.txt and the claimed path, never the unrelated staged file",
    );
    assert.equal(
      runGit(dir, ["diff", "--cached", "--name-only"]),
      "unrelated.txt",
      "the unrelated file remains staged after landing, never swept or reset",
    );
  });
});

test("commitOnBranch: an empty claim set lands a true zero-diff commit, its tree identical to its parent's, and leaves staged dirt untouched", async () => {
  await withTempWorkspace(async (dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    const before = commitFile(dir, "seed.txt", "seed\n", "seed");

    fs.writeFileSync(path.join(dir, "unrelated.txt"), "unrelated\n", "utf8");
    runGit(dir, ["add", "--", "unrelated.txt"]);

    const sha = commitOnBranch({ projectRoot: dir, claimedPaths: [], message: "empty claim set" });

    assert.equal(runGit(dir, ["rev-parse", "HEAD"]), sha);
    assert.equal(runGit(dir, ["rev-parse", "HEAD^"]), before, "exactly one new commit, parented at the prior tip");
    assert.equal(
      runGit(dir, ["rev-parse", `${sha}^{tree}`]),
      runGit(dir, ["rev-parse", `${before}^{tree}`]),
      "the landed commit's tree is identical to its parent's: a true zero-diff commit",
    );
    assert.equal(
      runGit(dir, ["diff", "--cached", "--name-only"]),
      "unrelated.txt",
      "staged dirt remains untouched by an empty-claim-set commit",
    );
  });
});

test("integrate.ts issues no git merge, rebase, push, or reset command", () => {
  const source = fs.readFileSync(new URL("../src/git/integrate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["'](merge|rebase|push|reset)["']/);
});
