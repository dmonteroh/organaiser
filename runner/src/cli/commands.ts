// The `orga` command surface: argument parsing, dispatch into P5a-P5e's
// exported libraries, and exit-code mapping (goals spec section 25). Every
// command body below is validation plus exactly one call into a sibling
// library plus a mapping through exit-codes.ts — this module makes no
// scheduling, dispatch, or termination decisions of its own.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { initProject } from "../store/init.ts";
import { openStore } from "../store/db.ts";
import { eventsJsonlPath } from "../store/events.ts";
import type { RunRow } from "../store/types.ts";
import { startRun, BoardValidationError } from "../engine/supervisor-spawn.ts";
import { checkInPlaceStart } from "../git/in-place.ts";
import {
  pauseRun,
  cancelRun,
  killRun,
  killAll,
  installForegroundInterruptHandler,
} from "../engine/control-commands.ts";
import { runSupervisor } from "../engine/supervisor.ts";
import { dryRun, DryRunBoardError } from "./dry-run.ts";
import { importMarkdown, ImportMarkdownError } from "../board/import-markdown.ts";
import { validateBoard } from "../board/validate.ts";
import { renderBoard } from "../board/render.ts";
import { listOpenQuestions, rawQuestionId, unblockAnsweredTasks } from "../engine/operator-questions.ts";
import { answerQuestions, UnknownQuestionKeyError } from "../engine/answer-questions.ts";
import { isSupervisorLive } from "../store/lease.ts";
import type { QuestionRow } from "../store/types.ts";
import { readYamlFile, type YamlMapping } from "./yaml.ts";
import { EXIT_CODES, runStateToExitCode, type ExitCode } from "./exit-codes.ts";
import loadConfig, { type ConfigSources, type ResolvedConfig } from "./config.ts";
import { cmdDoctor } from "./doctor.ts";

const SUPERVISOR_ENTRY_PATH = fileURLToPath(new URL("../engine/supervisor.ts", import.meta.url));
const DEFAULT_TEMPLATE_PATH = fileURLToPath(
  new URL("../../../workflows/subagents/implementer-prompt.md", import.meta.url),
);
const DEFAULT_WORKFLOW_PATH = fileURLToPath(
  new URL("../../../workflows/manifests/task-board.v1.yaml", import.meta.url),
);

const RUN_STATE_SET = new Set([
  "starting",
  "running",
  "waiting-operator",
  "blocked",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
  "paused",
]);

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: readonly [string, number, number]; cwd: string },
) => { pid: number | undefined; unref(): void };

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: () => string;
  now: () => number;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
}

export const processIo: Io = {
  stdout: (line: string) => process.stdout.write(`${line}\n`),
  stderr: (line: string) => process.stderr.write(`${line}\n`),
  cwd: () => process.cwd(),
  now: () => Date.now(),
  env: process.env,
};

class UsageError extends Error {}
class NotFoundError extends Error {}

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(args: readonly string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const value = args[i + 1];
        if (value === undefined) throw new UsageError(`--${name} requires a value`);
        flags.set(name, value);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`--${name} requires a value`);
  return value;
}

function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  return flags.get(name) === true;
}

function resolveRoot(io: Io): string {
  return io.cwd();
}

function readConfig(io: Io): ResolvedConfig {
  const sources: ConfigSources = { env: io.env };
  return loadConfig(sources);
}

