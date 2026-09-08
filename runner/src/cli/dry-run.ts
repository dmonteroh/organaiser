// `orga run dry-run`: compiles the first-stage packet for every board task
// through P5c's compiler and writes each to disk, without ever creating an
// `attempts`/`workers` row and without spawning a supervisor or a worker.
//
// `startRun` (P5b) always both commits a run row AND spawns a detached
// supervisor in one call, with no split point that lets a caller take the
// first half only; its own board-shape validation is likewise internal, not
// exported. Dry-run duplicates the minimal slice of both (a board.schema.json
// check, a bare `runs` row insert) rather than reimplementing dispatch or
// scheduling.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import { openStore, withTransaction } from "../store/db.ts";
import { compilePacket, type PacketInput } from "../compile/packet.ts";
import { workflowAssetPath } from "../workflow-assets.ts";

export class DryRunBoardError extends Error {
  errors: Array<{ path: string; message: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "DryRunBoardError";
    this.errors = errors;
  }
}

interface BoardTask {
  id: string;
  title: string;
  briefPath?: string | null;
  entry: { workflowId: string; stageId: string };
  dependencies?: readonly string[];
  verification?: readonly string[];
}

interface Board {
  metadata: { id: string; contractVersion: string };
  spec: { tasks: readonly BoardTask[] };
}

function validateBoardShape(board: unknown): asserts board is Board {
  const schema = JSON.parse(fs.readFileSync(workflowAssetPath("schemas/board.schema.json"), "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(board)) {
    const errors = (validate.errors ?? []).map((error: ErrorObject) => ({
      path: error.instancePath,
      message: error.message ?? "invalid",
    }));
    const summary = errors
      .slice(0, 5)
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new DryRunBoardError(`board failed schema validation: ${summary}`, errors);
  }
}

function dryRunDir(root: string, runId: string): string {
  return path.join(path.resolve(root), ".orga", "runs", runId, "dry-run");
}

const RESULT_CONTRACT_NOTES = [
  "- resultSchema: stage-result.schema.json",
  "- status: one of completed | questions | failed",
].join("\n");

function packetInputFor(task: BoardTask, opts: { runId: string; root: string; templatePath: string }): PacketInput {
  return {
    protocolVersion: "1",
    runId: opts.runId,
    taskId: task.id,
    attemptId: "dry-run",
    workflowId: task.entry.workflowId,
    workflowVersion: "0.0.0",
    stageId: task.entry.stageId,
    roleId: "implementer",
    objective: task.title,
    workingDirectory: opts.root,
    authorityTier: "standard",
    toolPolicy: "default",
    commandLayerPolicy: "default",
    deliverableSchema: "stage-result.schema.json",
    roleFilePath: opts.templatePath,
    stageInputs: [
      {
        name: "task-brief",
        content: task.briefPath ?? task.title,
      },
    ],
    readFirst: [],
    allowedPaths: [],
    forbiddenPaths: [],
    fileClaims: [],
    nonFileClaims: [],
    acceptanceCriteria: "",
    verificationCommands: (task.verification ?? []).join("\n"),
    blockingRules: [],
    resultContractNotes: RESULT_CONTRACT_NOTES,
  };
}

export interface DryRunOptions {
  root: string;
  boardPath: string;
  board: unknown;
  templatePath: string;
  now?: () => number;
}

export interface DryRunResult {
  runId: string;
  packetPaths: readonly string[];
}

// Never inserts an `attempts` or `workers` row and never spawns a process:
// the only durable side effects are one `runs` row and the compiled packet
// files under `.orga/runs/<runId>/dry-run/`.
export function dryRun(options: DryRunOptions): DryRunResult {
  validateBoardShape(options.board);
  const board = options.board;

  const now = options.now ?? Date.now;
  const nowMs = now();
  const runId = randomUUID();
  const root = path.resolve(options.root);

  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO runs (id, board_path, desired_state, state, terminal_reason, config_snapshot_ref, created_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(runId, options.boardPath, "dry-run", "succeeded", "dry-run", null, nowMs, null, nowMs);
    });
  } finally {
    db.close();
  }

  const outDir = dryRunDir(root, runId);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outDir, 0o700);

  const packetPaths: string[] = [];
  for (const task of board.spec.tasks) {
    const packet = compilePacket(packetInputFor(task, { runId, root, templatePath: options.templatePath }));
    const packetPath = path.join(outDir, `${task.id}.packet.md`);
    fs.writeFileSync(packetPath, packet, { mode: 0o600 });
    packetPaths.push(packetPath);
  }

  return { runId, packetPaths };
}
