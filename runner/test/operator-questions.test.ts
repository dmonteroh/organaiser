import assert from "node:assert/strict";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import {
  buildResumeContext,
  hasOpenBlockingQuestion,
  listOpenQuestions,
  persistOperatorQuestions,
  unblockAnsweredTasks,
} from "../src/engine/operator-questions.ts";
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
  disposition?: string | null;
  state?: string;
  priority?: number;
}

function insertTask(db: ReturnType<typeof openStore>, seed: TaskSeed): TaskRow {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      RUN_ID,
      seed.taskKey,
      `Task ${seed.id}`,
      "brief.md",
      "task-board",
      null,
      "[]",
      seed.priority ?? 0,
      seed.state ?? "implementing",
      seed.disposition ?? null,
      seed.now,
      seed.now,
    );
  });
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(seed.id) as unknown as TaskRow;
}

interface AttemptSeed {
  id: string;
  taskId: string;
  stageId: string;
  createdAt: number;
  round?: number;
}

function insertAttempt(db: ReturnType<typeof openStore>, seed: AttemptSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO attempts
         (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, interrupt_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      seed.id,
      RUN_ID,
      seed.taskId,
      seed.stageId,
      "implementer",
      seed.round ?? 1,
      "input-version",
      "fake",
      "fake",
      "{}",
      1,
      "completed",
      seed.createdAt,
    );
  });
}

interface QuestionSeed {
  id: string;
  taskId: string;
  status: "open" | "answered";
  prompt: string;
  payloadId?: string;
  answer?: string | null;
  createdAt: number;
  answeredAt?: number | null;
}

function insertQuestion(db: ReturnType<typeof openStore>, seed: QuestionSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO questions (id, run_id, task_id, owner, blocking_scope, prompt, safe_default, answer, status, created_at, answered_at, payload)
       VALUES (?, ?, ?, 'operator', 'task', ?, NULL, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      RUN_ID,
      seed.taskId,
      seed.prompt,
      seed.answer ?? null,
      seed.status,
      seed.createdAt,
      seed.answeredAt ?? null,
      seed.payloadId === undefined ? null : JSON.stringify({ id: seed.payloadId }),
    );
  });
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

