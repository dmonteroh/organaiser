// Fixture: fresh-reviewer.
//
// `freshReviewer`: a fail-then-repair round on `review-spec` dispatches two
// review-spec attempts, each spawned fresh in its own `createWorkspace`
// worktree at the commit under review, with its own `attempts.id` and its
// own OS pid; both reviewer worktrees are removed by the end of the run,
// leaving no trace in `git worktree list` and a `cleaned` `worktrees` row
// each. This is the same property `test/review-stages.test.ts` proves at the
// unit level, exercised here as a real, spawned-per-attempt fixture.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  assertOperatorCheckoutUnchanged,
  openStore,
  startGitFixtureRun,
  withFixtureWorkspace,
  withTransaction,
} from "./harness.ts";
import { runDevelopmentStages, type DevelopmentStageInput } from "../../src/engine/workflow-stages.ts";
import { createReviewerWorkspaceResolver } from "../../src/engine/review-stages.ts";
import { createWorkspace, DEFAULT_BRANCH_PREFIX, DEFAULT_WORKTREE_ROOT } from "../../src/git/workspace.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../../src/adapters/adapter.ts";

const TASK_ID = "task-1";
const TASK_KEY = "task-1";

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function fakeClock(startMs: number): { now: () => number } {
  let current = startMs;
  return {
    now: () => {
      current += 1;
      return current;
    },
  };
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function commitAll(cwd: string, message: string): string {
  runGit(cwd, ["add", "-A"]);
  runGit(cwd, ["commit", "-q", "--allow-empty", "-m", message]);
  return runGit(cwd, ["rev-parse", "HEAD"]);
}

function implementerReport(runId: string, stageId: string, status: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId: "implementer",
    status,
    summary: `implementer reported ${status}`,
  };
}

function reviewerReport(runId: string, stageId: string, roleId: string, verdict: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId,
    status: "completed",
    verdict,
    summary: `reviewer reported ${verdict}`,
  };
}

function writeStreamFile(streamsDir: string, stageId: string, scenario: string, ops: readonly unknown[]): void {
  fs.mkdirSync(streamsDir, { recursive: true });
  const filePath = path.join(streamsDir, `${stageId}--${scenario}.jsonl`);
  fs.writeFileSync(filePath, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

function queueImplementerScenario(streamsDir: string, runId: string, stageId: string, scenario: string): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "working" },
    { op: "report", report: implementerReport(runId, stageId, "completed") },
    { op: "exit", code: 0 },
  ]);
}

function queueReviewerScenario(
  streamsDir: string,
  runId: string,
  stageId: string,
  roleId: string,
  scenario: string,
  verdict: string,
): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(runId, stageId, roleId, verdict) },
    { op: "exit", code: 0 },
  ]);
}

function makeAdapter(streamsDir: string): {
  adapter: FakeAdapter;
  queue: (stageId: string, scenario: string) => void;
} {
  const queues = new Map<string, string[]>();
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (attempt: AttemptDescriptor) => {
      const queue = queues.get(attempt.stageId);
      if (queue && queue.length > 0) return queue.shift() as string;
      throw new Error(`no scenario queued for stage ${attempt.stageId}`);
    },
  });
  return {
    adapter,
    queue: (stageId, scenario) => {
      const existing = queues.get(stageId) ?? [];
      existing.push(scenario);
      queues.set(stageId, existing);
    },
  };
}

function taskEvidenceDir(dir: string, runId: string): string {
  return path.join(dir, ".orga", "runs", runId, "tasks", TASK_ID);
}

function reviewerWorktreePaths(dir: string): string[] {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^worktree (.+)$/.exec(line);
    if (match) paths.push(match[1] as string);
  }
  return paths.filter((p) => p.includes(`${path.sep}${TASK_KEY}-review-`));
}

