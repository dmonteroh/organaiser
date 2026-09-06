// Fixture: in-place.
//
// Three scenarios for the `in-place` workspace mode: a dirty checkout
// refuses to start at all, a two-task board never runs two mutating attempts
// at once, and pre-run dirt on an unrelated path never fails a task whose
// own writes stay inside its claim set. None of the three needs a task to
// reach `integrated`: `inPlaceRefusesDirty` never dispatches, and the other
// two observe the implementation stage's dispatch/claim behavior — each
// accepts either `"parked"` or `"integrated"` as the task's final
// disposition, since `scheduler.ts`'s own `existingIntegrationWorkspace`
// lookup only ever finds a `worktrees` row for `worktree` mode, so an
// `in-place` task's `integration` stage always
// dispatches through the generic single-attempt fallback (the same path
// `11-out-of-claim-write.ts`/`12-unrelated-dirty-checkout.ts` exercise
// directly) rather than through `runIntegrationStages`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  startGitFixtureRun,
  readTaskRow,
  readRunRow,
  allRows,
  countRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  reportLine,
  exitLine,
  writeFileLine,
  wellFormedStream,
  writeFixtureFiles,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";
import { initProject } from "../../src/store/init.ts";
import { main } from "../../bin/orga.ts";
import { EXIT_CODES } from "../../src/cli/exit-codes.ts";
import type { Io } from "../../src/cli/commands.ts";

const TICK_INTERVAL_MS = 100;
const TERMINAL_WAIT_MS = 20000;

function runGit(dir: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

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

function assertOneWorktreeEntry(dir: string, label: string): void {
  const entries = runGit(dir, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  assert.equal(entries.length, 1, `${label}: exactly one worktree entry (the project root itself) must exist`);
}

function assertTerminalDisposition(taskId: string, disposition: unknown): void {
  assert.ok(
    disposition === "parked" || disposition === "integrated",
    `task ${taskId} must reach a terminal disposition of "parked" or "integrated", got ${JSON.stringify(disposition)}`,
  );
}

function seedEmptyFilesClaim(dir: string, runId: string, taskId: string): void {
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`claim-${taskId}`, runId, taskId, "files", JSON.stringify([]), Date.now());
    });
  } finally {
    db.close();
  }
}

function writePassThroughStreams(streamsDir: string, taskId: string): void {
  writeStream(
    streamsDir,
    "implement",
    taskId,
    wellFormedStream({ taskId, stageId: "implement", roleId: "implementer", status: "completed" }),
  );
  writeStream(streamsDir, "review-spec", taskId, [
    outputLine("reviewing"),
    reportLine({ taskId, stageId: "review-spec", roleId: "spec-reviewer", status: "completed", verdict: "pass" }),
    exitLine(0),
  ]);
  writeStream(streamsDir, "review-quality", taskId, [
    outputLine("reviewing"),
    reportLine({ taskId, stageId: "review-quality", roleId: "code-quality-reviewer", status: "completed", verdict: "pass" }),
    exitLine(0),
  ]);
  writeStream(streamsDir, "integration", taskId, [
    outputLine("integrating"),
    reportLine({ taskId, stageId: "integration", roleId: "integrator", status: "completed" }),
    exitLine(0),
  ]);
}

// ── inPlaceRefusesDirty ──────────────────────────────────────────────────────

