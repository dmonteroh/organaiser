// startRun: validates a board, snapshots the content hashes that produced
// this run, commits the run row, then spawns the detached supervisor that
// outlives the caller. This module never waits for run success: it returns
// as soon as the run row is durably committed and the supervisor has been
// launched.
//
// `board` arrives already parsed: this module validates its shape against
// board.schema.json but does not itself read or parse the board file's
// on-disk format. Parsing (the board file may be YAML, and no YAML parser is
// a dependency of this package) is the caller's concern — `orga run start`
// (P5f) — so this stays format-agnostic. `boardPath`, `workflowPath`, and
// `templatePath` are read as raw text purely to compute their content
// hashes; their contents are never interpreted here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import { openStore, withTransaction } from "../store/db.ts";
import { appendEvent, mirrorEvent } from "../store/events.ts";
import { sha256 } from "../store/evidence.ts";
import { workflowAssetPath } from "../workflow-assets.ts";
import { validateBoard as validateBoardSemantics } from "../board/validate.ts";
import type { Board } from "../board/schema.ts";
import type { DatabaseSync } from "node:sqlite";
import type { EventRow } from "../store/types.ts";

export class BoardValidationError extends Error {
  errors: Array<{ path: string; message: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "BoardValidationError";
    this.errors = errors;
  }
}

export class TaskIdCollisionError extends Error {
  taskIds: string[];
  constructor(taskIds: string[]) {
    super(
      `task ids already exist in this .orga store: ${taskIds.join(", ")}. Task ids must be unique across every run in one store; rename them in the board or use a fresh project root.`,
    );
    this.name = "TaskIdCollisionError";
    this.taskIds = taskIds;
  }
}

function loadBoardSchema(): object {
  const raw = fs.readFileSync(workflowAssetPath("schemas/board.schema.json"), "utf8");
  return JSON.parse(raw) as object;
}