export async function freshReviewer(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startGitFixtureRun(dir, [{ id: TASK_ID, priority: 0 }]);
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const db = openStore(dir);
        try {
          withTransaction(db, () => {
            db.prepare(
              `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(`claim-${TASK_ID}`, runId, TASK_ID, "files", JSON.stringify([]), Date.now());
          });

          const mainBaseCommit = runGit(dir, ["rev-parse", "HEAD"]);
          const mainWorkspace = await createWorkspace({
            mode: "worktree",
            db,
            projectRoot: dir,
            runId,
            taskId: TASK_ID,
            taskKey: TASK_KEY,
            ref: mainBaseCommit,
            root: DEFAULT_WORKTREE_ROOT,
            branchPrefix: DEFAULT_BRANCH_PREFIX,
          });

          const { adapter, queue } = makeAdapter(streamsDir);
          queueImplementerScenario(streamsDir, runId, "implement", "completed");
          queue("implement", "completed");
          queueReviewerScenario(streamsDir, runId, "review-spec", "spec-reviewer", "fail", "fail");
          queue("review-spec", "fail");
          queueImplementerScenario(streamsDir, runId, "fix-spec", "completed");
          queue("fix-spec", "completed");
          queueReviewerScenario(streamsDir, runId, "review-spec", "spec-reviewer", "pass", "pass");
          queue("review-spec", "pass");
          queueReviewerScenario(streamsDir, runId, "review-quality", "code-quality-reviewer", "pass", "pass");
          queue("review-quality", "pass");

          let reviewedRef = mainBaseCommit;
          const reviewerWorkspace = createReviewerWorkspaceResolver({
            db,
            projectRoot: dir,
            root: DEFAULT_WORKTREE_ROOT,
            branchPrefix: DEFAULT_BRANCH_PREFIX,
            taskKey: TASK_KEY,
            reviewedRef: () => reviewedRef,
          });

          const taskDir = taskEvidenceDir(dir, runId);
          fs.mkdirSync(taskDir, { recursive: true });

          const input: DevelopmentStageInput = {
            db,
            adapter,
            runId,
            taskId: TASK_ID,
            now: fakeClock(1_000_000).now,
            taskDir,
            executionRoot: dir,
            requiredArtifacts: [],
            checks: {},
            env: process.env,
            workspace: mainWorkspace,
            reviewerWorkspace,
            packet: (stageId) => {
              if (stageId === "review-spec" || stageId === "review-quality") {
                reviewedRef = commitAll(mainWorkspace.path, `review snapshot for ${stageId}`);
              }
              return `packet ${stageId}`;
            },
          };

          const outcome = await runDevelopmentStages(input);

          assert.equal(outcome.outcome, "integrating", JSON.stringify(outcome));

          const reviewSpecAttempts = db
            .prepare(
              `SELECT id FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'review-spec' ORDER BY round ASC`,
            )
            .all(runId, TASK_ID) as Array<{ id: string }>;
          assert.equal(reviewSpecAttempts.length, 2, "review-spec must have run exactly twice");
          assert.notEqual(
            reviewSpecAttempts[0]!.id,
            reviewSpecAttempts[1]!.id,
            "the two review-spec rounds must record two distinct attempts.id values",
          );

          const pids = reviewSpecAttempts.map((attempt) => {
            const worker = db.prepare(`SELECT pid FROM workers WHERE attempt_id = ?`).get(attempt.id) as {
              pid: number;
            };
            return worker.pid;
          });
          assert.notEqual(pids[0], pids[1], "the two review-spec rounds must have run under two distinct pids");

          const reviewerWorktreeRows = db
            .prepare(
              `SELECT path, cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ? AND (branch LIKE ? OR branch LIKE ?)`,
            )
            .all(
              runId,
              TASK_ID,
              `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-spec-r%`,
              `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-quality-r%`,
            ) as Array<{ path: string; cleanup_state: string }>;
          assert.equal(reviewerWorktreeRows.length, 3, "two review-spec rounds and one review-quality round");
          const distinctPaths = new Set(reviewerWorktreeRows.map((row) => row.path));
          assert.equal(distinctPaths.size, reviewerWorktreeRows.length, "every reviewer worktree path is distinct");
          for (const row of reviewerWorktreeRows) {
            assert.equal(row.cleanup_state, "cleaned", `${row.path} must have reached cleanup_state = 'cleaned'`);
          }

          assert.deepEqual(
            reviewerWorktreePaths(dir),
            [],
            "no reviewer worktree may remain in `git worktree list` once the run ends",
          );
        } finally {
          db.close();
        }
      });
    } finally {
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}
