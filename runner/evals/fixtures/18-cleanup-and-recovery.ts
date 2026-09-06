// Fixture: cleanup-and-recovery.
//
// Three scenarios, none of which need a spawned supervisor: the first two
// drive `runIntegrationStages` directly (mirroring `17-destination-and-
// conflict.ts`'s own setup); the third calls `predicates.ts`'s `accept()`
// directly, since integration acceptance reuses that function rather than a
// new acceptance rule, which is a property of that pure function, not of
// this stage machine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertOperatorCheckoutUnchanged,
  exitLine,
  openStore,
  outputLine,
  reportLine,
  startGitFixtureRun,
  withFixtureWorkspace,
  withTransaction,
  writeStream,
} from "./harness.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../../src/adapters/adapter.ts";
import { runIntegrationStages, type IntegrationStagesInput } from "../../src/engine/integration-stages.ts";
import type { WorkspaceHandle } from "../../src/git/workspace.ts";
import { commitExists, isAncestor } from "../../src/git/git.ts";
import { accept, type Facts } from "../../src/engine/predicates.ts";

const TASK_ID = "task-a";
const TASK_BRANCH = "orga/task/task-a";
const DESTINATION_REF = "refs/heads/release";

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function commitFile(dir: string, relPath: string, contents: string, message: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", message, "--", relPath]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

// Commits onto `ref` through a throwaway worktree: `dir`'s own checkout is
// never touched.
function commitOntoRef(dir: string, ref: string, relPath: string, contents: string, message: string): string {
  const tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), "orga-external-"));
  fs.rmdirSync(tmpPath);
  // `git worktree add` only attaches HEAD to the branch (so a commit there
  // moves it) when given the short branch name; the fully-qualified
  // `refs/heads/...` form checks out detached instead, leaving the branch
  // untouched by any commit made in the worktree.
  const shortBranch = ref.replace(/^refs\/heads\//, "");
  runGit(dir, ["worktree", "add", tmpPath, shortBranch]);
  try {
    fs.writeFileSync(path.join(tmpPath, relPath), contents, "utf8");
    runGit(tmpPath, ["add", "--", relPath]);
    runGit(tmpPath, ["-c", "user.name=External Actor", "-c", "user.email=external@example.com", "commit", "-q", "-m", message]);
    return runGit(tmpPath, ["rev-parse", "HEAD"]);
  } finally {
    runGit(dir, ["worktree", "remove", "--force", tmpPath]);
  }
}

interface Fixture {
  runId: string;
  db: ReturnType<typeof openStore>;
  destinationSha0: string;
  taskWorkspace: WorkspaceHandle;
  taskDir: string;
  streamsDir: string;
}

async function setupFixture(dir: string): Promise<Fixture> {
  // `startFixtureRun` never inserts `tasks` rows from `board.spec.tasks`
  // (harness.ts's own comment), so this entry only satisfies the board
  // schema's minimum; the real task row is inserted directly below.
  const { runId } = startGitFixtureRun(dir, [{ id: TASK_ID }]);

  runGit(dir, ["checkout", "-b", "operator-working"]);
  const destinationSha0 = runGit(dir, ["rev-parse", "HEAD"]);
  runGit(dir, ["branch", "release", destinationSha0]);

  runGit(dir, ["branch", TASK_BRANCH, destinationSha0]);
  runGit(dir, ["checkout", TASK_BRANCH]);
  commitFile(dir, "feature.txt", "feature\n", "add feature");
  runGit(dir, ["checkout", "operator-working"]);

  const db = openStore(dir);
  const now = Date.now();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(TASK_ID, runId, TASK_ID, TASK_ID, "brief.md", "dev-workflow", "integration", "[]", 0, "defined", null, now, now);
  });

  const taskWorktreePath = path.join(dir, ".orga", "worktrees", TASK_ID);
  runGit(dir, ["worktree", "add", taskWorktreePath, TASK_BRANCH]);
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO worktrees (id, run_id, task_id, path, branch, base_commit, cleanup_state, created_at, cleaned_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
    ).run(`worktree-${TASK_ID}`, runId, TASK_ID, taskWorktreePath, TASK_BRANCH, destinationSha0, now);
  });

  const taskWorkspace: WorkspaceHandle = {
    mode: "worktree",
    root: "",
    path: taskWorktreePath,
    branch: TASK_BRANCH,
    baseCommit: destinationSha0,
    recordedDirt: [],
  };

  // Outside the operator's checkout, like `streamsDir` below: the barrier's
  // evidence ledger write inside `taskDir` would otherwise be a new
  // untracked path the moment it lands, which `assertOperatorCheckoutUnchanged`
  // would then (correctly) flag.
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-taskdir-"));
  const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

  return { runId, db, destinationSha0, taskWorkspace, taskDir, streamsDir };
}

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function makeAdapter(streamsDir: string): { adapter: FakeAdapter; queue: (scenario: string) => void } {
  const queue: string[] = [];
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (_attempt: AttemptDescriptor) => {
      const next = queue.shift();
      if (!next) throw new Error("no cross-task-review scenario queued");
      return next;
    },
  });
  return { adapter, queue: (scenario) => queue.push(scenario) };
}

