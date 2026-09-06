import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { checkInPlaceStart, createInPlaceWorkspace, InPlaceDirtyCheckoutError } from "../src/git/in-place.ts";
import { observedPaths, validateClaims } from "../src/git/claims.ts";
import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import type { Io } from "../src/cli/commands.ts";
import {
  ProcessRegistry,
  waitFor,
  groupAlive,
  startGitFixtureRun,
  readRunRow,
  allRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  writeFileLine,
  trapSigtermLine,
  sleepLine,
  withFixtureWorkspace,
} from "../evals/fixtures/harness.ts";

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// Mirrors `workspace.test.ts`'s own `setupProject`: a committed project with
// `orga.yaml` and `.gitignore` tracked, `orgaw` left untracked (the wrapper
// `initProject` writes but this helper never stages).
function setupGitProject(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n", "utf8");
  runGit(dir, ["add", "--", "seed.txt"]);
  runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "seed"]);
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

// ── the in-place start check ────────────────────────────────────────────────

test("checkInPlaceStart: a clean checkout reports no dirt and never throws", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    runGit(dir, ["add", "--", "orgaw"]);
    runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "track orgaw"]);

    const result = checkInPlaceStart({ projectRoot: dir, allowDirty: false });
    assert.deepEqual(result.recordedDirt, []);
  });
});

test("checkInPlaceStart: a dirty checkout without --allow-dirty throws InPlaceDirtyCheckoutError naming the dirty paths", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "dirt\n", "utf8");

    assert.throws(
      () => checkInPlaceStart({ projectRoot: dir, allowDirty: false }),
      (err: unknown) => {
        assert.ok(err instanceof InPlaceDirtyCheckoutError);
        assert.deepEqual(err.dirtyPaths, ["dirty.txt", "orgaw"]);
        assert.match(err.message, /dirty\.txt/);
        return true;
      },
    );
  });
});

test("checkInPlaceStart: --allow-dirty proceeds and returns the dirty paths observed at that moment instead of throwing", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "dirt\n", "utf8");

    const result = checkInPlaceStart({ projectRoot: dir, allowDirty: true });
    assert.deepEqual(result.recordedDirt, ["dirty.txt", "orgaw"]);
  });
});

// ── the CLI gate on `run start` ─────────────────────────────────────────────

function fakeIo(dir: string, env: NodeJS.ProcessEnv = {}): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => dir,
    now: () => Date.now(),
    env,
  };
}

function minimalBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: "t1",
          title: "Task 1",
          briefPath: "brief.md",
          entry: { workflowId: "wf1", stageId: "s1" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          enabled: true,
        },
      ],
    },
  };
}

function writeBoard(dir: string): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(minimalBoard(), null, 2));
  return boardPath;
}

function killGroupBestEffort(pgid: number | undefined | null): void {
  if (typeof pgid !== "number") return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

test("run start: a dirty in-place checkout is refused before any attempt dispatches, exit code names the dirty paths, zero attempts rows", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "dirt\n", "utf8");
    const boardPath = writeBoard(dir);

    const io = fakeIo(dir, { ORGA_WORKSPACE_MODE: "in-place" });
    const code = await main(["node", "orga", "run", "start", "--board", boardPath], io);

    assert.equal(code, EXIT_CODES.STATE_CONFLICT);
    assert.ok(
      io.errLines.some((line) => line.includes("dirty.txt")),
      `stderr must name the dirty path; got ${JSON.stringify(io.errLines)}`,
    );

    const db = openStore(dir);
    try {
      const attemptCount = db.prepare(`SELECT COUNT(*) AS n FROM attempts`).get() as { n: number };
      assert.equal(attemptCount.n, 0, "zero attempts rows exist after a refusal");
      const runCount = db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
      assert.equal(runCount.n, 0, "no run is even committed for a refused start");
    } finally {
      db.close();
    }
  });
});

