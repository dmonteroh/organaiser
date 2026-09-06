import assert from "node:assert/strict";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { markDownstreamArtifactsStale } from "../src/engine/artifact-staleness.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "starting", now);
  });
}

function insertTask(
  db: ReturnType<typeof openStore>,
  id: string,
  runId: string,
  stageId: string,
  now: number,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, runId, id, `Task ${id}`, "brief.md", "task-board", stageId, "[]", 0, "defined", null, now, now);
  });
}

function insertDependency(
  db: ReturnType<typeof openStore>,
  id: string,
  runId: string,
  taskId: string,
  stageId: string,
  artifactPath: string,
  dependsOnPath: string,
  now: number,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO artifact_dependencies (id, run_id, task_id, stage_id, artifact_path, depends_on_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, runId, taskId, stageId, artifactPath, dependsOnPath, now);
  });
}

function getTask(db: ReturnType<typeof openStore>, id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

test("markDownstreamArtifactsStale marks a directly-dependent task stale and routes it back to that dependency's stage", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-1";
      const now = 1_000_000;
      insertRun(db, runId, now);
      insertTask(db, "task-a", runId, "implementation", now);
      insertDependency(db, "dep-1", runId, "task-a", "task-refinement", "design.md", "spec.md", now);

      markDownstreamArtifactsStale(db, runId, "spec.md", now + 1);

      const taskA = getTask(db, "task-a");
      assert.equal(taskA?.stale_at, now + 1);
      assert.equal(taskA?.stage_id, "task-refinement");
    } finally {
      db.close();
    }
  });
});

test("markDownstreamArtifactsStale traverses a multi-hop dependency chain transitively", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-1";
      const now = 1_000_000;
      insertRun(db, runId, now);
      insertTask(db, "task-mid", runId, "task-refinement", now);
      insertTask(db, "task-leaf", runId, "integration", now);
      insertDependency(db, "dep-1", runId, "task-mid", "task-refinement", "design.md", "spec.md", now);
      insertDependency(db, "dep-2", runId, "task-leaf", "integration", "review.md", "design.md", now);

      markDownstreamArtifactsStale(db, runId, "spec.md", now + 1);

      const taskLeaf = getTask(db, "task-leaf");
      assert.equal(
        taskLeaf?.stale_at,
        now + 1,
        "a task depending on an artifact derived from the changed one must be marked stale too",
      );
      assert.equal(taskLeaf?.stage_id, "integration");
    } finally {
      db.close();
    }
  });
});

test("markDownstreamArtifactsStale routes a task with multiple affected artifacts to the earliest of its own stages", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-1";
      const now = 1_000_000;
      insertRun(db, runId, now);
      insertTask(db, "task-a", runId, "integration", now);
      insertDependency(db, "dep-1", runId, "task-a", "implementation", "code.ts", "design.md", now);
      insertDependency(db, "dep-2", runId, "task-a", "integration", "review.md", "design.md", now);

      markDownstreamArtifactsStale(db, runId, "design.md", now + 1);

      const taskA = getTask(db, "task-a");
      assert.equal(taskA?.stale_at, now + 1);
      assert.equal(
        taskA?.stage_id,
        "implementation",
        "the earlier of the two affected stages must win",
      );
    } finally {
      db.close();
    }
  });
});

test("markDownstreamArtifactsStale leaves an unrelated task untouched", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-1";
      const now = 1_000_000;
      insertRun(db, runId, now);
      insertTask(db, "task-unrelated", runId, "implementation", now);
      insertDependency(db, "dep-1", runId, "task-unrelated", "implementation", "other.ts", "other-spec.md", now);

      markDownstreamArtifactsStale(db, runId, "spec.md", now + 1);

      const taskUnrelated = getTask(db, "task-unrelated");
      assert.equal(taskUnrelated?.stale_at, null);
      assert.equal(taskUnrelated?.stage_id, "implementation");
    } finally {
      db.close();
    }
  });
});

test("markDownstreamArtifactsStale scopes the query to the given run_id", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const now = 1_000_000;
      insertRun(db, "run-1", now);
      insertRun(db, "run-2", now);
      insertTask(db, "task-other-run", "run-2", "implementation", now);
      insertDependency(db, "dep-1", "run-2", "task-other-run", "implementation", "code.ts", "spec.md", now);

      markDownstreamArtifactsStale(db, "run-1", "spec.md", now + 1);

      const taskOtherRun = getTask(db, "task-other-run");
      assert.equal(taskOtherRun?.stale_at, null, "a matching artifact in a different run must not be affected");
    } finally {
      db.close();
    }
  });
});