export async function inPlaceRefusesDirty(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    runGit(dir, ["config", "user.name", "Fixture Operator"]);
    runGit(dir, ["config", "user.email", "fixture-operator@example.com"]);
    fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n", "utf8");
    runGit(dir, ["add", "--", "seed.txt"]);
    runGit(dir, ["commit", "-q", "-m", "seed"]);

    initProject(dir);
    const { boardPath } = writeFixtureFiles(dir, [{ id: "task-a" }]);
    runGit(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore", "board.json", "workflow.md", "template.md", "brief.md"]);
    runGit(dir, ["commit", "-q", "-m", "init orga project and fixture board"]);

    fs.writeFileSync(path.join(dir, "operator-dirt.txt"), "unrelated operator dirt\n", "utf8");

    const io = fakeIo(dir, { ORGA_WORKSPACE_MODE: "in-place" });
    const code = await main(["node", "orga", "run", "start", "--board", boardPath], io);

    assert.equal(code, EXIT_CODES.STATE_CONFLICT, "a dirty in-place checkout without --allow-dirty must refuse to start");
    assert.ok(
      io.errLines.some((line) => line.includes("operator-dirt.txt")),
      `stderr must name the dirty path; got ${JSON.stringify(io.errLines)}`,
    );

    const attemptCount = countRows(dir, `SELECT COUNT(*) AS n FROM attempts`);
    assert.equal(attemptCount, 0, "zero attempts rows exist after a refusal");
    const workerCount = countRows(dir, `SELECT COUNT(*) AS n FROM workers`);
    assert.equal(workerCount, 0, "zero workers rows exist after a refusal: nothing was ever dispatched");

    assertOneWorktreeEntry(dir, "inPlaceRefusesDirty");
    assert.equal(
      fs.readFileSync(path.join(dir, "operator-dirt.txt"), "utf8"),
      "unrelated operator dirt\n",
      "the dirty file itself is left exactly as the operator wrote it",
    );
  });
}

// ── inPlaceSerializes ────────────────────────────────────────────────────────

