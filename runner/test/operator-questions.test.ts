import assert from "node:assert/strict";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import { hasOpenBlockingQuestion, listOpenQuestions, persistOperatorQuestions } from "../src/engine/operator-questions.ts";
import type { QuestionRow, TaskRow } from "../src/store/types.ts";

const RUN_ID = "run-1";

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(runId, "board.json", "running", "running", now);
  });
}

interface TaskSeed {
  id: string;
  taskKey: string;
  now: number;
}

function insertTask(db: ReturnType<typeof openStore>, seed: TaskSeed): TaskRow {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(seed.id, RUN_ID, seed.taskKey, `Task ${seed.id}`, "brief.md", "task-board", null, "[]", 0, "implementing", null, seed.now, seed.now);
  });
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(seed.id) as unknown as TaskRow;
}

function questionsRowsFor(db: ReturnType<typeof openStore>, runId: string): QuestionRow[] {
  return db
    .prepare(`SELECT * FROM questions WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as unknown as QuestionRow[];
}

test("persistOperatorQuestions fans out {taskId} union blocks, resolving by tasks.id then tasks.task_key, and writes a run-scope row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      const taskA = insertTask(db, { id: "task-a-row", taskKey: "task-a", now: 1_000_000 });
      const taskB = insertTask(db, { id: "task-b-row", taskKey: "task-b", now: 1_000_000 });

      const question = {
        id: "q1",
        taskId: "task-a",
        owner: "operator",
        question: "Which approach?",
        context: "some context",
        impact: "some impact",
        options: [{ id: "o1", summary: "Option 1" }],
        safeDefault: { summary: "use option 1", optionId: "o1" },
        blocks: ["task-b-row", RUN_ID],
      };

      persistOperatorQuestions(db, { runId: RUN_ID, questions: [question] }, 2_000_000);

      const rows = questionsRowsFor(db, RUN_ID);
      assert.equal(rows.length, 3);

      const byId = new Map(rows.map((row) => [row.id, row]));

      const taskRow = byId.get(`${RUN_ID}#q1#${taskA.id}`);
      assert.ok(taskRow, "task-key-resolved row must exist");
      assert.equal(taskRow!.task_id, taskA.id);
      assert.equal(taskRow!.blocking_scope, "task");

      const idRow = byId.get(`${RUN_ID}#q1#${taskB.id}`);
      assert.ok(idRow, "tasks.id-resolved row must exist");
      assert.equal(idRow!.task_id, taskB.id);
      assert.equal(idRow!.blocking_scope, "task");

      const runRow = byId.get(`${RUN_ID}#q1#run`);
      assert.ok(runRow, "run-scope row must exist");
      assert.equal(runRow!.task_id, null);
      assert.equal(runRow!.blocking_scope, "run");

      for (const row of rows) {
        assert.equal(row.owner, "operator");
        assert.equal(row.prompt, "Which approach?");
        assert.equal(row.safe_default, "use option 1");
        assert.equal(row.status, "open");
        assert.equal(row.created_at, 2_000_000);
        assert.equal(row.answer, null);
        assert.equal(row.answered_at, null);
        assert.ok(row.payload);
        assert.deepEqual(JSON.parse(row.payload as string), question);
      }
    } finally {
      db.close();
    }
  });
});

test("an unresolvable blocks[] entry is skipped without throwing, and the verbatim blocks[] still reaches payload", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      const taskC = insertTask(db, { id: "task-c-row", taskKey: "task-c", now: 1_000_000 });

      const question = {
        id: "q2",
        taskId: "task-c-row",
        owner: "orchestrator-context",
        question: "second question",
        context: "ctx2",
        impact: "impact2",
        safeDefault: null,
        blocks: ["no-such-task"],
      };

      assert.doesNotThrow(() => {
        persistOperatorQuestions(db, { runId: RUN_ID, questions: [question] }, 3_000_000);
      });

      const rows = questionsRowsFor(db, RUN_ID);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.task_id, taskC.id);
      assert.equal(row.safe_default, null);
      assert.deepEqual((JSON.parse(row.payload as string) as { blocks: string[] }).blocks, ["no-such-task"]);
    } finally {
      db.close();
    }
  });
});

