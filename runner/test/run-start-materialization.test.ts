import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import { initProject } from "../src/store/init.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { startRun } from "../src/engine/supervisor-spawn.ts";
import { advanceTransitions, createSchedulerRuntime } from "../src/engine/scheduler.ts";
import type { TickContext } from "../src/engine/tick.ts";
import { workflowAssetPath } from "../src/workflow-assets.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import type { Io } from "../src/cli/commands.ts";

const WORKFLOW_PATH = workflowAssetPath("manifests/task-board.v1.yaml");
const TEMPLATE_PATH = workflowAssetPath("subagents/implementer-prompt.md");
const FIXED_NOW = 1_700_000_000_000;

// Copied local board builder per this repo's established convention (see
// `test/cli.test.ts:42-70`, `test/supervisor-detach.test.ts`,
// `test/in-place.test.ts`): each test file that needs to build a board keeps
// its own copy rather than importing one across test files.
function minimalBoard(tasks?: unknown[]): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: {
      tasks: tasks ?? [
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
          enabled: false,
        },
      ],
    },
  };
}

function writeBoard(dir: string, tasks?: unknown[]): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(minimalBoard(tasks), null, 2));
  return boardPath;
}

interface TaskOverrides {
  id: string;
  title?: string;
  briefPath?: string;
  workflowId?: string;
  stageId?: string;
  dependencies?: string[];
  priority?: number;
  claims?: unknown;
  enabled?: boolean;
}

function buildTask(overrides: TaskOverrides): Record<string, unknown> {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    briefPath: overrides.briefPath ?? "brief.md",
    entry: { workflowId: overrides.workflowId ?? "wf1", stageId: overrides.stageId ?? "analyst-initial" },
    dependencies: overrides.dependencies ?? [],
    priority: overrides.priority ?? 0,
    requiredWorkflowVersions: {},
    claims: overrides.claims ?? "unknown",
    verification: [],
    enabled: overrides.enabled ?? true,
  };
}

function boardAndPath(dir: string, tasks: unknown[]): { boardPath: string; board: unknown } {
  const boardPath = writeBoard(dir, tasks);
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8")) as unknown;
  return { boardPath, board };
}

function fakeIo(): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    env: {},
  };
}

function ioAt(dir: string): Io & { outLines: string[]; errLines: string[] } {
  const io = fakeIo();
  io.cwd = () => dir;
  return io;
}

function killGroupBestEffort(pgid: number | undefined | null): void {
  if (typeof pgid !== "number") return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

function buildTickCtx(db: ReturnType<typeof openStore>, runId: string, now: number): TickContext {
  return {
    db,
    runId,
    tickIndex: 0,
    now: () => now,
    leaseDeadlineMs: now + 60000,
    signal: new AbortController().signal,
  };
}

function tick(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  advanceTransitions(buildTickCtx(db, runId, now), createSchedulerRuntime());
}

function taskRow(db: ReturnType<typeof openStore>, id: string): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

function claimRows(db: ReturnType<typeof openStore>, taskId: string): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM claims WHERE task_id = ? ORDER BY dimension")
    .all(taskId) as Array<Record<string, unknown>>;
}

function countAll(db: ReturnType<typeof openStore>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test("startRun materializes one tasks row per enabled entry, at pre-admission starting values, and skips disabled entries", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const enabledTask = buildTask({
      id: "t-enabled",
      title: "Enabled Task",
      briefPath: "brief-enabled.md",
      workflowId: "wf-enabled",
      stageId: "analyst-initial",
      dependencies: [],
      priority: 5,
      claims: { files: ["a.txt"] },
      enabled: true,
    });
    const disabledTask = buildTask({ id: "t-disabled", enabled: false });
    const { boardPath, board } = boardAndPath(dir, [enabledTask, disabledTask]);

    const result = startRun({
      root: dir,
      boardPath,
      board,
      workflowPath: WORKFLOW_PATH,
      templatePath: TEMPLATE_PATH,
      now: () => FIXED_NOW,
      spawn: false,
    });

    const db = openStore(dir);
    try {
      assert.equal(countAll(db, "tasks"), 1, "only the enabled task should be materialized");

      const row = taskRow(db, "t-enabled");
      assert.ok(row, "enabled task row must exist");
      assert.equal(row?.task_key, "t-enabled");
      assert.equal(row?.run_id, result.runId);
      assert.equal(row?.title, "Enabled Task");
      assert.equal(row?.brief_path, "brief-enabled.md");
      assert.equal(row?.workflow_id, "wf-enabled");
      assert.equal(row?.stage_id, null);
      assert.equal(row?.depends_on, "[]");
      assert.equal(row?.priority, 5);
      assert.equal(row?.state, "defined");
      assert.equal(row?.disposition, null);
      assert.equal(row?.created_at, FIXED_NOW);
      assert.equal(row?.updated_at, FIXED_NOW);

      // The board entry's stageId vocabulary ("analyst-initial") must appear
      // nowhere in the materialized row: stage_id is NULL, not copied.
      const serializedRow = JSON.stringify(row);
      assert.ok(!serializedRow.includes("analyst-initial"));

      assert.equal(taskRow(db, "t-disabled"), undefined, "disabled task must not be materialized");
    } finally {
      db.close();
    }
  });
});

