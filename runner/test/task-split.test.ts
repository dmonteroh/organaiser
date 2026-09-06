import assert from "node:assert/strict";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { splitTask, type ChildTaskSpec } from "../src/engine/task-split.ts";
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
  now: number,
  disposition: string | null = null,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, runId, id, `Task ${id}`, "brief.md", "task-board", "task-refinement", "[]", 0, "refining", disposition, now, now);
  });
}

function getTask(db: ReturnType<typeof openStore>, id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function countTasks(db: ReturnType<typeof openStore>, runId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE run_id = ?").get(runId) as { n: number };
  return row.n;
}

function childSpec(overrides: Partial<ChildTaskSpec> & { id: string; runId: string }): ChildTaskSpec {
  return {
    id: overrides.id,
    runId: overrides.runId,
    taskKey: overrides.taskKey ?? overrides.id,
    title: overrides.title ?? `Child ${overrides.id}`,
    briefPath: overrides.briefPath ?? "child-brief.md",
    workflowId: overrides.workflowId ?? "task-board",
    stageId: overrides.stageId ?? null,
    dependsOn: overrides.dependsOn ?? [],
    priority: overrides.priority ?? 0,
    state: overrides.state ?? "defined",
    disposition: overrides.disposition ?? null,
  };
}

test("splitTask inserts every child row and marks the parent superseded in one commit", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-1";
      const now = 1_000_000;
      insertRun(db, runId, now);
      insertTask(db, "task-parent", runId, now);

      const children = [
        childSpec({ id: "task-child-1", runId, priority: 0 }),
        childSpec({ id: "task-child-2", runId, priority: 1, dependsOn: ["task-child-1"] }),
      ];

      splitTask(db, "task-parent", children, now + 1);

      const child1 = getTask(db, "task-child-1");
      const child2 = getTask(db, "task-child-2");
      assert.ok(child1, "first child must be inserted");
      assert.ok(child2, "second child must be inserted");
      assert.equal(child1?.run_id, runId);
      assert.equal(child2?.depends_on, JSON.stringify(["task-child-1"]));
      assert.equal(child1?.created_at, now + 1);
      assert.equal(child1?.updated_at, now + 1);

      const parent = getTask(db, "task-parent");
      assert.equal(parent?.disposition, "superseded");
      assert.equal(parent?.updated_at, now + 1);
    } finally {
      db.close();
    }
  });
});

test("splitTask rolls back the entire transaction when one child insert fails, leaving the parent's disposition unchanged", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-1";
      const now = 1_000_000;
      insertRun(db, runId, now);
      insertTask(db, "task-parent", runId, now);
      const beforeCount = countTasks(db, runId);

      const children = [
        childSpec({ id: "task-child-dup", runId }),
        childSpec({ id: "task-child-dup", runId }),
      ];

      assert.throws(() => splitTask(db, "task-parent", children, now + 1));

      assert.equal(getTask(db, "task-child-dup"), undefined, "no child row may persist after a failed split");
      assert.equal(countTasks(db, runId), beforeCount, "no extra task rows may persist after a failed split");

      const parent = getTask(db, "task-parent");
      assert.equal(parent?.disposition, null, "the parent's disposition must be unchanged after a failed split");
      assert.equal(parent?.updated_at, now, "the parent's updated_at must be unchanged after a failed split");
    } finally {
      db.close();
    }
  });
});
