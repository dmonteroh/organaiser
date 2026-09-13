// Shared scaffolding for the ten Stage A fixtures: one temporary-project
// helper, one board/run seeding helper, and one spawner for a
// fully-configurable "test supervisor" process (test-supervisor.ts) so each
// fixture can pick its own tick interval, operator-poll window, cancel
// grace, and fake-adapter stream directory without waiting on this phase's
// real-world defaults (1s ticks, 5-minute operator windows).
//
// Every fixture that spawns a real process group must record every pgid it
// creates and hard-kill it in a `finally`, even on assertion failure — no
// fixture here is exempt, and `killEverything` is the one function that does
// it so no fixture reimplements process cleanup on its own.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { openStore, withTransaction } from "../../src/store/db.ts";

export { openStore, withTransaction };
import { initProject } from "../../src/store/init.ts";
import { startRun } from "../../src/engine/supervisor-spawn.ts";

export const TEST_SUPERVISOR_PATH = fileURLToPath(new URL("./test-supervisor.ts", import.meta.url));
export const FIXTURE_STREAMS_ROOT = fileURLToPath(new URL("./streams/", import.meta.url));

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

export function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 15): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (predicate() || Date.now() > deadline) {
        clearInterval(tick);
        resolve(predicate());
      }
    }, pollMs);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A registry of every process group this fixture run has created. Every
// fixture pushes to this as soon as a pgid is known (synchronously, before
// any await) and tears every one of them down in a `finally`, regardless of
// which assertion — if any — threw.
export class ProcessRegistry {
  private readonly pgids = new Set<number>();

  track(pgid: number | undefined | null): void {
    if (typeof pgid === "number" && Number.isInteger(pgid) && pgid > 0) this.pgids.add(pgid);
  }

  recorded(): readonly number[] {
    return [...this.pgids];
  }

  killAll(): void {
    for (const pgid of this.pgids) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }

  async allDead(timeoutMs = 2000): Promise<boolean> {
    return waitFor(() => this.recorded().every((pgid) => !groupAlive(pgid)), timeoutMs);
  }
}