function readBoardFile(boardPath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(boardPath, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read board file ${boardPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`board file ${boardPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readRun(root: string, runId: string): RunRow {
  const db = openStore(root);
  try {
    const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | undefined;
    if (!row) throw new NotFoundError(`no run ${runId}`);
    return row;
  } finally {
    db.close();
  }
}

function parseDurationMs(raw: string): number {
  const match = /^([0-9]+)(ms|s|m)?$/.exec(raw.trim());
  if (!match) throw new UsageError(`invalid --timeout: ${raw}`);
  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60000 : 1;
  return value * multiplier;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(io: Io, json: boolean, value: unknown, humanLine: string): void {
  io.stdout(json ? JSON.stringify(value) : humanLine);
}

// ── Command bodies ──────────────────────────────────────────────────────────

function cmdInit(parsed: ParsedArgs, io: Io): ExitCode {
  const root = resolveRoot(io);
  const result = initProject(root);
  emit(io, flagBool(parsed.flags, "json"), result, `initialized ${result.root} (created=${result.created})`);
  return EXIT_CODES.OK;
}

async function cmdRunStart(parsed: ParsedArgs, io: Io): Promise<ExitCode> {
  const boardPath = flagString(parsed.flags, "board");
  if (!boardPath) throw new UsageError("run start requires --board <path>");
  const root = resolveRoot(io);
  const workflowPath = flagString(parsed.flags, "workflow") ?? DEFAULT_WORKFLOW_PATH;
  const templatePath = flagString(parsed.flags, "template") ?? DEFAULT_TEMPLATE_PATH;
  const board = readBoardFile(boardPath);
  const json = flagBool(parsed.flags, "json");
  const foreground = flagBool(parsed.flags, "foreground");

  const config = readConfig(io);
  if (config.workspace.mode === "in-place") {
    checkInPlaceStart({ projectRoot: root, allowDirty: flagBool(parsed.flags, "allow-dirty") });
  }

  if (foreground) {
    return cmdRunStartForeground({ root, boardPath, board, workflowPath, templatePath, json, io });
  }

  let result;
  try {
    result = startRun({ root, boardPath, board, workflowPath, templatePath, now: io.now });
  } catch (err) {
    if (err instanceof BoardValidationError) throw new UsageError(err.message);
    throw err;
  }

  emit(io, json, result, `started run ${result.runId} (supervisor pid ${result.supervisorPid})`);
  return EXIT_CODES.OK;
}

interface ForegroundStartArgs {
  root: string;
  boardPath: string;
  board: unknown;
  workflowPath: string;
  templatePath: string;
  json: boolean;
  io: Io;
}

// `--foreground` commits the run with no detached supervisor (`spawn:
// false`), installs the interrupt handler in the same synchronous turn
// `startRun` returns, then runs the supervisor's own lease/reconcile/tick
// loop in this process. The `db` handle is shared with the interrupt
// handler for the whole command and closed exactly once, after the wait
// ends, so it stays open for as long as a signal could still arrive.
async function cmdRunStartForeground(args: ForegroundStartArgs): Promise<ExitCode> {
  const { root, boardPath, board, workflowPath, templatePath, json, io } = args;
  const db = openStore(root);
  let removeHandler: (() => void) | undefined;
  try {
    let result;
    try {
      result = startRun({ root, boardPath, board, workflowPath, templatePath, now: io.now, spawn: false });
    } catch (err) {
      if (err instanceof BoardValidationError) throw new UsageError(err.message);
      throw err;
    }

    removeHandler = installForegroundInterruptHandler({ db, runId: result.runId, now: io.now });

    const supervisorExitCode = await runSupervisor({ root, runId: result.runId });

    const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(result.runId) as RunRow | undefined;
    if (!run) throw new NotFoundError(`no run ${result.runId}`);
    emit(io, json, run, `run ${run.id}: reached ${run.state}`);

    if (supervisorExitCode === EXIT_CODES.STATE_CONFLICT) return EXIT_CODES.STATE_CONFLICT;
    return runStateToExitCode(run.state) ?? EXIT_CODES.OK;
  } finally {
    removeHandler?.();
    db.close();
  }
}

function cmdRunStatus(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run status requires <run-id>");
  const root = resolveRoot(io);
  const run = readRun(root, runId);

  const db = openStore(root);
  let rows: QuestionRow[];
  try {
    rows = listOpenQuestions(db, runId);
  } finally {
    db.close();
  }
  const groups = groupQuestionsByRawId(rows);

  const value = {
    ...run,
    pendingQuestionCount: groups.length,
    pendingQuestions: groups.map((group) => ({
      questionId: group.questionId,
      taskIds: group.taskIds,
      blocksRun: group.blocksRun,
      status: group.status,
      question: group.question,
    })),
  };

  emit(
    io,
    flagBool(parsed.flags, "json"),
    value,
    `run ${run.id}: state=${run.state} desired=${run.desired_state} pending-questions=${groups.length}`,
  );
  return EXIT_CODES.OK;
}

async function cmdRunWait(parsed: ParsedArgs, io: Io): Promise<ExitCode> {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run wait requires <run-id>");
  const untilRaw = flagString(parsed.flags, "until");
  if (!untilRaw) throw new UsageError("run wait requires --until <state-set>");
  const untilStates = untilRaw.split(",").map((s) => s.trim());
  for (const state of untilStates) {
    if (!RUN_STATE_SET.has(state)) throw new UsageError(`unknown state in --until: ${state}`);
  }
  const untilSet = new Set(untilStates);

  const root = resolveRoot(io);
  const config = readConfig(io);
  const timeoutRaw = flagString(parsed.flags, "timeout");
  const timeoutMs = timeoutRaw !== undefined ? parseDurationMs(timeoutRaw) : null;
  const pollMs = Math.max(10, Math.min(config.timing.tickIntervalMs, 200));
  const deadline = timeoutMs !== null ? io.now() + timeoutMs : null;
  const json = flagBool(parsed.flags, "json");

  for (;;) {
    const run = readRun(root, runId);
    if (untilSet.has(run.state)) {
      const code = runStateToExitCode(run.state) ?? EXIT_CODES.OK;
      emit(io, json, run, `run ${run.id}: reached ${run.state}`);
      return code;
    }
    if (deadline !== null && io.now() >= deadline) {
      emit(io, json, run, `run ${run.id}: wait timed out at state ${run.state}`);
      return EXIT_CODES.WAIT_TIMEOUT;
    }
    await sleep(pollMs);
  }
}

function cmdRunLogs(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run logs requires <run-id>");
  const root = resolveRoot(io);
  readRun(root, runId); // throws NotFoundError if absent
  const logPath = eventsJsonlPath(root, runId);
  const contents = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  if (flagBool(parsed.flags, "json")) {
    for (const line of contents.split("\n")) {
      if (line.trim().length > 0) io.stdout(line);
    }
  } else {
    io.stdout(contents.length > 0 ? contents.replace(/\n$/, "") : `(no events recorded for ${runId})`);
  }
  return EXIT_CODES.OK;
}

// Spawns `supervisor.ts` directly against an existing run id, mirroring what
// `startRun` itself does after its own insert — the new process makes its own
// lease-acquisition decision (acquireLease, P5a) and exits 4 on its own if a
// fresher lease is already held, per goals spec 25.3. `opts.spawn === false`
// mirrors `supervisor-spawn.ts`'s `startRun` escape hatch.
function spawnSupervisor(
  root: string,
  runId: string,
  opts?: { spawn?: boolean; spawnFn?: SpawnFn },
): { pid: number; logPath: string } | null {
  if (opts?.spawn === false) return null;

  const runDir = path.join(root, ".orga", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(runDir, "supervisor.log");
  const logFd = fs.openSync(logPath, "a", 0o600);
  let child;
  try {
    child = (opts?.spawnFn ?? spawn)(process.execPath, [SUPERVISOR_ENTRY_PATH, root, runId], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: root,
    });
  } finally {
    fs.closeSync(logFd);
  }
  if (typeof child.pid !== "number") throw new Error(`failed to spawn supervisor for run ${runId}: no pid`);
  fs.writeFileSync(path.join(runDir, "supervisor.pid"), String(child.pid), { mode: 0o600 });
  child.unref();

  return { pid: child.pid, logPath };
}

// `startRun` (P5b) always both commits a fresh run row and spawns the
// detached supervisor in one call; there is no exported primitive that
// resumes an existing run id without re-creating the run. Resume therefore
// spawns unconditionally via `spawnSupervisor`.
function cmdRunResume(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run resume requires <run-id>");
  const root = resolveRoot(io);
  readRun(root, runId); // throws NotFoundError if absent

  const spawned = spawnSupervisor(root, runId, { spawnFn: io.spawnFn });
  if (!spawned) throw new Error(`failed to spawn supervisor for run ${runId}: no pid`);

  emit(
    io,
    flagBool(parsed.flags, "json"),
    { runId, supervisorPid: spawned.pid, logPath: spawned.logPath },
    `resumed run ${runId} (supervisor pid ${spawned.pid})`,
  );
  return EXIT_CODES.OK;
}

function cmdRunPause(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run pause requires <run-id>");
  const root = resolveRoot(io);
  const db = openStore(root);
  let result;
  try {
    result = pauseRun(db, { runId, now: io.now, immediate: flagBool(parsed.flags, "now") });
  } catch (err) {
    if (err instanceof Error && /no run row/.test(err.message)) throw new NotFoundError(err.message);
    throw err;
  } finally {
    db.close();
  }
  emit(io, flagBool(parsed.flags, "json"), result, `pause requested for ${runId} (inserted=${result.inserted})`);
  return EXIT_CODES.OK;
}

function cmdRunCancel(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run cancel requires <run-id>");
  const root = resolveRoot(io);
  const db = openStore(root);
  let result;
  try {
    result = cancelRun(db, { runId, now: io.now, immediate: flagBool(parsed.flags, "now") });
  } catch (err) {
    if (err instanceof Error && /no run row/.test(err.message)) throw new NotFoundError(err.message);
    throw err;
  } finally {
    db.close();
  }
  emit(io, flagBool(parsed.flags, "json"), result, `cancel requested for ${runId} (inserted=${result.inserted})`);
  return EXIT_CODES.OK;
}

async function cmdRunKill(parsed: ParsedArgs, io: Io): Promise<ExitCode> {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run kill requires <run-id>");
  const root = resolveRoot(io);
  const config = readConfig(io);
  const db = openStore(root);
  let result;
  try {
    result = await killRun(db, { runId, now: io.now, graceMs: config.timing.cancelGraceMs });
  } catch (err) {
    if (err instanceof Error && /no run row/.test(err.message)) throw new NotFoundError(err.message);
    throw err;
  } finally {
    db.close();
  }
  emit(io, flagBool(parsed.flags, "json"), result, `killed run ${runId} (${result.workers.length} worker group(s))`);
  return EXIT_CODES.OK;
}

async function cmdKillAll(parsed: ParsedArgs, io: Io): Promise<ExitCode> {
  const root = resolveRoot(io);
  const config = readConfig(io);
  const db = openStore(root);
  let results;
  try {
    results = await killAll(db, { now: io.now, graceMs: config.timing.cancelGraceMs });
  } finally {
    db.close();
  }
  const summary = Object.fromEntries(results);
  emit(io, flagBool(parsed.flags, "json"), summary, `killed ${results.size} run(s)`);
  return EXIT_CODES.OK;
}

function cmdRunDryRun(parsed: ParsedArgs, io: Io): ExitCode {
  const boardPath = flagString(parsed.flags, "board");
  if (!boardPath) throw new UsageError("run dry-run requires --board <path>");
  const root = resolveRoot(io);
  const templatePath = flagString(parsed.flags, "template") ?? DEFAULT_TEMPLATE_PATH;
  const board = readBoardFile(boardPath);

  let result;
  try {
    result = dryRun({ root, boardPath, board, templatePath, now: io.now });
  } catch (err) {
    if (err instanceof DryRunBoardError) throw new UsageError(err.message);
    throw err;
  }
  emit(
    io,
    flagBool(parsed.flags, "json"),
    result,
    `dry-run ${result.runId}: compiled ${result.packetPaths.length} packet(s)`,
  );
  return EXIT_CODES.OK;
}

function cmdBoardImportMarkdown(parsed: ParsedArgs, io: Io): ExitCode {
  const inputPath = flagString(parsed.flags, "input");
  if (!inputPath) throw new UsageError("board import-markdown requires --input <path>");
  const outputPath = flagString(parsed.flags, "output");
  if (!outputPath) throw new UsageError("board import-markdown requires --output <path>");

  let raw: string;
  try {
    raw = fs.readFileSync(inputPath, "utf8");
  } catch (err) {
    throw new UsageError(`cannot read input file ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let result;
  try {
    result = importMarkdown(raw, outputPath);
  } catch (err) {
    if (err instanceof ImportMarkdownError) throw new UsageError(err.message);
    throw err;
  }

  fs.writeFileSync(outputPath, JSON.stringify(result.board, null, 2));

  for (const uncertainty of result.uncertainties) {
    io.stderr(uncertainty);
  }

  const json = flagBool(parsed.flags, "json");
  emit(
    io,
    json,
    { board: result.board, uncertainties: result.uncertainties },
    `imported ${result.board.spec.tasks.length} task(s) to ${outputPath}`,
  );
  return EXIT_CODES.OK;
}

function cmdBoardValidate(parsed: ParsedArgs, io: Io): ExitCode {
  const boardPath = flagString(parsed.flags, "board");
  if (!boardPath) throw new UsageError("board validate requires --board <path>");
  const board = readBoardFile(boardPath);
  const result = validateBoard(board);
  const json = flagBool(parsed.flags, "json");

  if (json) {
    io.stdout(JSON.stringify({ valid: result.valid, errors: result.errors }));
  } else {
    for (const error of result.errors) {
      io.stderr(`${error.path || "/"}: ${error.message}`);
    }
    io.stdout(
      result.valid
        ? `board ${boardPath} is valid`
        : `board ${boardPath} is invalid (${result.errors.length} error(s))`,
    );
  }

  return result.valid ? EXIT_CODES.OK : EXIT_CODES.INVALID_ARGS;
}

function cmdBoardRender(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("board render requires <run-id>");
  const root = resolveRoot(io);
  readRun(root, runId);
  const outputPath = flagString(parsed.flags, "output");

  const writtenPath = renderBoard(root, runId, outputPath);
  emit(
    io,
    flagBool(parsed.flags, "json"),
    { runId, path: writtenPath },
    `rendered board for run ${runId} to ${writtenPath}`,
  );
  return EXIT_CODES.OK;
}

interface QuestionGroup {
  questionId: string;
  taskIds: string[];
  blocksRun: boolean;
  status: string;
  prompt: string;
  safeDefault: string | null;
  question: unknown | null;
}

function groupQuestionsByRawId(rows: QuestionRow[]): QuestionGroup[] {
  const membersByRawId = new Map<string, QuestionRow[]>();
  for (const row of rows) {
    const key = rawQuestionId(row);
    const members = membersByRawId.get(key);
    if (members) members.push(row);
    else membersByRawId.set(key, [row]);
  }

  const ordered: Array<{ group: QuestionGroup; representative: QuestionRow }> = [];
  for (const [questionId, members] of membersByRawId) {
    const representative = members.reduce((best, row) =>
      row.created_at < best.created_at || (row.created_at === best.created_at && row.id < best.id) ? row : best,
    );
    const taskIds = Array.from(
      new Set(members.filter((row): row is QuestionRow & { task_id: string } => row.task_id !== null).map((row) => row.task_id)),
    ).sort();
    const blocksRun = members.some((row) => row.blocking_scope === "run");

    ordered.push({
      group: {
        questionId,
        taskIds,
        blocksRun,
        status: representative.status,
        prompt: representative.prompt,
        safeDefault: representative.safe_default,
        question: representative.payload !== null ? (JSON.parse(representative.payload) as unknown) : null,
      },
      representative,
    });
  }

  ordered.sort((a, b) => {
    if (a.representative.created_at !== b.representative.created_at) {
      return a.representative.created_at - b.representative.created_at;
    }
    return a.representative.id < b.representative.id ? -1 : a.representative.id > b.representative.id ? 1 : 0;
  });

  return ordered.map((entry) => entry.group);
}

function collapseNewlines(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

function blockedTasksCell(group: QuestionGroup): string {
  const taskPart = group.taskIds.join(", ");
  if (!group.blocksRun) return taskPart;
  return taskPart.length > 0 ? `(run), ${taskPart}` : "(run)";
}

function formatQuestionTable(groups: QuestionGroup[]): string[] {
  interface TableRow {
    id: string;
    question: string;
    defaultValue: string;
    blockedTasks: string;
  }

  const header: TableRow = { id: "id", question: "question", defaultValue: "default", blockedTasks: "blocked tasks" };
  const dataRows: TableRow[] = groups.map((group) => ({
    id: group.questionId,
    question: collapseNewlines(group.prompt),
    defaultValue: collapseNewlines(group.safeDefault ?? "(none)"),
    blockedTasks: blockedTasksCell(group),
  }));
  const allRows = [header, ...dataRows];

  const idWidth = Math.max(...allRows.map((row) => row.id.length));
  const questionWidth = Math.max(...allRows.map((row) => row.question.length));
  const defaultWidth = Math.max(...allRows.map((row) => row.defaultValue.length));
  const blockedTasksWidth = Math.max(...allRows.map((row) => row.blockedTasks.length));

  return allRows.map((row) =>
    [
      row.id.padEnd(idWidth),
      row.question.padEnd(questionWidth),
      row.defaultValue.padEnd(defaultWidth),
      row.blockedTasks.padEnd(blockedTasksWidth),
    ].join("  "),
  );
}

// `--json` emits exactly one JSON value on stdout:
//   {"runId": "<run-id>", "questions": [{"rowId": "...", "taskId": "<task row id>" | null,
//     "blockingScope": "task" | "run", "status": "open", "question": <verbatim open-question object, or null>}]}
// `question` is the row's `payload` column parsed back to an object; a row seeded before
// migration 4 (no `payload`) emits `question: null`.
function cmdRunQuestions(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run questions requires <run-id>");
  const root = resolveRoot(io);
  readRun(root, runId);

  const db = openStore(root);
  let rows: QuestionRow[];
  try {
    rows = listOpenQuestions(db, runId);
  } finally {
    db.close();
  }

  if (flagBool(parsed.flags, "json")) {
    io.stdout(
      JSON.stringify({
        runId,
        questions: rows.map((row) => ({
          rowId: row.id,
          taskId: row.task_id,
          blockingScope: row.blocking_scope,
          status: row.status,
          question: row.payload !== null ? (JSON.parse(row.payload) as unknown) : null,
        })),
      }),
    );
  } else if (rows.length === 0) {
    io.stdout("no open questions");
  } else {
    for (const line of formatQuestionTable(groupQuestionsByRawId(rows))) io.stdout(line);
  }

  return EXIT_CODES.OK;
}

function readAnswersFile(answersPath: string): Map<string, string> {
  let parsed: YamlMapping;
  try {
    parsed = readYamlFile(answersPath);
  } catch (err) {
    throw new UsageError(
      `cannot read answers file ${answersPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const topLevelKeys = Object.keys(parsed);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== "answers") {
    throw new UsageError(`answers file ${answersPath} must have exactly one top-level key: "answers"`);
  }

  const answersValue = parsed.answers;
  if (answersValue === null || typeof answersValue !== "object" || Array.isArray(answersValue)) {
    throw new UsageError(`answers file ${answersPath}: "answers" must be a mapping of question id to answer string`);
  }

  const answers = new Map<string, string>();
  for (const [key, value] of Object.entries(answersValue)) {
    if (key.length === 0) {
      throw new UsageError(`answers file ${answersPath}: empty question id key is not allowed`);
    }
    if (typeof value !== "string") {
      throw new UsageError(`answers file ${answersPath}: answer for "${key}" must be a string`);
    }
    answers.set(key, value);
  }
  return answers;
}

// `--json` emits exactly one JSON value on stdout:
//   {"runId": "<run-id>", "answered": [{"questionId": "...", "rowIds": ["..."],
//     "artifact": {"path": "...", "sha256": "..."}}], "unblockedTaskIds": ["..."],
//     "reopenedTasks": [{"taskId": "...", "questionIds": ["..."]}],
//     "skippedTasks": [{"taskId": "...", "latestAttemptStageId": "..."}],
//     "supervisorPid": <number-or-null>}
// `answered` lists only keys that had at least one `open` row in this invocation; a key whose
// matching rows were already all non-`open` is a no-op and absent from it. `reopenedTasks` and
// `skippedTasks` report the same-invocation `unblockAnsweredTasks` call. `supervisorPid` is the
// pid of a supervisor spawned by this invocation, or `null` when one was already live or
// `--no-supervisor` was passed.
function cmdRunAnswer(parsed: ParsedArgs, io: Io): ExitCode {
  const runId = parsed.positionals[0];
  if (!runId) throw new UsageError("run answer requires <run-id>");
  const answersPath = flagString(parsed.flags, "file");
  if (!answersPath) throw new UsageError("run answer requires --file <path>");
  const root = resolveRoot(io);
  readRun(root, runId);

  const answers = readAnswersFile(answersPath);
  const now = io.now();
  const config = readConfig(io);
  const noSupervisor = flagBool(parsed.flags, "no-supervisor");

  const db = openStore(root);
  let result;
  let unblockResult;
  let live: boolean | undefined;
  try {
    result = answerQuestions(db, { root, runId, answers }, now);
    if (!noSupervisor) {
      live = isSupervisorLive(db, { runId, tickIntervalMs: config.timing.tickIntervalMs, now: io.now });
    }
    unblockResult = unblockAnsweredTasks(db, { runId, now });
  } catch (err) {
    if (err instanceof UnknownQuestionKeyError) throw new NotFoundError(err.message);
    throw err;
  } finally {
    db.close();
  }

  let supervisorPid: number | null = null;
  if (!noSupervisor && live === false) {
    const spawned = spawnSupervisor(root, runId, { spawnFn: io.spawnFn });
    supervisorPid = spawned?.pid ?? null;
  }

  if (flagBool(parsed.flags, "json")) {
    io.stdout(
      JSON.stringify({
        runId,
        answered: result.answered,
        unblockedTaskIds: result.unblockedTaskIds,
        reopenedTasks: unblockResult.unblocked,
        skippedTasks: unblockResult.skipped,
        supervisorPid,
      }),
    );
  } else {
    for (const entry of result.answered) io.stdout(`answered ${entry.questionId}`);
    if (result.unblockedTaskIds.length > 0) {
      io.stdout(`tasks with no open blocking question: ${result.unblockedTaskIds.join(", ")}`);
    }
    if (unblockResult.unblocked.length > 0) {
      io.stdout(`reopened for implementation: ${unblockResult.unblocked.map((entry) => entry.taskId).join(", ")}`);
    }
    if (unblockResult.skipped.length > 0) {
      io.stdout(
        `skipped un-terminal (guard): ${unblockResult.skipped
          .map((entry) => `${entry.taskId} (latest stage ${entry.latestAttemptStageId})`)
          .join(", ")}`,
      );
    }
    if (live !== undefined) {
      io.stdout(live ? "supervisor already live" : `started supervisor pid ${supervisorPid}`);
    }
  }

  return EXIT_CODES.OK;
}

// ── Dispatch table ───────────────────────────────────────────────────────────

const VALUE_FLAGS = new Set([
  "board",
  "workflow",
  "template",
  "until",
  "timeout",
  "vendor",
  "input",
  "output",
  "file",
]);

type CommandBody = (parsed: ParsedArgs, io: Io) => ExitCode | Promise<ExitCode>;

const COMMANDS: Readonly<Record<string, CommandBody>> = {
  init: cmdInit,
  doctor: cmdDoctor,
  "run start": cmdRunStart,
  "run status": cmdRunStatus,
  "run wait": cmdRunWait,
  "run logs": cmdRunLogs,
  "run resume": cmdRunResume,
  "run pause": cmdRunPause,
  "run cancel": cmdRunCancel,
  "run kill": cmdRunKill,
  "kill-all": cmdKillAll,
  "run dry-run": cmdRunDryRun,
  "board import-markdown": cmdBoardImportMarkdown,
  "board validate": cmdBoardValidate,
  "board render": cmdBoardRender,
  "run questions": cmdRunQuestions,
  "run answer": cmdRunAnswer,
};

const COMMAND_PATHS = Object.keys(COMMANDS).sort((a, b) => b.split(" ").length - a.split(" ").length);

function matchCommandPath(args: readonly string[]): { path: string; rest: string[] } | null {
  for (const commandPath of COMMAND_PATHS) {
    const parts = commandPath.split(" ");
    if (parts.every((part, i) => args[i] === part)) {
      return { path: commandPath, rest: args.slice(parts.length) };
    }
  }
  return null;
}

export async function runCommand(argv: readonly string[], io: Io = processIo): Promise<ExitCode> {
  const matched = matchCommandPath(argv);
  if (!matched) {
    io.stderr(`usage: orga <${COMMAND_PATHS.join("|")}> [...args]`);
    return EXIT_CODES.INVALID_ARGS;
  }

  try {
    const parsed = parseArgs(matched.rest, VALUE_FLAGS);
    const body = COMMANDS[matched.path] as CommandBody;
    return await body(parsed, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}`);
      return EXIT_CODES.INVALID_ARGS;
    }
    if (err instanceof NotFoundError) {
      io.stderr(`error: ${err.message}`);
      return EXIT_CODES.NOT_FOUND;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT_CODES.STATE_CONFLICT;
  }
}

// Pure `argv -> exit code` entry point, mirroring `bin/orga.ts`'s existing
// shape. Async command bodies (`run wait`, `run kill`, `kill-all`) are
// resolved synchronously by the top-level bin wrapper, which is the process's
// only await boundary — this function itself always returns a Promise so
// every command, sync or async, has one calling convention.
export async function main(argv: readonly string[], io: Io = processIo): Promise<ExitCode> {
  return runCommand(argv.slice(2), io);
}