test("startRun with every task disabled creates the runs row and materializes zero tasks/claims, without throwing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const { boardPath, board } = boardAndPath(dir, [
      buildTask({ id: "t-disabled-one", enabled: false }),
      buildTask({ id: "t-disabled-two", enabled: false }),
    ]);

    const result = startRun({
      root: dir,
      boardPath,
      board,
      workflowPath: WORKFLOW_PATH,
      templatePath: TEMPLATE_PATH,
      now: () => FIXED_NOW,
      spawn: false,
    });

    const db = openStore(dir);
    try {
      assert.equal(countAll(db, "runs"), 1);
      assert.ok(db.prepare("SELECT id FROM runs WHERE id = ?").get(result.runId), "the started run must be the one row present");
      assert.equal(countAll(db, "tasks"), 0);
      assert.equal(countAll(db, "claims"), 0);
    } finally {
      db.close();
    }
  });
});

test("an explicit claims object always gets a files row; nonFile is added only when populated", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const filesOnlyTask = buildTask({ id: "t-files-only", claims: { files: ["a.txt"] } });
    const nonFileOnlyTask = buildTask({ id: "t-nonfile-only", claims: { nonFile: ["deploy-slot"] } });
    const { boardPath, board } = boardAndPath(dir, [filesOnlyTask, nonFileOnlyTask]);

    const result = startRun({
      root: dir,
      boardPath,
      board,
      workflowPath: WORKFLOW_PATH,
      templatePath: TEMPLATE_PATH,
      now: () => FIXED_NOW,
      spawn: false,
    });

    const db = openStore(dir);
    try {
      const filesOnlyClaims = claimRows(db, "t-files-only");
      assert.equal(filesOnlyClaims.length, 1);
      assert.equal(filesOnlyClaims[0]?.dimension, "files");
      assert.equal(filesOnlyClaims[0]?.value, JSON.stringify(["a.txt"]));

      const nonFileOnlyClaims = claimRows(db, "t-nonfile-only");
      assert.equal(nonFileOnlyClaims.length, 2, "a files row must be inserted even though only nonFile was declared");
      assert.equal(nonFileOnlyClaims[0]?.dimension, "files");
      assert.equal(nonFileOnlyClaims[0]?.value, "[]");
      assert.equal(nonFileOnlyClaims[1]?.dimension, "nonFile");
      assert.equal(nonFileOnlyClaims[1]?.value, JSON.stringify(["deploy-slot"]));

      // The always-present files row must not stall acquire-claims for a
      // task declaring only nonFile claims.
      tick(db, result.runId, FIXED_NOW); // admit-task -> release-dependencies
      tick(db, result.runId, FIXED_NOW); // release-dependencies -> acquire-claims
      tick(db, result.runId, FIXED_NOW); // acquire-claims -> admit-to-batch
      assert.equal(taskRow(db, "t-nonfile-only")?.stage_id, "admit-to-batch");
    } finally {
      db.close();
    }
  });
});

test('claims: "unknown" inserts exactly one sentinel files row and the task advances past acquire-claims', async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const task = buildTask({ id: "t-unknown-claims", claims: "unknown" });
    const { boardPath, board } = boardAndPath(dir, [task]);

    const result = startRun({
      root: dir,
      boardPath,
      board,
      workflowPath: WORKFLOW_PATH,
      templatePath: TEMPLATE_PATH,
      now: () => FIXED_NOW,
      spawn: false,
    });

    const db = openStore(dir);
    try {
      const rows = claimRows(db, "t-unknown-claims");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.dimension, "files");
      assert.equal(rows[0]?.value, "[]");

      tick(db, result.runId, FIXED_NOW);
      tick(db, result.runId, FIXED_NOW);
      tick(db, result.runId, FIXED_NOW);
      assert.equal(taskRow(db, "t-unknown-claims")?.stage_id, "admit-to-batch");
    } finally {
      db.close();
    }
  });
});