export async function withFixtureWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = process.env.ORGA_TEST_WORKSPACE ?? os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, "orga-fixture-")));
  recordCaptureWorkspace(dir);
  try {
    return await fn(dir);
  } finally {
    try {
      captureBeforeTeardown(dir, captureContext.getStore()?.runId);
    } catch {
      // capture is best-effort and must never mask the fixture's own outcome
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Eval capture-context side channel (P9f-b).
//
// A purely additive `AsyncLocalStorage`-backed side channel that lets a caller
// *outside* the awaited fixture call (the eval cell-runner, `evals/cell-runner.ts`)
// observe facts a fixture's own `(): Promise<void>` signature never exposes: the
// workspace root `withFixtureWorkspace` creates and deletes internally, and the run id
// `startFixtureRun`/`startGitFixtureRun` obtain from `startRun`. None of the ~40
// existing fixtures, and nothing in `test/fixtures.test.ts`, ever opens a context via
// `captureContext.run(...)`, so `recordCaptureWorkspace`/`recordCaptureRunId`/
// `captureBeforeTeardown` are no-ops for every existing call site: `getStore()` returns
// `undefined` and each function returns immediately. This is the one change to this
// file P9f-b's brief calls for; see that task's Implementation Constraint C2.
export interface CaptureBoardSnapshot {
  run: Record<string, unknown> | undefined;
  tasks: Record<string, unknown>[];
}

export interface CaptureGitBoardSnapshot {
  gitHead: string | null;
  gitStatus: string | null;
  board: CaptureBoardSnapshot | null;
  recordedPgids: number[];
  events: Record<string, unknown>[];
}

export interface CaptureStreamFile {
  name: string;
  text: string;
}

export interface CaptureContextStore {
  workspaceDir?: string;
  runId?: string;
  before?: CaptureGitBoardSnapshot;
  after?: CaptureGitBoardSnapshot;
  /**
   * `git diff <before.gitHead>`, computed inside `captureBeforeTeardown` while `dir`
   * still exists (before the adjacent `fs.rmSync` in `withFixtureWorkspace`'s
   * `finally`) — see that function's own comment for why this cannot be deferred to
   * `evals/cell-runner.ts`. `undefined` until `captureBeforeTeardown` runs; `null`
   * thereafter when there was no "before" head or the `git diff` invocation itself
   * failed.
   */
  gitDiff?: string | null;
  /**
   * The workspace's commit-parent graph (`git log --format=%H %P --all`, capped) plus
   * ref tips (`git show-ref`), computed inside `captureBeforeTeardown` alongside
   * `gitDiff` — same "must run while `dir` still exists" constraint. `undefined` until
   * `captureBeforeTeardown` runs; `null` thereafter for a non-git workspace or a failing
   * git invocation.
   */
  commitGraph?: string | null;
  streamFiles?: CaptureStreamFile[];
  workerReports?: unknown[];
}

/**
 * Exported so `evals/cell-runner.ts` can open a context with
 * `captureContext.run({}, () => fixtureFn())` around a Single/Sequence invocation and
 * read back the populated store once the call settles. Left un-opened (the default,
 * every existing call site's state) for Parametrized-factory/Whole-test-file/Live cells,
 * whose capture scope is negative per that task's C3/C9 — the three hook functions below
 * simply do nothing in that case, not because the engine special-cases them, but because
 * `getStore()` finds nothing to record into.
 */
export const captureContext = new AsyncLocalStorage<CaptureContextStore>();

function tryGitCapture(dir: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// Must run while `dir` still exists — see `CaptureContextStore.gitDiff`'s doc comment.
// A prior version of this computation lived in `evals/cell-runner.ts`, run against
// `ctx.workspaceDir` *after* `runSingleInvocation`/`runSequenceInvocation` returned;
// by then `withFixtureWorkspace`'s `finally` block (this same function's caller,
// `captureBeforeTeardown`, plus the adjacent `fs.rmSync`) had already deleted `dir`, so
// `git diff` always ran against a nonexistent cwd, threw ENOENT, and was silently
// swallowed by the `catch` below — `git.diff` on every `CapturedCellRecord` was `null`,
// even for fixtures (e.g. `secret-redaction`) that make real commits. Moving the call
// here, before `fs.rmSync`, is the fix.
function gitDiffSince(dir: string, headBefore: string | null): string | null {
  if (headBefore === null) return null;
  try {
    return execFileSync("git", ["diff", headBefore], { cwd: dir, encoding: "utf8" });
  } catch {
    return null;
  }
}

const COMMIT_GRAPH_MAX_COUNT = 500;

// Ref tips and commit-parent lines each come from their own `tryGitCapture` call, never
// a shared `try`/`catch`: on an empty-but-real repo (unborn HEAD, no commits) `git
// show-ref` exits 1 while `git log --all` exits 0, and a shared catch would discard a
// valid commit-graph capture because the sibling ref capture failed.
function commitGraphSnapshot(dir: string): string | null {
  if (!fs.existsSync(path.join(dir, ".git"))) return null;

  const log = tryGitCapture(dir, [
    "log",
    "--format=%H %P",
    "--all",
    `--max-count=${COMMIT_GRAPH_MAX_COUNT + 1}`,
  ]);
  if (log === null) return null;
  const refs = tryGitCapture(dir, ["show-ref"]);

  const logLines = log === "" ? [] : log.split("\n");
  const truncated = logLines.length > COMMIT_GRAPH_MAX_COUNT;
  const commitLines = logLines.slice(0, COMMIT_GRAPH_MAX_COUNT).map((line) => line.trimEnd());
  const refLines = refs === null || refs === "" ? [] : refs.split("\n");

  const lines = [
    "REFS:",
    ...refLines,
    "COMMITS:",
    ...commitLines,
    ...(truncated ? [`TRUNCATED: ${COMMIT_GRAPH_MAX_COUNT}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

function snapshotGitAndBoard(dir: string, runId: string | undefined): CaptureGitBoardSnapshot {
  const isGitRepo = fs.existsSync(path.join(dir, ".git"));
  const gitHead = isGitRepo ? tryGitCapture(dir, ["rev-parse", "HEAD"]) : null;
  const gitStatus = isGitRepo ? tryGitCapture(dir, ["status", "--porcelain"]) : null;

  let board: CaptureBoardSnapshot | null = null;
  let recordedPgids: number[] = [];
  let events: Record<string, unknown>[] = [];
  if (runId !== undefined) {
    try {
      const run = readRunRow(dir, runId);
      const tasks = allRows<Record<string, unknown>>(
        dir,
        "SELECT * FROM tasks WHERE run_id = ? ORDER BY id ASC",
        runId,
      );
      board = { run, tasks };
    } catch {
      board = null;
    }
    try {
      recordedPgids = recordedPgidsForRun(dir, runId);
    } catch {
      recordedPgids = [];
    }
    try {
      events = allRows<Record<string, unknown>>(
        dir,
        "SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC",
        runId,
      );
    } catch {
      events = [];
    }
  }

  return { gitHead, gitStatus, board, recordedPgids, events };
}

function collectStreamFiles(dir: string): CaptureStreamFile[] {
  const streamsDir = path.join(dir, "streams");
  if (!fs.existsSync(streamsDir)) return [];
  const files: CaptureStreamFile[] = [];
  for (const name of fs.readdirSync(streamsDir)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      files.push({ name, text: fs.readFileSync(path.join(streamsDir, name), "utf8") });
    } catch {
      // best-effort: an unreadable stream file is dropped, not fatal
    }
  }
  return files;
}

// The scripted wire format `reportLine` (below) writes is the only place a fixture's
// "worker report" content exists anywhere durably reachable post hoc — production
// itself never persists a validated report to disk or a store column (`attempts` has a
// `report_ref` column, but nothing in `src/engine/scheduler.ts` ever writes it). Reading
// it back out of the same scripted files this fixture suite already writes is not new
// capture logic; it is the fixture's own known input replayed back.
function extractWorkerReports(files: readonly CaptureStreamFile[]): unknown[] {
  const reports: unknown[] = [];
  for (const file of files) {
    for (const line of file.text.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as { op?: unknown }).op === "report" &&
        "report" in (parsed as Record<string, unknown>)
      ) {
        reports.push((parsed as { report: unknown }).report);
      }
    }
  }
  return reports;
}

/** Called inside `withFixtureWorkspace` immediately after `mkdtempSync`/`realpathSync`. */
export function recordCaptureWorkspace(dir: string): void {
  const store = captureContext.getStore();
  if (!store) return;
  store.workspaceDir = dir;
}

/**
 * Called inside `startFixtureRun` immediately after `startRun` returns.
 * `startGitFixtureRun` needs no separate call: it delegates to `startFixtureRun`, which
 * already fires this hook (see that function below).
 */
export function recordCaptureRunId(runId: string): void {
  const store = captureContext.getStore();
  if (!store) return;
  store.runId = runId;
  // The earliest point at which a meaningful "before" snapshot exists: the run row is
  // committed and the board/workflow/template files are on disk, but no task has been
  // seeded or dispatched yet (`startFixtureRun` never inserts `tasks` rows itself).
  if (store.workspaceDir !== undefined && store.before === undefined) {
    store.before = snapshotGitAndBoard(store.workspaceDir, runId);
  }
}

/**
 * Called inside `withFixtureWorkspace`'s `finally`, immediately before the existing
 * `fs.rmSync` — the one point at which the workspace directory is guaranteed to still
 * exist and the run id (if any) is already known via the store `recordCaptureRunId`
 * populated. Snapshots git/board "after" state, the `git diff` since the "before" head
 * (see `CaptureContextStore.gitDiff`), and the fixture's own scripted stream files (the
 * sanctioned source for vendor stdout and worker-report evidence per that task's C2/C3)
 * while all three are still readable/computable.
 */
export function captureBeforeTeardown(dir: string, runId: string | undefined): void {
  const store = captureContext.getStore();
  if (!store) return;
  store.after = snapshotGitAndBoard(dir, runId ?? store.runId);
  store.gitDiff = gitDiffSince(dir, store.before?.gitHead ?? null);
  store.commitGraph = commitGraphSnapshot(dir);
  store.streamFiles = collectStreamFiles(dir);
  store.workerReports = extractWorkerReports(store.streamFiles);
}

export interface FixtureTaskSpec {
  id: string;
  title?: string;
  dependsOn?: readonly string[];
  briefPath?: string;
  priority?: number;
  claimedPaths?: readonly string[];
}

export function boardWithTasks(tasks: readonly FixtureTaskSpec[]): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "fixture-board", contractVersion: "v1" },
    spec: {
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title ?? task.id,
        briefPath: task.briefPath ?? "brief.md",
        entry: { workflowId: "dev-workflow", stageId: "implementation" },
        dependencies: task.dependsOn ?? [],
        priority: task.priority ?? 0,
        requiredWorkflowVersions: {},
        claims: "unknown",
        verification: [],
        enabled: false,
      })),
    },
  };
}

export function writeFixtureFiles(dir: string, tasks: readonly FixtureTaskSpec[]): { boardPath: string; workflowPath: string; templatePath: string } {
  const boardPath = path.join(dir, "board.json");
  const workflowPath = path.join(dir, "workflow.md");
  const templatePath = path.join(dir, "template.md");
  fs.writeFileSync(boardPath, JSON.stringify(boardWithTasks(tasks), null, 2));
  fs.writeFileSync(workflowPath, "# workflow\n");
  fs.writeFileSync(templatePath, "# template\n");
  for (const task of tasks) {
    fs.writeFileSync(path.join(dir, task.briefPath ?? "brief.md"), `# brief for ${task.id}\n`);
  }
  return { boardPath, workflowPath, templatePath };
}

// `startRun` (P5a/P5b) commits the `runs` row and spawns a real detached
// supervisor from its own fixed production wiring; this fixture suite always
// kills that first supervisor immediately (it never dispatches anything
// useful for a fixture — see the harness module comment on `test-supervisor`)
// and spawns its own configurable one instead. `boardWithTasks` declares
// every task `enabled: false` deliberately: fixtures seed the `tasks` table
// themselves, at stages the real admission pipeline would not yet produce,
// so every fixture that needs the scheduler to see real tasks seeds them
// directly, exactly as P5b/P5e's own tests already do
// (`seedWaitingOperatorTask` in supervisor-detach.test.ts).
export function startFixtureRun(dir: string, tasks: readonly FixtureTaskSpec[]): { runId: string; firstSupervisorPid: number } {
  initProject(dir);
  const { boardPath, workflowPath, templatePath } = writeFixtureFiles(dir, tasks);
  const board = boardWithTasks(tasks);
  const result = startRun({ root: dir, boardPath, board, workflowPath, templatePath });
  if (result.supervisorPid === null) throw new Error("startFixtureRun: spawn defaults to true, but no pid came back");
  recordCaptureRunId(result.runId);
  try {
    process.kill(-result.supervisorPid, "SIGKILL");
  } catch {
    // best effort
  }
  return { runId: result.runId, firstSupervisorPid: result.supervisorPid };
}

export function seedTasks(root: string, runId: string, tasks: readonly FixtureTaskSpec[], now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      for (const task of tasks) {
        db.prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          runId,
          task.id,
          task.title ?? task.id,
          task.briefPath ?? "brief.md",
          "dev-workflow",
          null,
          JSON.stringify(task.dependsOn ?? []),
          task.priority ?? 0,
          "defined",
          null,
          now,
          now,
        );
        if (task.claimedPaths !== undefined) {
          db.prepare(
            `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(randomUUID(), runId, task.id, "files", JSON.stringify(task.claimedPaths), now);
        }
      }
    });
  } finally {
    db.close();
  }
}

function isLockedError(err: unknown): boolean {
  return err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message);
}

// These read helpers each open and close a fresh connection per call, polled
// frequently (every 15-100ms) by fixtures racing real, concurrently-writing
// supervisor/worker processes. `db.ts` already sets a 5-second busy_timeout,
// but that pragma is itself set only after the connection's own initial
// `PRAGMA journal_mode = WAL` succeeds — a poll that lands exactly as another
// connection holds the file for that first pragma can still observe
// "database is locked" before busy_timeout ever applies. A short synchronous
// retry here (not a change to `db.ts`, which is P5a-owned) absorbs that one
// narrow race; it is not a substitute for `db.ts`'s own timeout.
function withLockRetry<T>(fn: () => T): T {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      return fn();
    } catch (err) {
      if (!isLockedError(err) || Date.now() >= deadline) throw err;
    }
  }
}

export function readRunRow(root: string, runId: string): Record<string, unknown> {
  return withLockRetry(() => {
    const db = openStore(root);
    try {
      return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown>;
    } finally {
      db.close();
    }
  });
}

export function readTaskRow(root: string, taskId: string): Record<string, unknown> | undefined {
  return withLockRetry(() => {
    const db = openStore(root);
    try {
      return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
  });
}

type SqlParam = string | number | bigint | null;

export function countRows(root: string, sql: string, ...params: SqlParam[]): number {
  return withLockRetry(() => {
    const db = openStore(root);
    try {
      const row = db.prepare(sql).get(...params) as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  });
}

export function allRows<T = Record<string, unknown>>(root: string, sql: string, ...params: SqlParam[]): T[] {
  return withLockRetry(() => {
    const db = openStore(root);
    try {
      return db.prepare(sql).all(...params) as unknown as T[];
    } finally {
      db.close();
    }
  });
}

export function recordedPgidsForRun(root: string, runId: string): number[] {
  const rows = allRows<{ pgid: number }>(root, `SELECT DISTINCT pgid FROM workers WHERE run_id = ?`, runId);
  return rows.map((row) => row.pgid);
}

export interface SpawnSupervisorOptions {
  tickIntervalMs?: number;
  operatorPollWindowMs?: number;
  cancelGraceMs?: number;
  streamsDir: string;
  logPath?: string;
  workspaceMode?: "none" | "worktree" | "in-place";
}

export interface SpawnedSupervisor {
  child: ChildProcess;
  pid: number;
  logPath: string;
}

// Spawns the fixture suite's own configurable supervisor process
// (test-supervisor.ts) against an existing run id: real detached process,
// real lease acquisition (P5a's `acquireLease`), real tick shell (P5b's
// `runTickShell`), and a real `createSchedulerTick` (P5d) over a `FakeAdapter`
// (P5c) whose scenario is keyed by task id against the caller-supplied
// streams directory.
export function spawnFixtureSupervisor(root: string, runId: string, opts: SpawnSupervisorOptions): SpawnedSupervisor {
  const args = [
    TEST_SUPERVISOR_PATH,
    root,
    runId,
    String(opts.tickIntervalMs ?? 50),
    String(opts.operatorPollWindowMs ?? 400),
    String(opts.cancelGraceMs ?? 150),
    opts.streamsDir,
    String(opts.workspaceMode ?? "none"),
  ];
  const logPath = opts.logPath ?? path.join(root, `.orga/runs/${runId}/test-supervisor-${randomUUID()}.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", logFd, logFd] });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  if (typeof child.pid !== "number") throw new Error("failed to spawn test supervisor: no pid");
  return { child, pid: child.pid, logPath };
}

export function reportLine(overrides: Record<string, unknown>): string {
  const base = {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: "run_test",
    taskId: "task_test",
    attemptId: "attempt_test",
    stageId: "implementation",
    roleId: "implementer",
    status: "completed",
    summary: "did the work",
  };
  return JSON.stringify({ op: "report", report: { ...base, ...overrides } });
}

export function writeStream(streamsDir: string, stageId: string, scenario: string, lines: readonly string[]): void {
  fs.mkdirSync(streamsDir, { recursive: true });
  fs.writeFileSync(path.join(streamsDir, `${stageId}--${scenario}.jsonl`), `${lines.join("\n")}\n`);
}

export function outputLine(text: string): string {
  return JSON.stringify({ op: "output", text });
}

export function exitLine(code: number): string {
  return JSON.stringify({ op: "exit", code });
}

export function trapSigtermLine(): string {
  return JSON.stringify({ op: "trap-sigterm" });
}

export function sleepLine(ms: number): string {
  return JSON.stringify({ op: "sleep", ms });
}

export function writeFileLine(relPath: string, text: string): string {
  return JSON.stringify({ op: "write-file", path: relPath, text });
}

// A well-formed implementer/integrator stream: reports success immediately.
export function wellFormedStream(overrides: Record<string, unknown> = {}): string[] {
  return [outputLine("working"), reportLine(overrides), exitLine(0)];
}

function gitCapture(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// The invariant every later P7 fixture that dispatches into a runner-owned
// worktree wraps its run in: the operator's own checkout — the project root
// the supervisor was launched against, not any worktree under it — must show
// an identical `HEAD` and an identical `git status --porcelain` before and
// after `fn` runs, regardless of what `fn` does inside worktrees or the
// store. Never mutates the checkout itself.
export async function assertOperatorCheckoutUnchanged<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const headBefore = gitCapture(projectRoot, ["rev-parse", "HEAD"]);
  const statusBefore = gitCapture(projectRoot, ["status", "--porcelain"]);

  const result = await fn();

  const headAfter = gitCapture(projectRoot, ["rev-parse", "HEAD"]);
  const statusAfter = gitCapture(projectRoot, ["status", "--porcelain"]);

  assert.equal(headAfter, headBefore, `operator checkout HEAD changed: before=${headBefore} after=${headAfter}`);
  assert.equal(
    statusAfter,
    statusBefore,
    `operator checkout working tree changed: before=${JSON.stringify(statusBefore)} after=${JSON.stringify(statusAfter)}`,
  );

  return result;
}

export class GitFixtureIgnoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitFixtureIgnoreError";
  }
}

function orgaDirIgnoredInExclude(dir: string): boolean {
  const excludePath = path.join(dir, ".git", "info", "exclude");
  if (!fs.existsSync(excludePath)) return false;
  const lines = fs.readFileSync(excludePath, "utf8").split("\n").map((line) => line.trim());
  return lines.includes(".orga/");
}

function orgaDirCheckIgnored(dir: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", ".orga/"], { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A Git-project variant of `startFixtureRun` for the fixtures that dispatch
// into a runner-owned worktree: `git init`, a seed commit so `HEAD`
// resolves, then `initProject` (which only writes the `.git/info/exclude`
// entry when `.git` already exists), then a commit of the tracked tree
// `initProject` writes. Asserts both `.orga/` ignore registrations landed —
// nothing in `git worktree add` itself refuses to create a worktree under an
// unignored `.orga/`, and an unignored `.orga/` is invisible to
// `assertOperatorCheckoutUnchanged`'s two-snapshot diff — before handing off
// to the same board/run seeding `startFixtureRun` uses.
export function startGitFixtureRun(dir: string, tasks: readonly FixtureTaskSpec[]): { runId: string; firstSupervisorPid: number } {
  gitCapture(dir, ["init", "-q"]);
  gitCapture(dir, ["config", "commit.gpgsign", "false"]);
  gitCapture(dir, ["config", "user.name", "Fixture Operator"]);
  gitCapture(dir, ["config", "user.email", "fixture-operator@example.com"]);

  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n", "utf8");
  gitCapture(dir, ["add", "--", "seed.txt"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);

  initProject(dir);

  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);

  if (!orgaDirIgnoredInExclude(dir)) {
    throw new GitFixtureIgnoreError("startGitFixtureRun: .git/info/exclude has no .orga/ line after initProject");
  }
  if (!orgaDirCheckIgnored(dir)) {
    throw new GitFixtureIgnoreError("startGitFixtureRun: git check-ignore -q .orga/ did not exit 0");
  }

  return startFixtureRun(dir, tasks);
}
