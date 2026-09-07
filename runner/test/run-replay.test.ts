import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import type { TaskRow } from "../src/store/types.ts";
import { buildReplayReport, ReplayUnknownTaskError } from "../src/reports/run-replay.ts";

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function initRepo(dir: string): void {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
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

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.json", "running", "running", now);
  });
}

interface TaskSeed {
  id: string;
  runId: string;
  briefPath?: string | null;
  disposition?: string | null;
  now: number;
}

function insertTask(db: ReturnType<typeof openStore>, seed: TaskSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.runId,
      seed.id,
      `Task ${seed.id}`,
      seed.briefPath ?? null,
      "task-board",
      null,
      "[]",
      0,
      "integrated",
      seed.disposition ?? null,
      seed.now,
      seed.now,
    );
  });
}

interface IntegrationSeed {
  id: string;
  runId: string;
  taskId: string;
  resultCommit: string;
  now: number;
}

function insertIntegration(db: ReturnType<typeof openStore>, seed: IntegrationSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO integrations (id, run_id, task_id, base_commit, candidate_ref, result_commit, checks, disposition, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(seed.id, seed.runId, seed.taskId, "base", "candidate", seed.resultCommit, "{}", "integrated", seed.now);
  });
}

function writeDispatchLog(
  dir: string,
  rows: Array<{ role: string; commit_after?: string }>,
): void {
  const header = "seq\trole\tcommit_after";
  const lines = rows.map((r, i) => [i + 1, r.role, r.commit_after ?? "none"].join("\t"));
  fs.writeFileSync(path.join(dir, "dispatch-log.tsv"), `${[header, ...lines].join("\n")}\n`, "utf8");
}

function writeLedgerJson(taskDir: string): void {
  fs.writeFileSync(
    path.join(taskDir, "ledger.json"),
    JSON.stringify({
      attempts: [{ attemptId: "attempt1", verdict: "pass", claimsParity: null }],
    }),
    "utf8",
  );
}

// Builds a task directory whose full replay chain accepts: a "Done" spec, a
// worker commit that also serves as the integration commit (self-ancestor),
// passing spec/quality reviewer reports, and a passing verification ledger.
function buildAcceptingTaskArtifacts(
  root: string,
  runId: string,
  taskId: string,
): { specRelPath: string; workerCommit: string } {
  const specRelPath = `docs/tasks/${taskId}.md`;
  commitFile(root, specRelPath, "---\nstatus: Done\n---\n\n# Task\n", "seed spec");
  const workerCommit = commitFile(root, `src/${taskId}.txt`, "implemented\n", "implement");

  const taskDir = path.join(root, ".orga", "runs", runId, "tasks", taskId);
  const attemptDir = path.join(taskDir, "attempt1-artifacts");
  fs.mkdirSync(attemptDir, { recursive: true });

  writeDispatchLog(attemptDir, [
    { role: "implementer", commit_after: workerCommit },
    { role: "spec-reviewer" },
    { role: "quality-reviewer" },
  ]);
  fs.writeFileSync(path.join(attemptDir, "spec-reviewer.report.txt"), "Verdict: pass\n", "utf8");
  fs.writeFileSync(path.join(attemptDir, "quality-reviewer.report.txt"), "Verdict: pass\n", "utf8");
  writeLedgerJson(taskDir);

  return { specRelPath, workerCommit };
}