test("re-ingesting the same stage result inserts no duplicate row and throws nothing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a-row", taskKey: "task-a", now: 1_000_000 });

      const question = {
        id: "q1",
        taskId: "task-a",
        owner: "operator",
        question: "repeat me",
        context: "ctx",
        impact: "impact",
        safeDefault: null,
        blocks: [],
      };

      persistOperatorQuestions(db, { runId: RUN_ID, questions: [question] }, 2_000_000);
      const firstCount = questionsRowsFor(db, RUN_ID).length;
      assert.equal(firstCount, 1);

      assert.doesNotThrow(() => {
        persistOperatorQuestions(db, { runId: RUN_ID, questions: [question] }, 4_000_000);
      });
      assert.equal(questionsRowsFor(db, RUN_ID).length, firstCount);
    } finally {
      db.close();
    }
  });
});

test("a non-array questions value and a non-object entry are no-ops", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);

      assert.doesNotThrow(() => {
        persistOperatorQuestions(db, { runId: RUN_ID, questions: "not-an-array" as unknown as unknown[] }, 2_000_000);
      });
      assert.equal(questionsRowsFor(db, RUN_ID).length, 0);

      assert.doesNotThrow(() => {
        persistOperatorQuestions(db, { runId: RUN_ID, questions: [null, "also not an object", 42] }, 2_000_000);
      });
      assert.equal(questionsRowsFor(db, RUN_ID).length, 0);
    } finally {
      db.close();
    }
  });
});

test("listOpenQuestions returns only status='open' rows for the run, ordered by created_at ASC", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a-row", taskKey: "task-a", now: 1_000_000 });

      persistOperatorQuestions(
        db,
        { runId: RUN_ID, questions: [{ id: "q-later", taskId: "task-a-row", owner: "operator", question: "later", context: "c", impact: "i", safeDefault: null, blocks: [] }] },
        5_000_000,
      );
      persistOperatorQuestions(
        db,
        { runId: RUN_ID, questions: [{ id: "q-earlier", taskId: "task-a-row", owner: "operator", question: "earlier", context: "c", impact: "i", safeDefault: null, blocks: [] }] },
        1_000_000,
      );
      withTransaction(db, () => {
        db.prepare(`UPDATE questions SET status = 'answered' WHERE id = ?`).run(`${RUN_ID}#q-later#task-a-row`);
      });

      const open = listOpenQuestions(db, RUN_ID);
      assert.deepEqual(open.map((row) => row.id), [`${RUN_ID}#q-earlier#task-a-row`]);
    } finally {
      db.close();
    }
  });
});

test("hasOpenBlockingQuestion is true for exactly {taskId} union blocks and false for an unrelated task", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      const taskA = insertTask(db, { id: "task-a-row", taskKey: "task-a", now: 1_000_000 });
      const taskB = insertTask(db, { id: "task-b-row", taskKey: "task-b", now: 1_000_000 });
      const taskUnrelated = insertTask(db, { id: "task-unrelated-row", taskKey: "task-unrelated", now: 1_000_000 });

      persistOperatorQuestions(
        db,
        {
          runId: RUN_ID,
          questions: [
            {
              id: "q3",
              taskId: "task-a",
              owner: "operator",
              question: "blocks two tasks",
              context: "c",
              impact: "i",
              safeDefault: null,
              blocks: ["task-b-row"],
            },
          ],
        },
        2_000_000,
      );

      assert.equal(hasOpenBlockingQuestion(db, taskA), true);
      assert.equal(hasOpenBlockingQuestion(db, taskB), true);
      assert.equal(hasOpenBlockingQuestion(db, taskUnrelated), false);
    } finally {
      db.close();
    }
  });
});
