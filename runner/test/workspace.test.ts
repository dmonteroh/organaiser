import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { openStore, withTransaction, findProjectRoot } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import {
  createWorkspace,
  removeWorkspace,
  listUntrackedWorktrees,
  DEFAULT_WORKTREE_ROOT,
  DEFAULT_BRANCH_PREFIX,
  WorkspaceModeNotImplementedError,
  type CreateWorkspaceInput,
  type WorkspaceContext,
} from "../src/git/workspace.ts";

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

// Sets up a git repository at `dir` with an initialized, committed project:
// orga.yaml and .gitignore tracked (per D18, so a worktree checks out
// orga.yaml), .orga/ gitignored and untracked.
function setupProject(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  const seed = commitFile(dir, "seed.txt", "seed\n", "seed");
  initProject(dir);
  runGit(dir, ["add", "--", "orga.yaml", ".gitignore"]);
  runGit(dir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "init orga project",
  ]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "starting", now);
  });
}

function baseInput(overrides: Partial<CreateWorkspaceInput> = {}): Omit<CreateWorkspaceInput, "db" | "projectRoot"> {
  return {
    mode: "worktree",
    runId: "run-1",
    taskId: "task-1",
    taskKey: "task-1",
    ref: "HEAD",
    root: DEFAULT_WORKTREE_ROOT,
    branchPrefix: DEFAULT_BRANCH_PREFIX,
    ...overrides,
  } as Omit<CreateWorkspaceInput, "db" | "projectRoot">;
}

test("createWorkspace: in-place mode throws WorkspaceModeNotImplementedError rather than falling through to worktree behavior", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      await assert.rejects(
        createWorkspace({ ...baseInput({ mode: "in-place" }), db, projectRoot: dir }),
        WorkspaceModeNotImplementedError,
      );
    } finally {
      db.close();
    }
  });
});

test("createWorkspace: runs git worktree add with a resolved 40-char sha, and a non-default root/prefix are used verbatim", async () => {
  await withTempWorkspace(async (dir) => {
    const seed = setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const handle = await createWorkspace({
        ...baseInput({ root: "custom/worktrees", branchPrefix: "custom/prefix/" }),
        db,
        projectRoot: dir,
      });

      assert.equal(handle.mode, "worktree");
      assert.equal(handle.root, "custom/worktrees");
      assert.equal(handle.branch, "custom/prefix/task-1");
      assert.equal(handle.baseCommit, seed);
      assert.match(handle.baseCommit, /^[0-9a-f]{40}$/);
      assert.equal(handle.path, path.resolve(dir, "custom/worktrees", "run-1", "task-1"));
      assert.ok(fs.existsSync(handle.path), "worktree directory must exist on disk");

      const branches = runGit(dir, ["branch", "--list", "custom/prefix/task-1"]);
      assert.ok(branches.includes("custom/prefix/task-1"));
    } finally {
      db.close();
    }
  });
});

test("createWorkspace: recordedDirt is always empty even when the source checkout carries uncommitted changes", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    fs.writeFileSync(path.join(dir, "seed.txt"), "dirty\n", "utf8");

    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const handle = await createWorkspace({ ...baseInput(), db, projectRoot: dir });
      assert.deepEqual(handle.recordedDirt, []);
    } finally {
      db.close();
    }
  });
});

test("createWorkspace: the worktree row and creation event are written in one transaction; a failure in the row write leaves no active row behind", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);

      const handle = await createWorkspace({ ...baseInput(), db, projectRoot: dir });
      const rows = db
        .prepare("SELECT path, branch, base_commit, cleanup_state FROM worktrees WHERE run_id = ?")
        .all("run-1") as Array<{ path: string; branch: string; base_commit: string; cleanup_state: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.path, handle.path);
      assert.equal(rows[0]?.cleanup_state, "active");

      const events = db
        .prepare("SELECT type FROM events WHERE run_id = ? AND type = ?")
        .all("run-1", "worktree.created") as Array<{ type: string }>;
      assert.equal(events.length, 1);

      // A NOT NULL violation on task_id forces the row-write transaction to
      // fail after `git worktree add` has already created the worktree on
      // disk, mirroring what a process crash between the two steps leaves.
      await assert.rejects(
        createWorkspace({
          ...baseInput({ taskKey: "task-2", taskId: null as unknown as string }),
          db,
          projectRoot: dir,
        }),
      );

      const activeRows = db
        .prepare("SELECT id FROM worktrees WHERE run_id = ? AND cleanup_state = 'active'")
        .all("run-1") as Array<{ id: string }>;
      assert.equal(activeRows.length, 1, "only the successful creation left an active row");

      const failedPath = path.resolve(dir, DEFAULT_WORKTREE_ROOT, "run-1", "task-2");
      assert.ok(fs.existsSync(failedPath), "the worktree itself still exists despite the rolled-back row");
    } finally {
      db.close();
    }
  });
});

