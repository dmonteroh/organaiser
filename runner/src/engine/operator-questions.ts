import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { QuestionRow, TaskRow } from "../store/types.ts";

// Mirrors `workflow-stages.ts`'s `DEVELOPMENT_STAGES` id set by hand, kept
// local to this file to avoid a value-level import cycle with
// `workflow-stages.ts`. A `development.v1.yaml` stage-list change means
// updating both copies by hand.
const DEVELOPMENT_STAGE_IDS: ReadonlySet<string> = new Set([
  "implement",
  "collect-implementation-artifacts",
  "verify-task",
  "review-spec",
  "fix-spec",
  "review-quality",
  "fix-quality",
  "record-minors",
  "ready-to-integrate",
]);

// Mirrors `integration-stages.ts`'s `INTEGRATION_STAGES` id set by hand, kept
// local to this file to avoid a value-level import cycle with
// `integration-stages.ts`. An `integration.v1.yaml` stage-list change means
// updating both copies by hand.
const INTEGRATION_STAGE_IDS: ReadonlySet<string> = new Set([
  "lock-destination",
  "create-candidate",
  "replay-task",
  "verify-candidate",
  "cross-task-review",
  "advance-destination",
  "persist-integration",
  "cleanup",
]);

export interface PersistOperatorQuestionsInput {
  runId: string;
  questions: readonly unknown[];
}

interface ResolvedTarget {
  taskId: string | null;
  blockingScope: "task" | "run";
  idSuffix: string;
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function resolveTaskRowId(db: DatabaseSync, runId: string, entry: string): string | null {
  const byId = db.prepare(`SELECT id FROM tasks WHERE run_id = ? AND id = ?`).get(runId, entry) as
    | { id: string }
    | undefined;
  if (byId) return byId.id;

  const byKey = db.prepare(`SELECT id FROM tasks WHERE run_id = ? AND task_key = ?`).get(runId, entry) as
    | { id: string }
    | undefined;
  return byKey ? byKey.id : null;
}

function resolveTargets(db: DatabaseSync, runId: string, question: Record<string, unknown>): ResolvedTarget[] {
  const entries = new Set<string>();
  if (typeof question.taskId === "string") entries.add(question.taskId);
  for (const entry of stringEntries(question.blocks)) entries.add(entry);

  const targets: ResolvedTarget[] = [];
  for (const entry of entries) {
    if (entry === runId) {
      targets.push({ taskId: null, blockingScope: "run", idSuffix: "run" });
      continue;
    }
    const resolvedTaskId = resolveTaskRowId(db, runId, entry);
    if (resolvedTaskId === null) continue;
    targets.push({ taskId: resolvedTaskId, blockingScope: "task", idSuffix: resolvedTaskId });
  }
  return targets;
}

function safeDefaultSummary(question: Record<string, unknown>): string | null {
  const safeDefault = question.safeDefault as { summary?: unknown } | null | undefined;
  return safeDefault && typeof safeDefault.summary === "string" ? safeDefault.summary : null;
}

export function persistOperatorQuestions(db: DatabaseSync, input: PersistOperatorQuestionsInput, now: number): void {
  const { runId, questions } = input;
  if (!Array.isArray(questions)) return;

  withTransaction(db, () => {
    for (const raw of questions) {
      if (raw === null || typeof raw !== "object") continue;
      const question = raw as Record<string, unknown>;
      const questionId = question.id;
      if (typeof questionId !== "string") continue;

      const payload = JSON.stringify(raw);
      const owner = question.owner as string;
      const prompt = question.question as string;
      const safeDefault = safeDefaultSummary(question);

      for (const target of resolveTargets(db, runId, question)) {
        const id = `${runId}#${questionId}#${target.idSuffix}`;
        const existing = db.prepare(`SELECT 1 FROM questions WHERE id = ?`).get(id);
        if (existing) continue;

        db.prepare(
          `INSERT INTO questions
             (id, run_id, task_id, owner, blocking_scope, prompt, safe_default, answer, status, created_at, answered_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, NULL, ?)`,
        ).run(id, runId, target.taskId, owner, target.blockingScope, prompt, safeDefault, now, payload);
      }
    }
  });
}

export function listOpenQuestions(db: DatabaseSync, runId: string): QuestionRow[] {
  return db
    .prepare(`SELECT * FROM questions WHERE run_id = ? AND status = 'open' ORDER BY created_at ASC`)
    .all(runId) as unknown as QuestionRow[];
}

export function listQuestionsForRun(db: DatabaseSync, runId: string): QuestionRow[] {
  return db
    .prepare(`SELECT * FROM questions WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
    .all(runId) as unknown as QuestionRow[];
}

export function hasOpenBlockingQuestion(db: DatabaseSync, task: TaskRow): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions WHERE run_id = ? AND task_id = ? AND status = 'open'`)
    .get(task.run_id, task.id) as { n: number };
  return row.n > 0;
}

export function rawQuestionId(row: QuestionRow): string {
  if (row.payload !== null) {
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string") {
        return (parsed as { id: string }).id;
      }
    } catch {
      // fall through to the compound row primary key below
    }
  }
  return row.id;
}