function snapshotTasks(db: ReturnType<typeof openStore>, runId: string): TaskRow[] {
  return db.prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY id`).all(runId) as unknown as TaskRow[];
}

test("buildReplayReport reports 'agree' when the recomputed disposition matches the stored 'integrated' disposition", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    initRepo(root);
    const runId = "run-agree";
    const taskId = "T-agree";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    let workerCommit: string;
    try {
      insertRun(db, runId, now);
      const { specRelPath, workerCommit: wc } = buildAcceptingTaskArtifacts(root, runId, taskId);
      workerCommit = wc;
      insertTask(db, { id: taskId, runId, briefPath: specRelPath, disposition: "integrated", now });
      insertIntegration(db, { id: "int-1", runId, taskId, resultCommit: workerCommit, now });
    } finally {
      db.close();
    }

    const report = buildReplayReport(root, runId);
    assert.equal(report.runId, runId);
    assert.equal(report.tasks.length, 1);
    const entry = report.tasks[0];
    assert.equal(entry.taskId, taskId);
    assert.equal(entry.status, "agree");
    assert.ok(entry.recomputed, "an 'agree' entry must carry the recomputeDisposition detail");
    assert.deepEqual(entry.recomputed, { state: "integrated", gaps: [] });
  });
});

test("buildReplayReport reports 'diverged' when the recomputed disposition disagrees with the stored 'integrated' disposition", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    initRepo(root);
    const runId = "run-diverged";
    const taskId = "T-diverged";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    try {
      insertRun(db, runId, now);
      const specRelPath = `docs/tasks/${taskId}.md`;
      commitFile(root, specRelPath, "---\nstatus: Done\n---\n\n# Task\n", "seed spec");

      const taskDir = path.join(root, ".orga", "runs", runId, "tasks", taskId);
      const attemptDir = path.join(taskDir, "attempt1-artifacts");
      fs.mkdirSync(attemptDir, { recursive: true });
      writeDispatchLog(attemptDir, [{ role: "spec-reviewer" }]);
      fs.writeFileSync(path.join(attemptDir, "spec-reviewer.report.txt"), "Verdict: fail\n", "utf8");

      insertTask(db, { id: taskId, runId, briefPath: specRelPath, disposition: "integrated", now });
    } finally {
      db.close();
    }

    const report = buildReplayReport(root, runId);
    assert.equal(report.tasks.length, 1);
    const entry = report.tasks[0];
    assert.equal(entry.status, "diverged");
    assert.ok(entry.recomputed);
    assert.equal(entry.recomputed?.state, "not-integrated");
    assert.ok(entry.recomputed && entry.recomputed.gaps.length > 0);
  });
});

test("buildReplayReport reports 'not-applicable' for a task whose stored disposition is not 'integrated'", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    const runId = "run-na";
    const taskId = "T-na";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    try {
      insertRun(db, runId, now);
      const taskDir = path.join(root, ".orga", "runs", runId, "tasks", taskId);
      fs.mkdirSync(taskDir, { recursive: true });
      insertTask(db, { id: taskId, runId, briefPath: null, disposition: "parked", now });
    } finally {
      db.close();
    }

    const report = buildReplayReport(root, runId);
    assert.equal(report.tasks.length, 1);
    const entry = report.tasks[0];
    assert.equal(entry.status, "not-applicable");
    assert.ok(entry.recomputed, "a 'not-applicable' entry must still carry the recomputeDisposition detail");
  });
});

test("buildReplayReport reports 'no-artifacts' for a store row with no matching on-disk task directory", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    const runId = "run-missing";
    const taskId = "T-missing";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    try {
      insertRun(db, runId, now);
      insertTask(db, { id: taskId, runId, briefPath: null, disposition: null, now });
    } finally {
      db.close();
    }

    const report = buildReplayReport(root, runId);
    assert.deepEqual(report.tasks, [{ taskId, status: "no-artifacts" }]);
  });
});

test("buildReplayReport reports 'orphan' for an on-disk task directory with no matching store row", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    const runId = "run-orphan";
    const orphanId = "T-orphan";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    try {
      insertRun(db, runId, now);
    } finally {
      db.close();
    }

    const taskDir = path.join(root, ".orga", "runs", runId, "tasks", orphanId);
    fs.mkdirSync(taskDir, { recursive: true });

    const report = buildReplayReport(root, runId);
    assert.deepEqual(report.tasks, [{ taskId: orphanId, status: "orphan" }]);
  });
});

test("opts.taskId narrows the report to one matching task, and throws ReplayUnknownTaskError for an unmatched id", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    const runId = "run-narrow";
    const taskA = "T-a";
    const taskB = "T-b";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    try {
      insertRun(db, runId, now);
      insertTask(db, { id: taskA, runId, briefPath: null, disposition: null, now });
      insertTask(db, { id: taskB, runId, briefPath: null, disposition: null, now });
    } finally {
      db.close();
    }

    const narrowed = buildReplayReport(root, runId, { taskId: taskA });
    assert.deepEqual(narrowed.tasks, [{ taskId: taskA, status: "no-artifacts" }]);

    assert.throws(
      () => buildReplayReport(root, runId, { taskId: "T-does-not-exist" }),
      ReplayUnknownTaskError,
    );
  });
});

test("buildReplayReport leaves every tasks row unchanged (full-table snapshot before/after)", async () => {
  await withTempWorkspace(async (root) => {
    initProject(root);
    initRepo(root);
    const runId = "run-immutable";
    const taskId = "T-immutable";
    const now = 1_700_000_000_000;

    const db = openStore(root);
    try {
      insertRun(db, runId, now);
      const { specRelPath, workerCommit } = buildAcceptingTaskArtifacts(root, runId, taskId);
      insertTask(db, { id: taskId, runId, briefPath: specRelPath, disposition: "integrated", now });
      insertIntegration(db, { id: "int-1", runId, taskId, resultCommit: workerCommit, now });
    } finally {
      db.close();
    }

    const before = (() => {
      const readDb = openStore(root);
      try {
        return snapshotTasks(readDb, runId);
      } finally {
        readDb.close();
      }
    })();

    buildReplayReport(root, runId);

    const after = (() => {
      const readDb = openStore(root);
      try {
        return snapshotTasks(readDb, runId);
      } finally {
        readDb.close();
      }
    })();

    assert.deepEqual(after, before, "buildReplayReport must not mutate any tasks row");
  });
});