test("createWorkspace: a checked-out orga.yaml and no .orga/ inside the worktree; findProjectRoot resolves to the real project root from inside it", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const handle = await createWorkspace({ ...baseInput(), db, projectRoot: dir });

      assert.ok(fs.existsSync(path.join(handle.path, "orga.yaml")));
      assert.ok(!fs.existsSync(path.join(handle.path, ".orga")));
      assert.equal(findProjectRoot(handle.path), fs.realpathSync(dir));
    } finally {
      db.close();
    }
  });
});

test("listUntrackedWorktrees: finds a worktree created on disk with no worktrees row, the state left by a crash between the two write steps", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const untrackedPath = path.resolve(dir, DEFAULT_WORKTREE_ROOT, "run-1", "orphan-task");
      runGit(dir, ["worktree", "add", untrackedPath, "-b", "orga/task/orphan-task", "HEAD"]);

      const untracked = listUntrackedWorktrees({ db, runId: "run-1", projectRoot: dir });
      assert.deepEqual(untracked, [untrackedPath]);
    } finally {
      db.close();
    }
  });
});

test("listUntrackedWorktrees: a worktree with a recorded row is not reported as untracked", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      await createWorkspace({ ...baseInput(), db, projectRoot: dir });

      const untracked = listUntrackedWorktrees({ db, runId: "run-1", projectRoot: dir });
      assert.deepEqual(untracked, []);
    } finally {
      db.close();
    }
  });
});

test("removeWorkspace: a second call on an already-removed handle succeeds and leaves cleaned", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const handle = await createWorkspace({ ...baseInput(), db, projectRoot: dir });
      const ctx: WorkspaceContext = { db, projectRoot: dir, runId: "run-1" };

      const first = await removeWorkspace(handle, ctx);
      assert.equal(first.ok, true);
      assert.equal(first.cleanupState, "cleaned");
      assert.ok(!fs.existsSync(handle.path));

      const second = await removeWorkspace(handle, ctx);
      assert.equal(second.ok, true);
      assert.equal(second.cleanupState, "cleaned");

      const row = db
        .prepare("SELECT cleanup_state FROM worktrees WHERE run_id = ? AND path = ?")
        .get("run-1", handle.path) as { cleanup_state: string };
      assert.equal(row.cleanup_state, "cleaned");
    } finally {
      db.close();
    }
  });
});

test("removeWorkspace: a partial state (worktree gone, branch remaining) is completed by one retry to cleaned", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const handle = await createWorkspace({ ...baseInput(), db, projectRoot: dir });

      // Simulate a prior removal attempt that got as far as removing the
      // worktree but crashed before deleting the branch.
      runGit(dir, ["worktree", "remove", "--force", handle.path]);
      assert.ok(runGit(dir, ["branch", "--list", handle.branch]).includes(handle.branch));

      const ctx: WorkspaceContext = { db, projectRoot: dir, runId: "run-1" };
      const result = await removeWorkspace(handle, ctx);
      assert.equal(result.ok, true);
      assert.equal(result.cleanupState, "cleaned");
      assert.equal(runGit(dir, ["branch", "--list", handle.branch]), "");
    } finally {
      db.close();
    }
  });
});

test("removeWorkspace: a forced failure of the branch-delete step lands orphaned with the step name in the evidence", async () => {
  await withTempWorkspace(async (dir) => {
    setupProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const handle = await createWorkspace({ ...baseInput(), db, projectRoot: dir });

      // Free the branch from the worktree, then check it out in the main
      // repository so `git branch -D` refuses to delete it.
      runGit(dir, ["worktree", "remove", "--force", handle.path]);
      runGit(dir, ["checkout", handle.branch]);

      const ctx: WorkspaceContext = { db, projectRoot: dir, runId: "run-1" };
      const result = await removeWorkspace(handle, ctx);

      assert.equal(result.ok, false);
      assert.equal(result.cleanupState, "orphaned");
      assert.equal(result.failedStep, "branch-delete");
      assert.ok(result.stderr && result.stderr.length > 0);

      const row = db
        .prepare("SELECT cleanup_state FROM worktrees WHERE run_id = ? AND path = ?")
        .get("run-1", handle.path) as { cleanup_state: string };
      assert.equal(row.cleanup_state, "orphaned");

      const events = db
        .prepare("SELECT payload FROM events WHERE run_id = ? AND type = ?")
        .all("run-1", "worktree.cleanup_failed") as Array<{ payload: string }>;
      assert.equal(events.length, 1);
      const payload = JSON.parse(events[0]!.payload) as { step: string };
      assert.equal(payload.step, "branch-delete");
    } finally {
      db.close();
    }
  });
});
