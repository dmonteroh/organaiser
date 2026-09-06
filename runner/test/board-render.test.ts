import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { renderBoard } from "../src/board/render.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import type { TaskState } from "../src/store/types.ts";
import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import type { Io } from "../src/cli/commands.ts";

function fakeIo(dir: string): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => dir,
    now: () => Date.now(),
    env: {},
  };
}

const ALL_TASK_STATES: TaskState[] = [
  "defined",
  "specifying",
  "needs-refinement",
  "refining",
  "ready-to-implement",
  "implementing",
  "verifying",
  "spec-review",
  "quality-review",
  "ready-to-integrate",
  "integrating",
  "integrated",
  "waiting-operator",
  "parked",
  "superseded",
  "shelved",
  "cancelled",
];

const QUEUED = ["defined", "needs-refinement", "ready-to-implement", "ready-to-integrate"];
const ACTIVE = [
  "specifying",
  "refining",
  "implementing",
  "verifying",
  "spec-review",
  "quality-review",
  "integrating",
];
const ATTENTION = ["waiting-operator", "parked"];
const TERMINAL = ["integrated", "superseded", "shelved", "cancelled"];

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.json", "running", "running", now);
  });
}

interface TaskSeed {
  id: string;
  runId: string;
  state: TaskState;
  dependsOn?: string[];
  now: number;
}

function insertTask(db: ReturnType<typeof openStore>, seed: TaskSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.runId,
      seed.id,
      `Task ${seed.id}`,
      "brief.md",
      "task-board",
      null,
      JSON.stringify(seed.dependsOn ?? []),
      0,
      seed.state,
      null,
      seed.now,
      seed.now,
    );
  });
}

interface AttemptSeed {
  id: string;
  runId: string;
  taskId: string;
  round: number;
  vendor: string;
  status: string;
  now: number;
}

function insertAttempt(db: ReturnType<typeof openStore>, seed: AttemptSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(seed.id, seed.runId, seed.taskId, "stage-1", "implementer", seed.round, "v1", seed.vendor, "m1", "{}", 0, seed.status, seed.now);
  });
}

interface WorkerSeed {
  id: string;
  runId: string;
  attemptId: string;
  pid: number;
  pgid: number;
  now: number;
  terminationState?: string | null;
}

function insertWorker(db: ReturnType<typeof openStore>, seed: WorkerSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, termination_state, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(seed.id, seed.runId, seed.attemptId, seed.pid, seed.pgid, seed.now, seed.terminationState ?? null, seed.now);
  });
}

interface QuestionSeed {
  id: string;
  runId: string;
  taskId: string;
  owner: string;
  blockingScope: string;
  prompt: string;
  status: string;
  now: number;
}

function insertQuestion(db: ReturnType<typeof openStore>, seed: QuestionSeed): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO questions (id, run_id, task_id, owner, blocking_scope, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(seed.id, seed.runId, seed.taskId, seed.owner, seed.blockingScope, seed.prompt, seed.status, seed.now);
  });
}

function seedFullBoard(db: ReturnType<typeof openStore>, runId: string): void {
  const now = 1_700_000_000_000;
  insertRun(db, runId, now);

  for (const state of ALL_TASK_STATES) {
    let dependsOn: string[] = [];
    if (state === "defined") dependsOn = ["specifying"];
    if (state === "ready-to-implement") dependsOn = ["integrated"];
    if (state === "ready-to-integrate") dependsOn = ["cancelled"];
    insertTask(db, { id: state, runId, state, dependsOn, now });
  }

  insertAttempt(db, { id: "att-1", runId, taskId: "integrated", round: 1, vendor: "fake", status: "failed", now });
  insertAttempt(db, { id: "att-2", runId, taskId: "integrated", round: 2, vendor: "claude", status: "completed", now: now + 1000 });

  insertWorker(db, { id: "w-active", runId, attemptId: "att-2", pid: 111, pgid: 111, now, terminationState: null });
  insertWorker(db, { id: "w-done", runId, attemptId: "att-1", pid: 222, pgid: 222, now, terminationState: "exited" });

  insertQuestion(db, {
    id: "q-open",
    runId,
    taskId: "waiting-operator",
    owner: "operator",
    blockingScope: "task",
    prompt: "which approach should we take?",
    status: "open",
    now,
  });
  insertQuestion(db, {
    id: "q-answered",
    runId,
    taskId: "waiting-operator",
    owner: "operator",
    blockingScope: "task",
    prompt: "already resolved question",
    status: "answered",
    now,
  });
}

test("renderBoard groups all 17 TaskState values into exactly the four queued/active/attention/terminal buckets", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    try {
      seedFullBoard(db, runId);
    } finally {
      db.close();
    }

    const writtenPath = renderBoard(dir, runId);
    const content = fs.readFileSync(writtenPath, "utf8");

    assert.match(content, /## Queued/);
    assert.match(content, /## Active/);
    assert.match(content, /## Attention/);
    assert.match(content, /## Terminal/);

    for (const id of QUEUED) assert.match(content, new RegExp(`\`${id}\`.*\\[${id}\\]`));
    for (const id of ACTIVE) assert.match(content, new RegExp(`\`${id}\`.*\\[${id}\\]`));
    for (const id of ATTENTION) assert.match(content, new RegExp(`\`${id}\`.*\\[${id}\\]`));
    for (const id of TERMINAL) assert.match(content, new RegExp(`\`${id}\`.*\\[${id}\\]`));

    assert.equal(QUEUED.length + ACTIVE.length + ATTENTION.length + TERMINAL.length, 17);
  });
});

test("renderBoard shows each task's most recent attempt's vendor and status", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    try {
      seedFullBoard(db, runId);
    } finally {
      db.close();
    }

    const writtenPath = renderBoard(dir, runId);
    const content = fs.readFileSync(writtenPath, "utf8");

    assert.match(content, /`integrated`.*claude \(completed\)/);
    assert.doesNotMatch(content, /`integrated`.*fake \(failed\)/);
  });
});