test("a second run start reusing task ids already in the store fails with a clear, actionable, deduplicated error naming every colliding id, from both run start and run start --foreground", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    const firstBoardPath = writeBoard(dir, [
      buildTask({ id: "id-b", claims: { files: ["b.txt"] } }),
      buildTask({ id: "id-a", claims: { files: ["a.txt"] } }),
    ]);
    const firstIo = ioAt(dir);
    const firstCode = await main(["node", "orga", "run", "start", "--board", firstBoardPath, "--json"], firstIo);
    assert.equal(firstCode, EXIT_CODES.OK);
    const firstResult = JSON.parse(firstIo.outLines[firstIo.outLines.length - 1] as string) as {
      runId: string;
      supervisorPid: number | null;
    };

    try {
      const expectedMessage =
        "error: task ids already exist in this .orga store: id-a, id-b. Task ids must be unique across " +
        "every run in one store; rename them in the board or use a fresh project root.";

      const collidingBoardPath = writeBoard(dir, [
        buildTask({ id: "id-b", title: "Reused b" }),
        buildTask({ id: "id-a", title: "Reused a" }),
      ]);

      const backgroundIo = ioAt(dir);
      const backgroundCode = await main(
        ["node", "orga", "run", "start", "--board", collidingBoardPath],
        backgroundIo,
      );
      assert.equal(backgroundCode, EXIT_CODES.INVALID_ARGS);
      assert.deepEqual(backgroundIo.errLines, [expectedMessage]);

      const foregroundIo = ioAt(dir);
      const foregroundCode = await main(
        ["node", "orga", "run", "start", "--board", collidingBoardPath, "--foreground"],
        foregroundIo,
      );
      assert.equal(foregroundCode, EXIT_CODES.INVALID_ARGS);
      assert.deepEqual(foregroundIo.errLines, [expectedMessage]);

      const db = openStore(dir);
      try {
        assert.equal(countAll(db, "runs"), 1, "neither failed attempt may commit a runs row");
        assert.equal(countAll(db, "tasks"), 2, "neither failed attempt may insert a second copy of the colliding tasks");
      } finally {
        db.close();
      }
    } finally {
      killGroupBestEffort(firstResult.supervisorPid ?? undefined);
    }
  });
});

test("run dry-run stays side-effect-free with respect to tasks, even for a board whose task is enabled", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir, [buildTask({ id: "t-dry-run", enabled: true })]);
    const io = ioAt(dir);

    const code = await main(["node", "orga", "run", "dry-run", "--board", boardPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const db = openStore(dir);
    try {
      assert.equal(countAll(db, "tasks"), 0);
    } finally {
      db.close();
    }
  });
});

test("a board that fails mid-materialization leaves neither a runs row nor any tasks/claims row behind", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    // Pre-seed an orphaned claims row for a task id that has no matching
    // tasks row yet, so the collision pre-check (which only looks at
    // `tasks`) passes, but the claims insert later in the same transaction
    // hits the `claims_task_dimension` UNIQUE index and throws mid-loop.
    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), "orphan-run", "t-atomic", "files", "[]", FIXED_NOW);
      });
    } finally {
      db.close();
    }

    const task = buildTask({ id: "t-atomic", claims: { files: ["a.txt"] } });
    const { boardPath, board } = boardAndPath(dir, [task]);

    assert.throws(() => {
      startRun({
        root: dir,
        boardPath,
        board,
        workflowPath: WORKFLOW_PATH,
        templatePath: TEMPLATE_PATH,
        now: () => FIXED_NOW,
        spawn: false,
      });
    });

    const verifyDb = openStore(dir);
    try {
      assert.equal(countAll(verifyDb, "runs"), 0);
      assert.equal(countAll(verifyDb, "tasks"), 0);
      assert.equal(countAll(verifyDb, "claims"), 1, "only the pre-seeded orphan claims row may remain");
    } finally {
      verifyDb.close();
    }
  });
});