export interface UnblockAnsweredTasksInput {
  runId: string;
  now: number;
}

export interface UnblockAnsweredTasksResult {
  unblocked: Array<{ taskId: string; questionIds: string[] }>;
  skipped: Array<{ taskId: string; latestAttemptStageId: string | null }>;
}

export function unblockAnsweredTasks(
  db: DatabaseSync,
  input: UnblockAnsweredTasksInput,
): UnblockAnsweredTasksResult {
  const { runId, now } = input;

  return withTransaction(db, () => {
    const candidates = db
      .prepare(
        `SELECT * FROM tasks
           WHERE run_id = ? AND disposition = 'waiting-operator'
             AND EXISTS (SELECT 1 FROM questions q WHERE q.run_id = tasks.run_id AND q.task_id = tasks.id AND q.status = 'answered')
             AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.run_id = tasks.run_id AND q.task_id = tasks.id AND q.status = 'open')
           ORDER BY priority ASC, created_at ASC`,
      )
      .all(runId) as unknown as TaskRow[];

    const unblocked: UnblockAnsweredTasksResult["unblocked"] = [];
    const skipped: UnblockAnsweredTasksResult["skipped"] = [];

    for (const task of candidates) {
      const latestAttempt = db
        .prepare(
          `SELECT stage_id FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(runId, task.id) as { stage_id: string } | undefined;
      const latestAttemptStageId = latestAttempt?.stage_id ?? null;

      // The resume target depends on which pipeline the task was blocked in,
      // not on a single hardcoded pair: a development-stage attempt resumes
      // at the implementation stage, an integration-stage attempt resumes at
      // the integration stage, and a stage id in neither set is unrecognized
      // and stays parked rather than resuming into an arbitrary stage.
      const resume: { stageId: string; state: string } | null =
        latestAttemptStageId !== null && DEVELOPMENT_STAGE_IDS.has(latestAttemptStageId)
          ? { stageId: "implementation", state: "implementing" }
          : latestAttemptStageId !== null && INTEGRATION_STAGE_IDS.has(latestAttemptStageId)
            ? { stageId: "integration", state: "integrating" }
            : null;

      if (latestAttemptStageId === null || resume === null) {
        appendEvent(db, {
          id: randomUUID(),
          run_id: runId,
          task_id: task.id,
          type: "task.unblock-skipped",
          payload: JSON.stringify({ reasonCode: "guard-stage-outside-known-pipelines", latestAttemptStageId }),
          created_at: now,
        });
        skipped.push({ taskId: task.id, latestAttemptStageId });
        continue;
      }

      const answeredRows = db
        .prepare(
          `SELECT * FROM questions WHERE run_id = ? AND task_id = ? AND status = 'answered' ORDER BY created_at ASC, id ASC`,
        )
        .all(runId, task.id) as unknown as QuestionRow[];
      const questionIds = answeredRows.map(rawQuestionId);

      db.prepare(
        `UPDATE tasks SET disposition = NULL, stage_id = ?, state = ?, updated_at = ? WHERE id = ? AND disposition = 'waiting-operator'`,
      ).run(resume.stageId, resume.state, now, task.id);

      appendEvent(db, {
        id: randomUUID(),
        run_id: runId,
        task_id: task.id,
        type: "task.unblocked",
        payload: JSON.stringify({
          previousState: "waiting-operator",
          nextState: resume.state,
          reasonCode: "operator-answer",
          questionIds,
        }),
        created_at: now,
      });

      unblocked.push({ taskId: task.id, questionIds });
    }

    return { unblocked, skipped };
  });
}

export function buildResumeContext(
  db: DatabaseSync,
  runId: string,
  taskId: string,
): { operatorAnswers: Array<{ questionId: string; question: string; answer: string; answeredAt: number }> } | null {
  const rows = db
    .prepare(
      `SELECT * FROM questions WHERE run_id = ? AND task_id = ? AND status = 'answered' ORDER BY created_at ASC, id ASC`,
    )
    .all(runId, taskId) as unknown as QuestionRow[];

  if (rows.length === 0) return null;

  return {
    operatorAnswers: rows.map((row) => ({
      questionId: rawQuestionId(row),
      question: row.prompt,
      answer: row.answer ?? "",
      answeredAt: row.answered_at ?? 0,
    })),
  };
}