export async function inPlaceSerializes(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const tasks = [
      { id: "task-a", priority: 0 },
      { id: "task-b", priority: 1 },
    ];
    const { runId } = startGitFixtureRun(dir, tasks);
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    try {
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          for (const task of tasks) {
            db.prepare(
              `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(task.id, runId, task.id, task.id, "brief.md", "dev-workflow", "implementation", "[]", task.priority, "defined", null, Date.now(), Date.now());
          }
        });
      } finally {
        db.close();
      }
      seedEmptyFilesClaim(dir, runId, "task-a");
      seedEmptyFilesClaim(dir, runId, "task-b");
      writePassThroughStreams(streamsDir, "task-a");
      writePassThroughStreams(streamsDir, "task-b");

      const headBefore = runGit(dir, ["rev-parse", "HEAD"]);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
        workspaceMode: "in-place",
      });
      registry.track(supervisor.pid);

      let maxLiveWorkers = 0;
      const poller = setInterval(() => {
        const live = countRows(dir, `SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL`, runId);
        if (live > maxLiveWorkers) maxLiveWorkers = live;
      }, 10);

      try {
        const done = await waitFor(() => {
          const a = readTaskRow(dir, "task-a");
          const b = readTaskRow(dir, "task-b");
          return a?.disposition != null && b?.disposition != null;
        }, TERMINAL_WAIT_MS);
        assert.ok(
          done,
          `both tasks must reach a terminal disposition; task-a=${JSON.stringify(readTaskRow(dir, "task-a"))} task-b=${JSON.stringify(readTaskRow(dir, "task-b"))}`,
        );
      } finally {
        clearInterval(poller);
      }

      assert.ok(maxLiveWorkers <= 1, `at most one live worker row must ever exist at once, saw ${maxLiveWorkers}`);

      const attempts = allRows<{ task_id: string; started_at: number | null; ended_at: number | null }>(
        dir,
        `SELECT task_id, started_at, ended_at FROM attempts WHERE run_id = ? ORDER BY started_at ASC`,
        runId,
      );
      assert.ok(attempts.length >= 2, "both tasks must have dispatched at least one attempt each");
      for (let i = 1; i < attempts.length; i++) {
        const prev = attempts[i - 1] as { task_id: string; started_at: number | null; ended_at: number | null };
        const cur = attempts[i] as { task_id: string; started_at: number | null; ended_at: number | null };
        assert.ok(
          prev.ended_at !== null && cur.started_at !== null && prev.ended_at <= cur.started_at,
          `attempt timestamps must never overlap: ${prev.task_id} ended at ${prev.ended_at}, ${cur.task_id} started at ${cur.started_at}`,
        );
      }

      assertTerminalDisposition("task-a", readTaskRow(dir, "task-a")?.disposition);
      assertTerminalDisposition("task-b", readTaskRow(dir, "task-b")?.disposition);

      const headAfter = runGit(dir, ["rev-parse", "HEAD"]);
      assert.equal(headAfter, headBefore, "the checkout's HEAD moves only by commits the run itself made — none, here");
      assertOneWorktreeEntry(dir, "inPlaceSerializes");
    } finally {
      registry.killAll();
      await registry.allDead();
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}

// ── inPlaceClaimsExcludeRecordedDirt ────────────────────────────────────────

export async function inPlaceClaimsExcludeRecordedDirt(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const { runId } = startGitFixtureRun(dir, [{ id: "task-a" }]);
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    try {
      const now = Date.now();
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-a", runId, "task-a", "task-a", "brief.md", "dev-workflow", "implementation", "[]", 0, "defined", null, now, now);
          db.prepare(
            `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run("claim-task-a", runId, "task-a", "files", JSON.stringify(["claimed.txt"]), now);
        });
      } finally {
        db.close();
      }

      const dirtyPath = path.join(dir, "operator-dirt.txt");
      fs.writeFileSync(dirtyPath, "unrelated operator dirt, never claimed by any task\n", "utf8");

      writeStream(streamsDir, "implement", "task-a", [
        outputLine("working"),
        writeFileLine("claimed.txt", "claimed contents\n"),
        reportLine({ taskId: "task-a", stageId: "implement", roleId: "implementer", status: "completed" }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "review-spec", "task-a", [
        outputLine("reviewing"),
        reportLine({ taskId: "task-a", stageId: "review-spec", roleId: "spec-reviewer", status: "completed", verdict: "pass" }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "review-quality", "task-a", [
        outputLine("reviewing"),
        reportLine({ taskId: "task-a", stageId: "review-quality", roleId: "code-quality-reviewer", status: "completed", verdict: "pass" }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("integrating"),
        reportLine({ taskId: "task-a", stageId: "integration", roleId: "integrator", status: "completed" }),
        exitLine(0),
      ]);

      const headBefore = runGit(dir, ["rev-parse", "HEAD"]);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
        workspaceMode: "in-place",
      });
      registry.track(supervisor.pid);

      const done = await waitFor(() => readTaskRow(dir, "task-a")?.disposition != null, TERMINAL_WAIT_MS);
      assert.ok(done, `task-a must reach a terminal disposition; row: ${JSON.stringify(readTaskRow(dir, "task-a"))}`);

      const violations = countRows(
        dir,
        `SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`,
        runId,
      );
      assert.equal(violations, 0, "pre-run dirt on an unrelated path must never surface as an out-of-claim violation");

      assert.equal(
        fs.readFileSync(dirtyPath, "utf8"),
        "unrelated operator dirt, never claimed by any task\n",
        "the pre-existing dirty file is untouched",
      );
      assert.ok(fs.existsSync(path.join(dir, "claimed.txt")), "the claimed file was written by the attempt");

      assertTerminalDisposition("task-a", readTaskRow(dir, "task-a")?.disposition);

      const headAfter = runGit(dir, ["rev-parse", "HEAD"]);
      assert.equal(headAfter, headBefore, "the checkout's HEAD moves only by commits the run itself made — none, here");
      assertOneWorktreeEntry(dir, "inPlaceClaimsExcludeRecordedDirt");

      const runRow = readRunRow(dir, runId);
      assert.ok(runRow, "the run row must exist");
    } finally {
      registry.killAll();
      await registry.allDead();
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}