function queueReviewerPass(streamsDir: string, scenario: string, taskId: string, runId: string): void {
  writeStream(streamsDir, "cross-task-review", scenario, [
    outputLine("reviewing"),
    reportLine({
      runId,
      taskId,
      attemptId: `attempt-${scenario}`,
      stageId: "cross-task-review",
      roleId: "code-quality-reviewer",
      status: "completed",
      verdict: "pass",
      summary: "looks good",
    }),
    exitLine(0),
  ]);
}

function inputFor(fixture: Fixture, adapter: FakeAdapter, overrides: Partial<IntegrationStagesInput> = {}): IntegrationStagesInput {
  return {
    db: fixture.db,
    adapter,
    runId: fixture.runId,
    taskId: TASK_ID,
    now: () => Date.now(),
    projectRoot: "",
    destinationRef: DESTINATION_REF,
    taskWorkspace: fixture.taskWorkspace,
    candidateRoot: "",
    taskDir: fixture.taskDir,
    requiredArtifacts: [],
    checks: {},
    env: process.env,
    ...overrides,
  };
}

export async function worktreeCleanup(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const fixture = await setupFixture(dir);
    let blockerPath: string | null = null;
    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const { adapter, queue } = makeAdapter(fixture.streamsDir);
        queueReviewerPass(fixture.streamsDir, "pass", TASK_ID, fixture.runId);
        queue("pass");

        // Force the task worktree's own removal to fail, mirroring
        // `workspace.test.ts`'s own forced-failure setup, but through a
        // second throwaway worktree rather than `dir`'s own checkout: `git
        // branch -D` refuses to delete a branch checked out anywhere.
        runGit(dir, ["worktree", "remove", "--force", fixture.taskWorkspace.path]);
        blockerPath = fs.mkdtempSync(path.join(os.tmpdir(), "orga-blocker-"));
        fs.rmdirSync(blockerPath);
        runGit(dir, ["worktree", "add", blockerPath, TASK_BRANCH]);

        const input = inputFor(fixture, adapter, {
          projectRoot: dir,
          candidateRoot: path.join(dir, ".orga", "worktrees"),
        });

        const first = await runIntegrationStages(input);
        assert.equal(first.outcome, "cleanup-pending");
        assert.notEqual(first.outcome, "integrated");

        const stillDirty = fixture.db
          .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND cleanup_state != 'cleaned'`)
          .get(fixture.runId) as { n: number };
        assert.ok(stillDirty.n > 0, "success is withheld while any recorded worktree remains uncleaned");

        runGit(dir, ["worktree", "remove", "--force", blockerPath]);
        blockerPath = null;

        const second = await runIntegrationStages(input);
        assert.equal(second.outcome, "integrated", `expected integrated after the retry; got ${JSON.stringify(second)}`);

        const allClean = fixture.db
          .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND cleanup_state != 'cleaned'`)
          .get(fixture.runId) as { n: number };
        assert.equal(allClean.n, 0);
      });
    } finally {
      if (blockerPath) {
        try {
          runGit(dir, ["worktree", "remove", "--force", blockerPath]);
        } catch {
          // best-effort
        }
      }
      fixture.db.close();
      fs.rmSync(fixture.streamsDir, { recursive: true, force: true });
      fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    }
  });
}