test("run start: --allow-dirty proceeds against a dirty in-place checkout instead of refusing", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "dirt\n", "utf8");
    const boardPath = writeBoard(dir);

    const io = fakeIo(dir, { ORGA_WORKSPACE_MODE: "in-place" });
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--allow-dirty", "--json"], io);

    assert.equal(code, EXIT_CODES.OK);
    const started = JSON.parse(io.outLines[io.outLines.length - 1] as string) as {
      runId: string;
      supervisorPid: number | null;
    };
    try {
      const db = openStore(dir);
      try {
        const runCount = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE id = ?`).get(started.runId) as { n: number };
        assert.equal(runCount.n, 1, "the run is committed once --allow-dirty is passed");
      } finally {
        db.close();
      }
    } finally {
      killGroupBestEffort(started.supervisorPid);
    }
  });
});

test("run start: a clean in-place checkout never triggers the dirty-checkout refusal", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    const boardPath = writeBoard(dir);
    runGit(dir, ["add", "--", "orgaw", "board.json"]);
    runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "track orgaw and board"]);

    const io = fakeIo(dir, { ORGA_WORKSPACE_MODE: "in-place" });
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], io);

    assert.equal(code, EXIT_CODES.OK);
    const started = JSON.parse(io.outLines[io.outLines.length - 1] as string) as {
      runId: string;
      supervisorPid: number | null;
    };
    killGroupBestEffort(started.supervisorPid);
  });
});

test("run start: worktree mode (the default) never runs the in-place dirty-checkout gate", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    fs.writeFileSync(path.join(dir, "dirty.txt"), "dirt\n", "utf8");
    const boardPath = writeBoard(dir);

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], io);

    assert.equal(code, EXIT_CODES.OK);
    const started = JSON.parse(io.outLines[io.outLines.length - 1] as string) as {
      runId: string;
      supervisorPid: number | null;
    };
    killGroupBestEffort(started.supervisorPid);
  });
});

// ── claim validation against the real call shape ────────────────────────────

test("createInPlaceWorkspace + observedPaths + validateClaims: pre-run dirt on an unrelated path never fails a task that only writes its claimed path", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    const now = 1000;
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", now);

      fs.writeFileSync(path.join(dir, "unrelated-dirt.txt"), "pre-existing dirt\n", "utf8");

      const handle = await createInPlaceWorkspace({
        db,
        projectRoot: dir,
        runId: "run-1",
        taskId: "task-a",
        taskKey: "task-a",
        ref: "HEAD",
        root: ".orga/worktrees",
        branchPrefix: "orga/task/",
        mode: "in-place",
      });
      assert.ok(handle.recordedDirt.includes("unrelated-dirt.txt"));

      fs.writeFileSync(path.join(dir, "claimed.txt"), "claimed contents\n", "utf8");

      const observed = await observedPaths(handle);
      const result = validateClaims({ observed, claimed: ["claimed.txt"], recordedDirt: handle.recordedDirt });

      assert.equal(result.ok, true);
      assert.deepEqual(result.outOfClaim, []);
      assert.equal(
        fs.readFileSync(path.join(dir, "unrelated-dirt.txt"), "utf8"),
        "pre-existing dirt\n",
        "the unrelated dirty file is untouched",
      );
    } finally {
      db.close();
    }
  });
});

test("createInPlaceWorkspace + observedPaths + validateClaims: a recorded-dirty path outside the claim set that the attempt further modifies still passes claim validation (documents the shipped, permissive behavior)", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    const now = 1000;
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", now);

      const dirtyPath = path.join(dir, "dirty-outside-claim.txt");
      fs.writeFileSync(dirtyPath, "dirt before the attempt\n", "utf8");

      const handle = await createInPlaceWorkspace({
        db,
        projectRoot: dir,
        runId: "run-1",
        taskId: "task-a",
        taskKey: "task-a",
        ref: "HEAD",
        root: ".orga/worktrees",
        branchPrefix: "orga/task/",
        mode: "in-place",
      });
      assert.ok(
        handle.recordedDirt.includes("dirty-outside-claim.txt"),
        "the pre-existing dirt is recorded at workspace creation time",
      );

      // The attempt further modifies the very same path recordedDirt already
      // carries, and never claims it.
      fs.writeFileSync(dirtyPath, "the attempt's own further edit\n", "utf8");
      fs.writeFileSync(path.join(dir, "claimed.txt"), "claimed contents\n", "utf8");

      const observed = await observedPaths(handle);
      assert.ok(observed.includes("dirty-outside-claim.txt"), "the further edit is observed in the diff");

      const result = validateClaims({ observed, claimed: ["claimed.txt"], recordedDirt: handle.recordedDirt });

      assert.equal(result.ok, true, "recordedDirt excludes the path unconditionally, regardless of further modification");
      assert.deepEqual(result.outOfClaim, []);
    } finally {
      db.close();
    }
  });
});

test("createInPlaceWorkspace: a file left dirty by one serial in-place task's attempt is recorded as the next task's dirt and does not fail its own claim validation", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    const now = 1000;
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", now);

      const handleA = await createInPlaceWorkspace({
        db,
        projectRoot: dir,
        runId: "run-1",
        taskId: "task-a",
        taskKey: "task-a",
        ref: "HEAD",
        root: ".orga/worktrees",
        branchPrefix: "orga/task/",
        mode: "in-place",
      });
      assert.ok(
        !handleA.recordedDirt.includes("task-a-leftover.txt"),
        "the leftover file does not exist yet when task-a's workspace is created",
      );

      // task-a's own attempt writes a file outside task-b's claim set. In-place
      // mode never commits at this milestone, so the file is still on disk when
      // task-b's workspace is created next.
      fs.writeFileSync(path.join(dir, "task-a-leftover.txt"), "left behind by task-a's attempt\n", "utf8");

      const handleB = await createInPlaceWorkspace({
        db,
        projectRoot: dir,
        runId: "run-1",
        taskId: "task-b",
        taskKey: "task-b",
        ref: "HEAD",
        root: ".orga/worktrees",
        branchPrefix: "orga/task/",
        mode: "in-place",
      });
      assert.ok(
        handleB.recordedDirt.includes("task-a-leftover.txt"),
        "task-a's leftover file must be recorded as task-b's own recordedDirt",
      );

      fs.writeFileSync(path.join(dir, "claimed-by-b.txt"), "claimed by task-b\n", "utf8");

      const observed = await observedPaths(handleB);
      const result = validateClaims({ observed, claimed: ["claimed-by-b.txt"], recordedDirt: handleB.recordedDirt });

      assert.equal(result.ok, true, "task-a's carried-over dirt must not fail task-b's claim validation");
      assert.deepEqual(result.outOfClaim, []);
    } finally {
      db.close();
    }
  });
});

// ── no worktree or branch is created for an in-place workspace ─────────────

test("createInPlaceWorkspace: git worktree list shows exactly one entry, and no orga/task/ branch is created", async () => {
  await withTempWorkspace(async (dir) => {
    setupGitProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      await createInPlaceWorkspace({
        db,
        projectRoot: dir,
        runId: "run-1",
        taskId: "task-a",
        taskKey: "task-a",
        ref: "HEAD",
        root: ".orga/worktrees",
        branchPrefix: "orga/task/",
        mode: "in-place",
      });
    } finally {
      db.close();
    }

    const worktreeList = runGit(dir, ["worktree", "list", "--porcelain"]);
    const entries = worktreeList.split("\n").filter((line) => line.startsWith("worktree "));
    assert.equal(entries.length, 1, "exactly one worktree entry (the project root itself) exists");

    const branches = runGit(dir, ["branch", "--list"]);
    assert.ok(!branches.includes("orga/task/"), "no runner-owned branch is created for an in-place workspace");
  });
});

// ── cancellation never resets, checks out, stashes, or reverts ─────────────

const CANCEL_TICK_INTERVAL_MS = 150;
const CANCEL_GRACE_MS = 250;

test("in-place: run cancel --now leaves the worker's partial edit in the checkout exactly as it wrote it", async () => {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startGitFixtureRun(dir, [{ id: "task-a" }]);
      const now = Date.now();
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-a", runId, "task-a", "task-a", "brief.md", "dev-workflow", "integration", "[]", 0, "defined", null, now, now);
          db.prepare(
            `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run("claim-task-a", runId, "task-a", "files", JSON.stringify(["partial.txt"]), now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("writing a partial edit before being cancelled"),
        writeFileLine("partial.txt", "partial edit contents\n"),
        trapSigtermLine(),
        sleepLine(60000),
      ]);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: CANCEL_TICK_INTERVAL_MS,
        operatorPollWindowMs: CANCEL_TICK_INTERVAL_MS * 4,
        cancelGraceMs: CANCEL_GRACE_MS,
        streamsDir,
        workspaceMode: "in-place",
      });
      registry.track(supervisor.pid);

      const partialPath = path.join(dir, "partial.txt");
      const written = await waitFor(() => fs.existsSync(partialPath), 5000);
      assert.ok(written, "the worker must write its partial edit before cancellation");

      const workerRow = await waitFor(() => allRows(dir, `SELECT 1 AS x FROM workers WHERE run_id = ?`, runId).length > 0, 3000);
      assert.ok(workerRow, "a worker row must exist before cancel is issued");
      const pgid = (allRows<{ pgid: number }>(dir, `SELECT pgid FROM workers WHERE run_id = ?`, runId)[0] as { pgid: number }).pgid;
      registry.track(pgid);
      await waitFor(() => groupAlive(pgid), 2000);

      const cancelIo: Io = {
        stdout: () => {},
        stderr: () => {},
        cwd: () => dir,
        now: () => Date.now(),
        env: {},
      };
      const cancelCode = await main(["node", "orga", "run", "cancel", runId, "--now"], cancelIo);
      assert.equal(cancelCode, EXIT_CODES.OK);

      const gone = await waitFor(() => !groupAlive(pgid), 3000);
      assert.ok(gone, "the worker group must be gone after --now cancellation");

      const cancelled = await waitFor(() => readRunRow(dir, runId).state === "cancelled", 3000);
      assert.ok(cancelled, `run must reach cancelled; row: ${JSON.stringify(readRunRow(dir, runId))}`);

      assert.ok(fs.existsSync(partialPath), "the worker's partial edit must still be present after cancellation");
      assert.equal(
        fs.readFileSync(partialPath, "utf8"),
        "partial edit contents\n",
        "the partial edit's contents are byte-identical to what the worker wrote",
      );

      const status = runGit(dir, ["status", "--porcelain"]);
      assert.match(status, /partial\.txt/, "the checkout still shows the partial edit as uncommitted, never reset or stashed away");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
});
