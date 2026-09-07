import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";

import { openStore } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { assembleReplayInputs } from "../src/reports/replay-inputs.ts";
import type { TaskRow } from "../src/store/types.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function fixtureTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-a",
    run_id: "run-a",
    task_key: "P1-i",
    title: "Sample task",
    brief_path: "brief.md",
    workflow_id: "dev-workflow",
    stage_id: null,
    depends_on: "[]",
    priority: 0,
    state: "ready-to-implement",
    disposition: null,
    stale_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function insertIntegration(
  db: DatabaseSync,
  overrides: { id: string; run_id: string; task_id: string; disposition: string; result_commit: string | null; created_at: number },
): void {
  db.prepare(
    `INSERT INTO integrations (id, run_id, task_id, base_commit, candidate_ref, result_commit, checks, disposition, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id,
    overrides.run_id,
    overrides.task_id,
    "base",
    "candidate",
    overrides.result_commit,
    "{}",
    overrides.disposition,
    overrides.created_at,
    null,
  );
}

function writeLedgerFile(root: string, task: TaskRow, attempts: unknown[]): void {
  const taskDir = path.join(root, ".orga", "runs", task.run_id, "tasks", task.id);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "ledger.json"), JSON.stringify({ attempts }), "utf8");
}

test("assembleReplayInputs resolves specPath against opts.root when brief_path is present", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask({ brief_path: "briefs/brief.md" });
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.specPath, path.resolve(dir, "briefs/brief.md"));
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs returns a null specPath when brief_path is null", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask({ brief_path: null });
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.specPath, null);
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs returns the integrated row's result_commit", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      insertIntegration(db, {
        id: "int-1",
        run_id: task.run_id,
        task_id: task.id,
        disposition: "integrated",
        result_commit: "abc123",
        created_at: 1,
      });
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.integrationCommit, "abc123");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs ignores an integrations row with a non-integrated disposition", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      insertIntegration(db, {
        id: "int-1",
        run_id: task.run_id,
        task_id: task.id,
        disposition: "rejected",
        result_commit: "abc123",
        created_at: 1,
      });
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.integrationCommit, null);
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs returns null integrationCommit when no integrations row matches", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.integrationCommit, null);
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs picks the most recent integrated row when several exist", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      insertIntegration(db, {
        id: "int-1",
        run_id: task.run_id,
        task_id: task.id,
        disposition: "integrated",
        result_commit: "older",
        created_at: 1,
      });
      insertIntegration(db, {
        id: "int-2",
        run_id: task.run_id,
        task_id: task.id,
        disposition: "integrated",
        result_commit: "newer",
        created_at: 2,
      });
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.integrationCommit, "newer");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs derives verificationMode from the earliest passing attempt", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      writeLedgerFile(dir, task, [
        { verdict: "pass", claimsParity: { mode: "declared" } },
        { verdict: "pass", claimsParity: { mode: "legacy" } },
      ]);
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.verificationMode, "declared");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs falls back to the last attempt when a failing-then-passing sequence is recorded", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      writeLedgerFile(dir, task, [
        { verdict: "fail", claimsParity: { mode: "declared" } },
        { verdict: "pass", claimsParity: { mode: "legacy" } },
      ]);
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.verificationMode, "legacy");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs falls back to the last attempt when every attempt failed", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      writeLedgerFile(dir, task, [
        { verdict: "fail", claimsParity: { mode: "declared" } },
        { verdict: "fail", claimsParity: { mode: "legacy" } },
      ]);
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.verificationMode, "legacy");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs defaults to legacy when the ledger has no attempts", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      writeLedgerFile(dir, task, []);
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.verificationMode, "legacy");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs defaults to legacy when the ledger file itself is absent", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.verificationMode, "legacy");
    } finally {
      db.close();
    }
  });
});

test("assembleReplayInputs defaults to legacy when the selected attempt's claimsParity has no mode field", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const task = fixtureTask();
      writeLedgerFile(dir, task, [{ verdict: "pass", claimsParity: {} }]);
      const result = assembleReplayInputs(db, task, { root: dir });
      assert.equal(result.verificationMode, "legacy");
    } finally {
      db.close();
    }
  });
});
