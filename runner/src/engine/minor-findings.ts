// `record-minors`: the idempotent, crash-safe append of a task's accepted
// `minor` review findings to the configured follow-ups file, guarded by the
// `minor_finding_appends` table (`store/migrations.ts` version 2).
//
// Crash-recovery ordering: the guard row commits first (`appended_at NULL`),
// then the file append happens, then a second update sets `appended_at`. A
// process that dies at any point up to and including the guard-row commit
// leaves no row at all, so a retry starts clean and appends once. A process
// that dies after the guard-row commit but before `appended_at` is set
// leaves a row whose `appended_at` is still NULL; a retry finds that row,
// knows from the NULL that the file append never finished, and performs it
// now instead of skipping it. A row whose `appended_at` is set means the
// append already happened, so a retry skips it. Every path other than the
// crash window itself reaches exactly one append; the crash window itself
// resolves to exactly one append on the next call, never zero and never two.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";

export const DEFAULT_FOLLOWUPS_FILE_PATH = "FOLLOWUPS.md";

export interface MinorFinding {
  summary: string;
  path: string;
  line?: number | null;
}

export interface ClaimMinorFindingsAppendInput {
  db: DatabaseSync;
  runId: string;
  taskId: string;
  attemptId: string;
  now?: () => number;
}

export interface ClaimResult {
  id: string;
  alreadyAppended: boolean;
}

export interface AppendMinorFindingsInput {
  db: DatabaseSync;
  runId: string;
  taskId: string;
  attemptId: string;
  findings: readonly MinorFinding[];
  followUpsFilePath: string;
  now?: () => number;
}

interface GuardRow {
  id: string;
  appended_at: number | null;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    /UNIQUE constraint failed/.test(err.message)
  );
}

function findGuardRow(db: DatabaseSync, runId: string, taskId: string, attemptId: string): GuardRow | undefined {
  return db
    .prepare(
      `SELECT id, appended_at FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ?`,
    )
    .get(runId, taskId, attemptId) as GuardRow | undefined;
}

function insertGuardRow(
  db: DatabaseSync,
  id: string,
  runId: string,
  taskId: string,
  attemptId: string,
  nowMs: number,
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO minor_finding_appends (id, run_id, task_id, attempt_id, appended_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(id, runId, taskId, attemptId, nowMs);
  });
}

function markAppended(db: DatabaseSync, id: string, nowMs: number): void {
  withTransaction(db, () => {
    db.prepare(`UPDATE minor_finding_appends SET appended_at = ? WHERE id = ?`).run(nowMs, id);
  });
}

// The claim half, on its own: finds or creates the guard row for
// `(run_id, task_id, attempt_id)` without ever touching the follow-ups file.
// `appendMinorFindings` uses this as its own first phase; it is exported
// separately so a caller can durably claim a triple and defer the file
// append to a later call, which is exactly the two-phase shape a crash
// between them leaves behind.
export function claimMinorFindingsAppend(input: ClaimMinorFindingsAppendInput): ClaimResult {
  const nowFn = input.now ?? Date.now;
  const existing = findGuardRow(input.db, input.runId, input.taskId, input.attemptId);
  if (existing) {
    return { id: existing.id, alreadyAppended: existing.appended_at !== null };
  }

  const id = randomUUID();
  try {
    insertGuardRow(input.db, id, input.runId, input.taskId, input.attemptId, nowFn());
    return { id, alreadyAppended: false };
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
    const raced = findGuardRow(input.db, input.runId, input.taskId, input.attemptId);
    if (!raced) throw err;
    return { id: raced.id, alreadyAppended: raced.appended_at !== null };
  }
}

function renderEntry(taskId: string, findings: readonly MinorFinding[]): string {
  const lines = findings.map((finding) => {
    const location = finding.line ? `${finding.path}:${finding.line}` : finding.path;
    return `- [${taskId}] ${finding.summary} (${location})`;
  });
  return `${lines.join("\n")}\n`;
}

// Appends `input.findings` to `input.followUpsFilePath` exactly once for
// `(input.runId, input.taskId, input.attemptId)`. A retry with the same
// triple is a no-op that still returns `"true"`; a different `attemptId`
// for the same run and task is new work and appends again. An empty
// `findings` list never claims a row and never touches the file — there is
// nothing to record. Any failure (I/O or store) returns `"false"` rather
// than throwing, matching the other `kind: runner` predicates this feeds.
export function appendMinorFindings(input: AppendMinorFindingsInput): "true" | "false" {
  if (input.findings.length === 0) return "true";

  try {
    const nowFn = input.now ?? Date.now;
    const claim = claimMinorFindingsAppend(input);
    if (claim.alreadyAppended) return "true";

    const absolutePath = path.resolve(input.followUpsFilePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.appendFileSync(absolutePath, renderEntry(input.taskId, input.findings), "utf8");

    markAppended(input.db, claim.id, nowFn());
    return "true";
  } catch {
    return "false";
  }
}