export async function historicalCommitRewrite(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const fixture = await setupFixture(dir);
    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const { adapter, queue } = makeAdapter(fixture.streamsDir);
        queueReviewerPass(fixture.streamsDir, "pass", TASK_ID, fixture.runId);
        queue("pass");

        const outcome = await runIntegrationStages(
          inputFor(fixture, adapter, { projectRoot: dir, candidateRoot: path.join(dir, ".orga", "worktrees") }),
        );
        assert.equal(outcome.outcome, "integrated");
        const resultCommit = outcome.resultCommit as string;

        // Rewrite the destination's history out from under the recorded
        // commit, through a throwaway worktree so `dir`'s own checkout is
        // never touched.
        const tmpPath = fs.mkdtempSync(path.join(os.tmpdir(), "orga-rewrite-"));
        fs.rmdirSync(tmpPath);
        // The short branch name, not `refs/heads/...`, so this worktree
        // attaches to the branch and `reset --hard` inside it moves the
        // branch itself rather than only its own detached HEAD.
        runGit(dir, ["worktree", "add", tmpPath, DESTINATION_REF.replace(/^refs\/heads\//, "")]);
        try {
          runGit(tmpPath, ["reset", "--hard", fixture.destinationSha0]);
          fs.writeFileSync(path.join(tmpPath, "unrelated.txt"), "unrelated\n", "utf8");
          runGit(tmpPath, ["add", "--", "unrelated.txt"]);
          runGit(tmpPath, ["-c", "user.name=External Actor", "-c", "user.email=external@example.com", "commit", "-q", "-m", "unrelated history"]);
        } finally {
          runGit(dir, ["worktree", "remove", "--force", tmpPath]);
        }

        const row = fixture.db
          .prepare(`SELECT result_commit FROM integrations WHERE run_id = ? AND task_id = ?`)
          .get(fixture.runId, TASK_ID) as { result_commit: string };
        assert.equal(row.result_commit, resultCommit, "the durable row itself is never rewritten");

        const facts: Facts = {
          verificationMode: "legacy",
          frontmatterStatus: "Done",
          integrationCommit: row.result_commit,
          integrationCommitExists: commitExists(row.result_commit, dir),
          integrationCommitIsAncestor: isAncestor(row.result_commit, DESTINATION_REF, dir),
          implementerCommits: ["deadbeef"],
          implementerCommitsAllExist: true,
          reuseLanded: false,
          specReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
          qualityReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
          verification: { status: "pass" },
        };
        const result = accept(facts);
        assert.equal(result.state, "incomplete", "a rewritten history never reports success");
        assert.ok(
          result.gaps.includes("integrationCommit:notAncestor") || result.gaps.includes("integrationCommit:notInRepo"),
          `expected an integrationCommit gap; got ${JSON.stringify(result.gaps)}`,
        );
      });
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.streamsDir, { recursive: true, force: true });
      fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    }
  });
}

export async function landedWorkRecoveryWithoutFalseSuccess(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const fixture = await setupFixture(dir);
    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        // The task's commit landed on the destination — as if a prior,
        // unrecorded run had already integrated it — but this run's own
        // attempt produced no report at all, so no implementer commits
        // accreted and no fresh reviewer evidence exists.
        const landedCommit = commitOntoRef(dir, DESTINATION_REF, "landed.txt", "landed\n", "work landed with no report");

        const facts: Facts = {
          verificationMode: "legacy",
          frontmatterStatus: "Done",
          integrationCommit: landedCommit,
          integrationCommitExists: commitExists(landedCommit, dir),
          integrationCommitIsAncestor: isAncestor(landedCommit, DESTINATION_REF, dir),
          implementerCommits: [],
          implementerCommitsAllExist: true,
          reuseLanded: false,
          specReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
          qualityReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
          verification: { status: "pass" },
        };

        const result = accept(facts);
        assert.equal(result.state, "incomplete", "landed commits alone are not counted as success");
        assert.ok(result.gaps.includes("implementerCommits:empty"), `expected implementerCommits:empty; got ${JSON.stringify(result.gaps)}`);
      });
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.streamsDir, { recursive: true, force: true });
      fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    }
  });
}