function validateBoard(board: unknown): void {
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(loadBoardSchema());
  if (!validate(board)) {
    const errors = (validate.errors ?? []).map((error: ErrorObject) => ({
      path: error.instancePath,
      message: error.message ?? "invalid",
    }));
    const summary = errors
      .slice(0, 5)
      .map((error: { path: string; message: string }) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new BoardValidationError(`board failed schema validation: ${summary}`, errors);
  }
}

interface HashedSource {
  path: string;
  sha256: string;
}

function hashSource(root: string, absolutePath: string): HashedSource {
  const contents = fs.readFileSync(absolutePath, "utf8");
  const rel = path.relative(path.resolve(root), path.resolve(absolutePath));
  return { path: rel.split(path.sep).join("/"), sha256: sha256(contents) };
}

function supervisorEntryPath(): string {
  return fileURLToPath(new URL("./supervisor.ts", import.meta.url));
}

function runsDir(root: string, runId: string): string {
  return path.join(path.resolve(root), ".orga", "runs", runId);
}

function ensureSecureRunDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export interface StartRunOptions {
  root: string;
  boardPath: string;
  board: unknown;
  workflowPath: string;
  templatePath: string;
  now?: () => number;
  spawn?: boolean;
}

export interface StartRunResult {
  runId: string;
  supervisorPid: number | null;
  logPath: string | null;
}

export function startRun(options: StartRunOptions): StartRunResult {
  validateBoard(options.board);

  // Compiles board.schema.json a second time via loadAndValidateBoardShape,
  // in addition to the schema-only validateBoard call above: accepted
  // duplication, not a bug.
  const semantics = validateBoardSemantics(options.board);
  if (!semantics.valid) {
    const summary = semantics.errors
      .slice(0, 5)
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new BoardValidationError(`board failed semantic validation: ${summary}`, semantics.errors);
  }

  // Safe: both validateBoard (schema-only) and validateBoardSemantics above
  // (via loadAndValidateBoardShape, validate.ts:137-139) have already run
  // board.schema.json against this object.
  const shaped = options.board as Board;

  const now = options.now ?? Date.now;
  const nowMs = now();
  const runId = randomUUID();
  const root = path.resolve(options.root);

  const snapshot = {
    board: hashSource(root, path.resolve(options.boardPath)),
    workflow: hashSource(root, path.resolve(options.workflowPath)),
    template: hashSource(root, path.resolve(options.templatePath)),
  };

  const db: DatabaseSync = openStore(root);
  let createdEvent: EventRow;
  try {
    createdEvent = withTransaction(db, () => {
      const enabledTasks = shaped.spec.tasks.filter((task) => task.enabled !== false);
      const enabledIds = enabledTasks.map((task) => task.id);
      if (enabledIds.length > 0) {
        const placeholders = enabledIds.map(() => "?").join(", ");
        const collisions = db
          .prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`)
          .all(...enabledIds) as Array<{ id: string }>;
        if (collisions.length > 0) {
          throw new TaskIdCollisionError(collisions.map((row) => row.id).sort());
        }
      }

      db.prepare(
        `INSERT INTO runs (id, board_path, desired_state, state, terminal_reason, config_snapshot_ref, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        snapshot.board.path,
        "running",
        "starting",
        null,
        JSON.stringify(snapshot),
        nowMs,
        null,
        null,
      );

      for (const task of enabledTasks) {
        db.prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          runId,
          task.id,
          task.title,
          task.briefPath,
          task.entry.workflowId,
          null,
          JSON.stringify(task.dependencies),
          task.priority,
          "defined",
          null,
          nowMs,
          nowMs,
        );

        if (task.claims === "unknown") {
          // readClaimedPaths (scheduler.ts:408-419) parses "[]" to an empty
          // claimed set, so validateAttemptClaims (scheduler.ts:437-451)
          // would reject any real file write by a task seeded this way as
          // out-of-claim. Inert today only because
          // createProductionSchedulerTick passes undefined for the
          // workspace argument (scheduler.ts:1332 and 1373), so
          // validateAttemptClaims never runs. Whoever wires a real
          // WorkspaceProvider must give claims: "unknown" a genuinely
          // permissive representation at that time.
          db.prepare(
            `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), runId, task.id, "files", "[]", nowMs);
        } else {
          db.prepare(
            `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), runId, task.id, "files", JSON.stringify(task.claims.files ?? []), nowMs);

          if (task.claims.nonFile && task.claims.nonFile.length > 0) {
            db.prepare(
              `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(randomUUID(), runId, task.id, "nonFile", JSON.stringify(task.claims.nonFile), nowMs);
          }
        }
      }

      return appendEvent(db, {
        id: randomUUID(),
        run_id: runId,
        type: "run.created",
        payload: JSON.stringify({ snapshot }),
        created_at: nowMs,
      });
    });
    // mirrorEvent must run only after the transaction above has committed —
    // it is called here, outside withTransaction, for exactly that reason.
    mirrorEvent(root, createdEvent);
  } finally {
    db.close();
  }

  if (options.spawn === false) {
    return { runId, supervisorPid: null, logPath: null };
  }

  const runDir = runsDir(root, runId);
  ensureSecureRunDir(runDir);
  const logPath = path.join(runDir, "supervisor.log");
  const logFd = fs.openSync(logPath, "a", 0o600);

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [supervisorEntryPath(), root, runId], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: root,
    });
  } finally {
    fs.closeSync(logFd);
  }

  if (typeof child.pid !== "number") {
    throw new Error(`failed to spawn supervisor for run ${runId}: no pid`);
  }

  // Recorded synchronously, in the same turn spawn returns, before any await
  // or stream handler — mirrors process-supervisor.ts's recordProcess
  // ordering so nothing can observe the supervisor running before its pid is
  // durably recorded on disk.
  fs.writeFileSync(path.join(runDir, "supervisor.pid"), String(child.pid), { mode: 0o600 });

  child.unref();

  return { runId, supervisorPid: child.pid, logPath };
}
