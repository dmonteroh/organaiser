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
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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
  try {
    return await fn(dir);
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export interface FixtureTaskSpec {
  id: string;
  title?: string;
  dependsOn?: readonly string[];
  briefPath?: string;
  priority?: number;
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
        enabled: true,
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
// and spawns its own configurable one instead. `startRun` never inserts
// `tasks` rows from `board.spec.tasks` — no P5a-P5e module does, in this
// phase — so every fixture that needs the scheduler to see real tasks seeds
// them directly, exactly as P5b/P5e's own tests already do
// (`seedWaitingOperatorTask` in supervisor-detach.test.ts).
export function startFixtureRun(dir: string, tasks: readonly FixtureTaskSpec[]): { runId: string; firstSupervisorPid: number } {
  initProject(dir);
  const { boardPath, workflowPath, templatePath } = writeFixtureFiles(dir, tasks);
  const board = boardWithTasks(tasks);
  const result = startRun({ root: dir, boardPath, board, workflowPath, templatePath });
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

// A well-formed implementer/integrator stream: reports success immediately.
export function wellFormedStream(overrides: Record<string, unknown> = {}): string[] {
  return [outputLine("working"), reportLine(overrides), exitLine(0)];
}
