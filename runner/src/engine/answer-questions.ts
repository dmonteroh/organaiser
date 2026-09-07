import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import { makeArtifactRef, type ArtifactRef } from "../store/artifact-ref.ts";
import { hasOpenBlockingQuestion, listQuestionsForRun } from "./operator-questions.ts";
import type { QuestionRow, TaskRow } from "../store/types.ts";

// Every artifact for an answered key is written to disk before the row and
// event transaction opens. A crash between the last artifact write and the
// transaction committing leaves an orphan artifact version on disk and its
// rows still `open`; a later run over the same answers file resolves those
// keys again and writes the next version.

export class UnknownQuestionKeyError extends Error {
  constructor(keys: readonly string[]) {
    super(`unknown question key(s): ${keys.join(", ")}`);
    this.name = "UnknownQuestionKeyError";
  }
}

interface AnswerQuestionsInput {
  root: string;
  runId: string;
  answers: ReadonlyMap<string, string>;
}

export interface AnswerQuestionsResult {
  runId: string;
  answered: Array<{ questionId: string; rowIds: string[]; artifact: ArtifactRef }>;
  unblockedTaskIds: string[];
}

interface PayloadIndex {
  byPayloadId: Map<string, QuestionRow[]>;
  noPayloadById: Map<string, QuestionRow>;
}

function buildPayloadIndex(rows: readonly QuestionRow[]): PayloadIndex {
  const byPayloadId = new Map<string, QuestionRow[]>();
  const noPayloadById = new Map<string, QuestionRow>();
  for (const row of rows) {
    if (row.payload === null) {
      noPayloadById.set(row.id, row);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      noPayloadById.set(row.id, row);
      continue;
    }
    const parsedId =
      parsed !== null && typeof parsed === "object" && typeof (parsed as { id?: unknown }).id === "string"
        ? ((parsed as { id: string }).id)
        : null;
    if (parsedId === null) continue;
    const existing = byPayloadId.get(parsedId);
    if (existing) existing.push(row);
    else byPayloadId.set(parsedId, [row]);
  }
  return { byPayloadId, noPayloadById };
}

function matchedRowsForKey(
  key: string,
  index: PayloadIndex,
  runId: string,
  taskIds: readonly string[],
): QuestionRow[] {
  const matched: QuestionRow[] = [...(index.byPayloadId.get(key) ?? [])];
  const candidateIds = [`${runId}#${key}#run`, ...taskIds.map((taskId) => `${runId}#${key}#${taskId}`)];
  for (const candidateId of candidateIds) {
    const row = index.noPayloadById.get(candidateId);
    if (row) matched.push(row);
  }
  return matched;
}

function byCreatedAtThenId(a: QuestionRow, b: QuestionRow): number {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

interface AnsweredWrite {
  key: string;
  answer: string;
  rowIds: string[];
  blockedTaskIds: string[];
  artifact: ArtifactRef;
}

function ensureSecureDir(orgaRoot: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  let dir = path.resolve(target);
  const resolvedOrgaRoot = path.resolve(orgaRoot);
  while (true) {
    fs.chmodSync(dir, 0o700);
    if (dir === resolvedOrgaRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

const MAX_ARTIFACT_VERSION_ATTEMPTS = 1000;

function openNextArtifactVersion(answersDir: string, questionId: string): { fd: number; filePath: string } {
  for (let version = 1; version <= MAX_ARTIFACT_VERSION_ATTEMPTS; version++) {
    const filePath = path.join(answersDir, `${questionId}.v${version}.json`);
    try {
      const fd = fs.openSync(filePath, "wx", 0o600);
      return { fd, filePath };
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error(`exceeded ${MAX_ARTIFACT_VERSION_ATTEMPTS} version attempts for answer artifact ${questionId}`);
}

export function answerQuestions(db: DatabaseSync, input: AnswerQuestionsInput, now: number): AnswerQuestionsResult {
  const { root, runId, answers } = input;

  const rows = listQuestionsForRun(db, runId);
  const taskIds = (db.prepare(`SELECT id FROM tasks WHERE run_id = ?`).all(runId) as Array<{ id: string }>).map(
    (row) => row.id,
  );
  const index = buildPayloadIndex(rows);

  const unknownKeys: string[] = [];
  const answeredKeys: Array<{ key: string; answer: string; rowIds: string[]; blockedTaskIds: string[] }> = [];

  for (const [key, answer] of answers) {
    const matched = matchedRowsForKey(key, index, runId, taskIds);
    if (matched.length === 0) {
      unknownKeys.push(key);
      continue;
    }
    const openRows = matched.filter((row) => row.status === "open").sort(byCreatedAtThenId);
    if (openRows.length === 0) continue;
    const blockedTaskIds = [...new Set(openRows.map((row) => row.task_id).filter((id): id is string => id !== null))].sort();
    answeredKeys.push({ key, answer, rowIds: openRows.map((row) => row.id), blockedTaskIds });
  }

  if (unknownKeys.length > 0) {
    throw new UnknownQuestionKeyError(unknownKeys);
  }

  const answersDir = path.join(root, ".orga", "runs", runId, "answers");
  const writes: AnsweredWrite[] = [];
  for (const entry of answeredKeys) {
    ensureSecureDir(path.join(root, ".orga"), answersDir);
    const { fd, filePath } = openNextArtifactVersion(answersDir, entry.key);
    const content = `${JSON.stringify(
      {
        questionId: entry.key,
        answer: entry.answer,
        rowIds: entry.rowIds,
        blockedTaskIds: entry.blockedTaskIds,
        answeredAt: now,
      },
      null,
      2,
    )}\n`;
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    fs.chmodSync(filePath, 0o600);
    const artifact = makeArtifactRef(root, filePath);
    writes.push({ key: entry.key, answer: entry.answer, rowIds: entry.rowIds, blockedTaskIds: entry.blockedTaskIds, artifact });
  }

  return withTransaction(db, () => {
    for (const write of writes) {
      for (const rowId of write.rowIds) {
        db.prepare(`UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?`).run(
          write.answer,
          now,
          rowId,
        );
      }
    }

    const answered: AnswerQuestionsResult["answered"] = [];
    for (const write of writes) {
      appendEvent(db, {
        id: randomUUID(),
        run_id: runId,
        task_id: null,
        type: "question.answered",
        payload: JSON.stringify({
          questionId: write.key,
          rowIds: write.rowIds,
          blockedTaskIds: write.blockedTaskIds,
          previousState: "open",
          nextState: "answered",
          reasonCode: "operator-answer",
          evidencePaths: [write.artifact],
        }),
        created_at: now,
      });
      answered.push({ questionId: write.key, rowIds: write.rowIds, artifact: write.artifact });
    }

    const candidateTaskIds = [...new Set(writes.flatMap((write) => write.blockedTaskIds))].sort();
    const unblockedTaskIds: string[] = [];
    for (const taskId of candidateTaskIds) {
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
      if (task && !hasOpenBlockingQuestion(db, task)) unblockedTaskIds.push(taskId);
    }

    return { runId, answered, unblockedTaskIds };
  });
}
