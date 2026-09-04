import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { EventRow } from "./types.ts";

export class EventTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventTransactionError";
  }
}

export interface AppendEventInput {
  id: string;
  run_id: string;
  task_id?: string | null;
  attempt_id?: string | null;
  type: string;
  payload: string;
  created_at: number;
}

// Assigns `seq` as MAX(seq)+1 for the run, inside the caller's own
// transaction, so the seq read-and-insert is atomic with the state change it
// records. Must run inside an already-open transaction: the caller owns
// commit/rollback via `withTransaction`, and mirroring to events.jsonl
// happens only after that transaction has committed (see mirrorEvent).
export function appendEvent(db: DatabaseSync, event: AppendEventInput): EventRow {
  if (!db.isTransaction) {
    throw new EventTransactionError("appendEvent must be called inside an open transaction");
  }

  const maxSeqRow = db
    .prepare("SELECT MAX(seq) AS maxSeq FROM events WHERE run_id = ?")
    .get(event.run_id) as { maxSeq: number | null };
  const seq = (maxSeqRow.maxSeq ?? 0) + 1;

  const taskId = event.task_id ?? null;
  const attemptId = event.attempt_id ?? null;

  db.prepare(
    `INSERT INTO events (id, run_id, seq, task_id, attempt_id, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.id, event.run_id, seq, taskId, attemptId, event.type, event.payload, event.created_at);

  return {
    id: event.id,
    run_id: event.run_id,
    seq,
    task_id: taskId,
    attempt_id: attemptId,
    type: event.type,
    payload: event.payload,
    created_at: event.created_at,
  };
}

export function eventsJsonlPath(root: string, runId: string): string {
  return path.join(path.resolve(root), ".orga", "runs", runId, "events.jsonl");
}

// Every directory this function creates under .orga/ ends up mode 0o700; the
// jsonl file itself ends up mode 0o600.
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

// Appends one committed event as a JSON line. Callers must call this only
// after the transaction that produced `event` has committed: this module
// never mirrors from inside a transaction body, so a rolled-back transition
// never reaches events.jsonl.
export function mirrorEvent(root: string, event: EventRow): void {
  const resolvedRoot = path.resolve(root);
  const filePath = eventsJsonlPath(resolvedRoot, event.run_id);
  ensureSecureDir(path.join(resolvedRoot, ".orga"), path.dirname(filePath));

  const fileExisted = fs.existsSync(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  if (!fileExisted) {
    fs.chmodSync(filePath, 0o600);
  }
}