test("unblockAnsweredTasks un-terminals a waiting-operator task whose latest attempt sits at a development stage, appends task.unblocked, and orders questionIds by created_at ASC then id ASC", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a", taskKey: "task-a", now: 1_000_000, disposition: "waiting-operator", state: "waiting-operator" });
      insertAttempt(db, { id: "attempt-1", taskId: "task-a", stageId: "review-spec", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-b#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "second",
        payloadId: "q-b",
        answer: "answer b",
        createdAt: 2_000_000,
        answeredAt: 2_500_000,
      });
      insertQuestion(db, {
        id: `${RUN_ID}#q-a#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "first",
        payloadId: "q-a",
        answer: "answer a",
        createdAt: 1_500_000,
        answeredAt: 2_400_000,
      });

      const result = unblockAnsweredTasks(db, { runId: RUN_ID, now: 3_000_000 });

      assert.deepEqual(result.skipped, []);
      assert.equal(result.unblocked.length, 1);
      assert.equal(result.unblocked[0]!.taskId, "task-a");
      assert.deepEqual(result.unblocked[0]!.questionIds, ["q-a", "q-b"]);

      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get("task-a") as unknown as TaskRow;
      assert.equal(task.disposition, null);
      assert.equal(task.stage_id, "implementation");
      assert.equal(task.state, "implementing");
      assert.equal(task.updated_at, 3_000_000);

      const events = db
        .prepare(`SELECT type, task_id, payload FROM events WHERE run_id = ? AND type = 'task.unblocked'`)
        .all(RUN_ID) as Array<{ type: string; task_id: string | null; payload: string }>;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.task_id, "task-a");
      assert.deepEqual(JSON.parse(events[0]!.payload), {
        previousState: "waiting-operator",
        nextState: "implementing",
        reasonCode: "operator-answer",
        questionIds: ["q-a", "q-b"],
      });
    } finally {
      db.close();
    }
  });
});

test("unblockAnsweredTasks un-terminals a waiting-operator task whose latest attempt sits at an integration stage, resuming at stage_id 'integration'/state 'integrating', and appends task.unblocked with nextState 'integrating'", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a", taskKey: "task-a", now: 1_000_000, disposition: "waiting-operator", state: "waiting-operator" });
      insertAttempt(db, { id: "attempt-1", taskId: "task-a", stageId: "cross-task-review", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-a#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "first",
        payloadId: "q-a",
        answer: "answer a",
        createdAt: 1_500_000,
        answeredAt: 2_000_000,
      });

      const result = unblockAnsweredTasks(db, { runId: RUN_ID, now: 3_000_000 });

      assert.deepEqual(result.skipped, []);
      assert.equal(result.unblocked.length, 1);
      assert.equal(result.unblocked[0]!.taskId, "task-a");
      assert.deepEqual(result.unblocked[0]!.questionIds, ["q-a"]);

      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get("task-a") as unknown as TaskRow;
      assert.equal(task.disposition, null);
      assert.equal(task.stage_id, "integration");
      assert.equal(task.state, "integrating");
      assert.equal(task.updated_at, 3_000_000);

      const events = db
        .prepare(`SELECT type, task_id, payload FROM events WHERE run_id = ? AND type = 'task.unblocked'`)
        .all(RUN_ID) as Array<{ type: string; task_id: string | null; payload: string }>;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.task_id, "task-a");
      assert.deepEqual(JSON.parse(events[0]!.payload), {
        previousState: "waiting-operator",
        nextState: "integrating",
        reasonCode: "operator-answer",
        questionIds: ["q-a"],
      });
    } finally {
      db.close();
    }
  });
});

test("unblockAnsweredTasks skips a candidate whose latest attempt's stage_id is outside both DEVELOPMENT_STAGE_IDS and INTEGRATION_STAGE_IDS, without writing the tasks row, and appends task.unblock-skipped", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a", taskKey: "task-a", now: 1_000_000, disposition: "waiting-operator", state: "waiting-operator" });
      insertAttempt(db, { id: "attempt-1", taskId: "task-a", stageId: "task-refinement", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-a#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "first",
        payloadId: "q-a",
        answer: "answer a",
        createdAt: 1_500_000,
        answeredAt: 2_000_000,
      });

      const result = unblockAnsweredTasks(db, { runId: RUN_ID, now: 3_000_000 });

      assert.deepEqual(result.unblocked, []);
      assert.equal(result.skipped.length, 1);
      assert.deepEqual(result.skipped[0], { taskId: "task-a", latestAttemptStageId: "task-refinement" });

      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get("task-a") as unknown as TaskRow;
      assert.equal(task.disposition, "waiting-operator");
      assert.equal(task.updated_at, 1_000_000);

      const events = db
        .prepare(`SELECT type, task_id, payload FROM events WHERE run_id = ? AND type = 'task.unblock-skipped'`)
        .all(RUN_ID) as Array<{ type: string; task_id: string | null; payload: string }>;
      assert.equal(events.length, 1);
      assert.equal(events[0]!.task_id, "task-a");
      assert.deepEqual(JSON.parse(events[0]!.payload), {
        reasonCode: "guard-stage-outside-known-pipelines",
        latestAttemptStageId: "task-refinement",
      });
    } finally {
      db.close();
    }
  });
});

test("unblockAnsweredTasks skips a candidate with no attempts row at all", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a", taskKey: "task-a", now: 1_000_000, disposition: "waiting-operator", state: "waiting-operator" });
      insertQuestion(db, {
        id: `${RUN_ID}#q-a#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "first",
        payloadId: "q-a",
        answer: "answer a",
        createdAt: 1_500_000,
        answeredAt: 2_000_000,
      });

      const result = unblockAnsweredTasks(db, { runId: RUN_ID, now: 3_000_000 });

      assert.deepEqual(result.unblocked, []);
      assert.deepEqual(result.skipped, [{ taskId: "task-a", latestAttemptStageId: null }]);
    } finally {
      db.close();
    }
  });
});

test("unblockAnsweredTasks selects the latest attempts row by rowid when two rows share created_at", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a", taskKey: "task-a", now: 1_000_000, disposition: "waiting-operator", state: "waiting-operator" });
      insertAttempt(db, { id: "attempt-earlier-rowid", taskId: "task-a", stageId: "implement", createdAt: 1_000_000 });
      insertAttempt(db, { id: "attempt-later-rowid", taskId: "task-a", stageId: "task-refinement", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-a#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "first",
        payloadId: "q-a",
        answer: "answer a",
        createdAt: 1_500_000,
        answeredAt: 2_000_000,
      });

      const result = unblockAnsweredTasks(db, { runId: RUN_ID, now: 3_000_000 });

      assert.deepEqual(result.unblocked, []);
      assert.deepEqual(result.skipped, [{ taskId: "task-a", latestAttemptStageId: "task-refinement" }]);
    } finally {
      db.close();
    }
  });
});

