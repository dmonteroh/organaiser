// Fixture: task-split.
//
// Two claims about `splitTask` (`src/engine/task-split.ts`), the transactional
// runtime path behind `architect-split`: a successful split inserts every
// child row and marks the parent `superseded` in one commit, and a failing
// split (a malformed child spec that violates the `tasks` primary key)
// leaves zero child rows and the parent's disposition untouched.

import assert from "node:assert/strict";

import { openStore, startFixtureRun, seedTasks, countRows, readTaskRow, withFixtureWorkspace } from "./harness.ts";
import { splitTask, type ChildTaskSpec } from "../../src/engine/task-split.ts";

export async function successfulSplitInsertsChildrenAndSupersedesParent(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startFixtureRun(dir, [{ id: "task-parent" }]);
    const now = Date.now();
    seedTasks(dir, runId, [{ id: "task-parent" }], now);

    const children: ChildTaskSpec[] = [
      {
        id: "task-child-a",
        runId,
        taskKey: "task-child-a",
        title: "Child A",
        briefPath: "child-a-brief.md",
        workflowId: "dev-workflow",
        stageId: null,
        dependsOn: [],
        priority: 0,
        state: "defined",
        disposition: null,
      },
      {
        id: "task-child-b",
        runId,
        taskKey: "task-child-b",
        title: "Child B",
        briefPath: "child-b-brief.md",
        workflowId: "dev-workflow",
        stageId: null,
        dependsOn: ["task-child-a"],
        priority: 1,
        state: "defined",
        disposition: null,
      },
    ];

    const db = openStore(dir);
    try {
      splitTask(db, "task-parent", children, now);
    } finally {
      db.close();
    }

    const childA = readTaskRow(dir, "task-child-a");
    const childB = readTaskRow(dir, "task-child-b");
    assert.ok(childA, "child A must be inserted");
    assert.ok(childB, "child B must be inserted");
    assert.equal(childB?.depends_on, JSON.stringify(["task-child-a"]));

    const parent = readTaskRow(dir, "task-parent");
    assert.equal(parent?.disposition, "superseded", "parent must be marked superseded");
  });
}

export async function interruptedSplitInsertsNoChildrenAndLeavesParentUnchanged(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startFixtureRun(dir, [{ id: "task-parent" }]);
    const now = Date.now();
    seedTasks(dir, runId, [{ id: "task-parent" }], now);

    const duplicateIdChildren: ChildTaskSpec[] = [
      {
        id: "task-child-dup",
        runId,
        taskKey: "task-child-dup",
        title: "Duplicate child, first insert",
        briefPath: "child-dup-brief.md",
        workflowId: "dev-workflow",
        stageId: null,
        dependsOn: [],
        priority: 0,
        state: "defined",
        disposition: null,
      },
      {
        id: "task-child-dup",
        runId,
        taskKey: "task-child-dup",
        title: "Duplicate child, second insert",
        briefPath: "child-dup-brief.md",
        workflowId: "dev-workflow",
        stageId: null,
        dependsOn: [],
        priority: 0,
        state: "defined",
        disposition: null,
      },
    ];

    const db = openStore(dir);
    let threw = false;
    try {
      try {
        splitTask(db, "task-parent", duplicateIdChildren, now);
      } catch {
        threw = true;
      }
    } finally {
      db.close();
    }
    assert.ok(threw, "a malformed child spec must cause splitTask to throw");

    const childCount = countRows(dir, `SELECT COUNT(*) AS n FROM tasks WHERE id = 'task-child-dup'`);
    assert.equal(childCount, 0, "no child row may persist after a failed split");

    const parent = readTaskRow(dir, "task-parent");
    assert.equal(parent?.disposition, null, "the parent's disposition must be unchanged after a failed split");
  });
}
