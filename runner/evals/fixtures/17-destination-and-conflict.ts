// Fixture: destination-and-conflict.
//
// Both scenarios drive `runIntegrationStages` directly against a real Git
// repository rather than through a spawned supervisor: `integration.v1` has
// exactly one dispatchable task at a time by construction (P5's single-lane
// scheduling), so the pipeline itself — not the supervisor loop around it —
// is what these two scenarios exercise. The destination ref (`refs/heads/
// release`) is never the operator's own checked-out branch (`operator-
// working`): a real deployment's destination is whatever branch the
// automation targets, not necessarily whatever the operator happens to have
// open, and keeping them distinct is what lets `assertOperatorCheckoutUnchanged`
// hold even though the destination itself legitimately advances.

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

// Commits onto `ref` through a throwaway worktree, exactly as an unrelated
// external actor (a human push, another automation) would: `dir`'s own
// checkout, wherever it currently is, is never touched.
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

  // Leave `dir` on a branch distinct from the destination for the rest of
  // this fixture's life.
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

export async function destinationCas(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const fixture = await setupFixture(dir);
    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const { adapter, queue } = makeAdapter(fixture.streamsDir);
        queueReviewerPass(fixture.streamsDir, "pass-1", TASK_ID, fixture.runId);
        queueReviewerPass(fixture.streamsDir, "pass-2", TASK_ID, fixture.runId);
        queue("pass-1");
        queue("pass-2");

        let moved = false;
        const outcome = await runIntegrationStages(
          inputFor(fixture, adapter, {
            projectRoot: dir,
            candidateRoot: path.join(dir, ".orga", "worktrees"),
            beforeAdvanceDestination: () => {
              if (!moved) {
                moved = true;
                commitOntoRef(dir, DESTINATION_REF, "external.txt", "external\n", "external move");
              }
            },
          }),
        );

        assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);
        assert.ok(
          runGit(dir, ["show", `${DESTINATION_REF}:external.txt`]).includes("external"),
          "the external move is never overwritten",
        );
        assert.ok(
          runGit(dir, ["show", `${DESTINATION_REF}:feature.txt`]).includes("feature"),
          "the destination ends with the task's change too",
        );
      });
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.streamsDir, { recursive: true, force: true });
      fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    }
  });
}

export async function integrationConflict(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const fixture = await setupFixture(dir);
    try {
      commitOntoRef(dir, DESTINATION_REF, "feature.txt", "destination version\n", "destination edits feature.txt");
      const destinationSha = runGit(dir, ["rev-parse", DESTINATION_REF]);

      await assertOperatorCheckoutUnchanged(dir, async () => {
        const { adapter } = makeAdapter(fixture.streamsDir);

        const outcome = await runIntegrationStages(
          inputFor(fixture, adapter, { projectRoot: dir, candidateRoot: path.join(dir, ".orga", "worktrees") }),
        );

        assert.equal(outcome.outcome, "parked", `expected parked; got ${JSON.stringify(outcome)}`);
        assert.equal(runGit(dir, ["rev-parse", DESTINATION_REF]), destinationSha, "the destination sha is unchanged");

        const row = fixture.db
          .prepare(`SELECT checks FROM integrations WHERE run_id = ? AND task_id = ?`)
          .get(fixture.runId, TASK_ID) as { checks: string };
        const checks = JSON.parse(row.checks) as { integrationConflict?: { conflictingPaths: string[] } };
        assert.deepEqual(checks.integrationConflict?.conflictingPaths, ["feature.txt"]);
      });
    } finally {
      fixture.db.close();
      fs.rmSync(fixture.streamsDir, { recursive: true, force: true });
      fs.rmSync(fixture.taskDir, { recursive: true, force: true });
    }
  });
}