test("renderBoard lists active workers (no termination_state), pending (non-answered) questions, and the dependency-completion proxy for next eligible work", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    try {
      seedFullBoard(db, runId);
    } finally {
      db.close();
    }

    const writtenPath = renderBoard(dir, runId);
    const content = fs.readFileSync(writtenPath, "utf8");

    const workersSection = content.split("## Active workers")[1]?.split("## Pending questions")[0] ?? "";
    assert.match(workersSection, /pid 111/);
    assert.doesNotMatch(workersSection, /pid 222/);

    const questionsSection = content.split("## Pending questions")[1]?.split("## Next eligible work")[0] ?? "";
    assert.match(questionsSection, /which approach should we take\?/);
    assert.doesNotMatch(questionsSection, /already resolved question/);

    const eligibleSection = content.split("## Next eligible work")[1] ?? "";
    assert.match(eligibleSection, /P8c/);
    assert.match(eligibleSection, /`needs-refinement`/);
    assert.match(eligibleSection, /`ready-to-implement`/);
    assert.match(eligibleSection, /`ready-to-integrate`/);
    assert.doesNotMatch(eligibleSection, /`defined`/);
  });
});

test("renderBoard writes BOARD.md atomically with a 0o700 directory and 0o600 file, leaving no leftover temp file", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    try {
      insertRun(db, runId, Date.now());
      insertTask(db, { id: "t1", runId, state: "defined", now: Date.now() });
    } finally {
      db.close();
    }

    const writtenPath = renderBoard(dir, runId);
    assert.equal(writtenPath, path.join(dir, ".orga", "runs", runId, "BOARD.md"));

    const fileMode = fs.statSync(writtenPath).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const dirMode = fs.statSync(path.dirname(writtenPath)).mode & 0o777;
    assert.equal(dirMode, 0o700);

    const siblings = fs.readdirSync(path.dirname(writtenPath));
    assert.ok(!siblings.some((name) => name.includes(".tmp-")), `no leftover temp file, found: ${siblings.join(", ")}`);
  });
});

test("renderBoard honors a custom --output path with the same atomic-write and permission convention", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-1";
    try {
      insertRun(db, runId, Date.now());
      insertTask(db, { id: "t1", runId, state: "defined", now: Date.now() });
    } finally {
      db.close();
    }

    const customDir = path.join(dir, "custom-out");
    const customPath = path.join(customDir, "board-snapshot.md");
    const writtenPath = renderBoard(dir, runId, customPath);
    assert.equal(writtenPath, customPath);
    assert.ok(fs.existsSync(customPath));

    const fileMode = fs.statSync(customPath).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const dirMode = fs.statSync(customDir).mode & 0o777;
    assert.equal(dirMode, 0o700);

    const defaultPath = path.join(dir, ".orga", "runs", runId, "BOARD.md");
    assert.ok(!fs.existsSync(defaultPath));
  });
});

test("board render invoked via main() writes BOARD.md to the default path and exits OK", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-cli-1";
    try {
      insertRun(db, runId, Date.now());
      insertTask(db, { id: "t1", runId, state: "defined", now: Date.now() });
    } finally {
      db.close();
    }

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "board", "render", runId], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    const expectedPath = path.join(dir, ".orga", "runs", runId, "BOARD.md");
    assert.ok(fs.existsSync(expectedPath));
  });
});

test("board render invoked via main() threads a custom --output path through flagString to renderBoard", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const runId = "run-cli-2";
    try {
      insertRun(db, runId, Date.now());
      insertTask(db, { id: "t1", runId, state: "defined", now: Date.now() });
    } finally {
      db.close();
    }

    const customDir = path.join(dir, "custom-cli-out");
    const customPath = path.join(customDir, "board-snapshot.md");

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "board", "render", runId, "--output", customPath], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    assert.ok(fs.existsSync(customPath));
    const content = fs.readFileSync(customPath, "utf8");
    assert.match(content, /## Queued/);

    const defaultPath = path.join(dir, ".orga", "runs", runId, "BOARD.md");
    assert.ok(!fs.existsSync(defaultPath));
  });
});

test("board render invoked via main() with a missing run id exits NOT_FOUND", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "board", "render", "missing-run-id"], io);
    assert.equal(code, EXIT_CODES.NOT_FOUND);
  });
});

test("the runner never reads BOARD.md back: scheduler.ts, supervisor.ts, and commands.ts contain no reference to the render output filename", () => {
  const files = [
    fileURLToPath(new URL("../src/engine/scheduler.ts", import.meta.url)),
    fileURLToPath(new URL("../src/engine/supervisor.ts", import.meta.url)),
    fileURLToPath(new URL("../src/cli/commands.ts", import.meta.url)),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(!source.includes("BOARD.md"), `${file} must not reference BOARD.md`);
  }
});