test("unblockAnsweredTasks excludes a candidate with an open question row, visits candidates in priority ASC then created_at ASC order, and does not roll back a guard-skipped candidate's siblings", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, {
        id: "task-still-open",
        taskKey: "task-still-open",
        now: 1_000_000,
        priority: 0,
        disposition: "waiting-operator",
        state: "waiting-operator",
      });
      insertAttempt(db, { id: "attempt-still-open", taskId: "task-still-open", stageId: "implement", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-open#task-still-open`,
        taskId: "task-still-open",
        status: "open",
        prompt: "still open",
        payloadId: "q-open",
        createdAt: 1_000_000,
      });

      insertTask(db, {
        id: "task-skip",
        taskKey: "task-skip",
        now: 1_000_000,
        priority: 1,
        disposition: "waiting-operator",
        state: "waiting-operator",
      });
      insertAttempt(db, { id: "attempt-skip", taskId: "task-skip", stageId: "task-refinement", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-skip#task-skip`,
        taskId: "task-skip",
        status: "answered",
        prompt: "skip me",
        payloadId: "q-skip",
        answer: "a",
        createdAt: 1_000_000,
        answeredAt: 1_500_000,
      });

      insertTask(db, {
        id: "task-unblock",
        taskKey: "task-unblock",
        now: 1_000_000,
        priority: 2,
        disposition: "waiting-operator",
        state: "waiting-operator",
      });
      insertAttempt(db, { id: "attempt-unblock", taskId: "task-unblock", stageId: "implement", createdAt: 1_000_000 });
      insertQuestion(db, {
        id: `${RUN_ID}#q-unblock#task-unblock`,
        taskId: "task-unblock",
        status: "answered",
        prompt: "unblock me",
        payloadId: "q-unblock",
        answer: "a",
        createdAt: 1_000_000,
        answeredAt: 1_500_000,
      });

      const result = unblockAnsweredTasks(db, { runId: RUN_ID, now: 3_000_000 });

      assert.deepEqual(
        result.skipped.map((entry) => entry.taskId),
        ["task-skip"],
      );
      assert.deepEqual(
        result.unblocked.map((entry) => entry.taskId),
        ["task-unblock"],
      );

      assert.equal(
        (db.prepare(`SELECT disposition FROM tasks WHERE id = ?`).get("task-still-open") as { disposition: string | null })
          .disposition,
        "waiting-operator",
      );
      assert.equal(
        (db.prepare(`SELECT disposition FROM tasks WHERE id = ?`).get("task-skip") as { disposition: string | null })
          .disposition,
        "waiting-operator",
      );
      assert.equal(
        (db.prepare(`SELECT disposition FROM tasks WHERE id = ?`).get("task-unblock") as { disposition: string | null })
          .disposition,
        null,
      );
    } finally {
      db.close();
    }
  });
});

test("buildResumeContext returns null for a task with zero answered rows and its full ordered shape for one with answered rows", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, RUN_ID, 1_000_000);
      insertTask(db, { id: "task-a", taskKey: "task-a", now: 1_000_000 });

      assert.equal(buildResumeContext(db, RUN_ID, "task-a"), null);

      insertQuestion(db, {
        id: `${RUN_ID}#q-open#task-a`,
        taskId: "task-a",
        status: "open",
        prompt: "still open",
        payloadId: "q-open",
        createdAt: 1_000_000,
      });
      assert.equal(buildResumeContext(db, RUN_ID, "task-a"), null, "an open row alone still yields null");

      insertQuestion(db, {
        id: `${RUN_ID}#q-b#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "second question",
        payloadId: "q-b",
        answer: "second answer",
        createdAt: 2_000_000,
        answeredAt: 2_500_000,
      });
      insertQuestion(db, {
        id: `${RUN_ID}#q-a#task-a`,
        taskId: "task-a",
        status: "answered",
        prompt: "first question",
        payloadId: "q-a",
        answer: "first answer",
        createdAt: 1_500_000,
        answeredAt: 2_400_000,
      });

      const context = buildResumeContext(db, RUN_ID, "task-a");
      assert.deepEqual(context, {
        operatorAnswers: [
          { questionId: "q-a", question: "first question", answer: "first answer", answeredAt: 2_400_000 },
          { questionId: "q-b", question: "second question", answer: "second answer", answeredAt: 2_500_000 },
        ],
      });
      assert.deepEqual(Object.keys(context!.operatorAnswers[0]!), ["questionId", "question", "answer", "answeredAt"]);
    } finally {
      db.close();
    }
  });
});
