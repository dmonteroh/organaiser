import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import type { QuestionRow, TaskRow } from "../store/types.ts";

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
