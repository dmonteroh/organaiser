import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { main } from "../bin/orga.ts";
import { EXIT_CODES, KNOWN_EXIT_CODES, runStateToExitCode } from "../src/cli/exit-codes.ts";
import { initProject } from "../src/store/init.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import type { Io } from "../src/cli/commands.ts";
import type { RunRow } from "../src/store/types.ts";

const ORGA_BIN_PATH = fileURLToPath(new URL("../bin/orga.ts", import.meta.url));

// `now` mirrors real wall-clock time (`Date.now`) rather than a frozen fake
// clock: `run wait`'s poll loop races a real, independently-scheduled
// supervisor process, so its notion of "now" must advance on its own for a
// `--timeout` deadline to ever elapse.
function fakeIo(): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    env: {},
  };
}

function ioAt(dir: string): Io & { outLines: string[]; errLines: string[] } {
  const io = fakeIo();
  io.cwd = () => dir;
  return io;
}

function minimalBoard(tasks?: unknown[]): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: {
      tasks: tasks ?? [
        {
          id: "t1",
          title: "Task 1",
          briefPath: "brief.md",
          entry: { workflowId: "wf1", stageId: "s1" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          enabled: false,
        },
      ],
    },
  };
}

function writeBoard(dir: string, tasks?: unknown[]): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(minimalBoard(tasks), null, 2));
  return boardPath;
}

function findFilesNamed(root: string, names: readonly string[]): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (names.includes(entry.name)) {
        found.push(full);
      }
    }
  }
  return found;
}

function seedWaitingOperatorTask(root: string, runId: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("t1", runId, "t1", "Task 1", "brief.md", "wf1", null, "[]", 0, "waiting-operator", "waiting-operator", now, now);
    });
  } finally {
    db.close();
  }
}

function killGroupBestEffort(pgid: number | undefined): void {
  if (typeof pgid !== "number") return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

// ── init ─────────────────────────────────────────────────────────────────

test("orga init creates the project scaffold and exits 0", async () => {
  await withTempWorkspace(async (dir) => {
    const io = ioAt(dir);
    const code = await main(["node", "orga", "init"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.ok(fs.existsSync(path.join(dir, "orga.yaml")));
    assert.ok(fs.existsSync(path.join(dir, ".orga")));
  });
});

test("orga init --runner-checksum writes the value verbatim into orga.yaml", async () => {
  await withTempWorkspace(async (dir) => {
    const io = ioAt(dir);
    const checksum = "a".repeat(64);
    const code = await main(["node", "orga", "init", "--runner-checksum", checksum], io);
    assert.equal(code, EXIT_CODES.OK);
    const yaml = fs.readFileSync(path.join(dir, "orga.yaml"), "utf8");
    assert.match(yaml, new RegExp(`checksum: "${checksum}"`));
  });
});

test("orga init rejects a malformed --runner-checksum with 2", async () => {
  await withTempWorkspace(async (dir) => {
    const io = ioAt(dir);
    const code = await main(["node", "orga", "init", "--runner-checksum", "not-a-valid-checksum"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.ok(io.errLines.some((line) => line.includes("64 lowercase hex")));
  });
});

test("orga --version still works", async () => {
  await withTempWorkspace(async (dir) => {
    const io = ioAt(dir);
    const code = await main(["node", "orga", "--version"], io);
    assert.equal(code, 0);
    assert.equal(io.outLines.length, 1);
    assert.match(io.outLines[0] as string, /^\d+\.\d+\.\d+$/);
  });
});

test("an unrecognized command path exits 2 with usage on stderr", async () => {
  await withTempWorkspace(async (dir) => {
    const io = ioAt(dir);
    const code = await main(["node", "orga", "not-a-command"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.ok(io.errLines.some((line) => line.startsWith("usage:")));
  });
});

// ── run start / status / wait ───────────────────────────────────────────────

test("run start returns 0 on durable submission without waiting for run success, and does not spawn when the board is invalid", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const io = ioAt(dir);
    const badBoardPath = path.join(dir, "bad-board.json");
    fs.writeFileSync(badBoardPath, JSON.stringify({ apiVersion: "wrong" }));
    const code = await main(["node", "orga", "run", "start", "--board", badBoardPath], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
  });
});

function assertSemanticRejection(dir: string, boardPath: string, runIo: ReturnType<typeof ioAt>, offendingTaskId: string): void {
  assert.equal(runIo.errLines.length, 1);
  const line = runIo.errLines[0] as string;
  assert.ok(line.startsWith("error: "), `expected stderr to start with "error: ", got: ${line}`);
  assert.ok(line.includes(offendingTaskId), `expected stderr to mention "${offendingTaskId}", got: ${line}`);
  assert.ok(!line.includes("schema"), `expected stderr not to mention "schema", got: ${line}`);

  const db = openStore(dir);
  try {
    const runs = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    assert.equal(runs.n, 0);
  } finally {
    db.close();
  }
  assert.equal(fs.existsSync(path.join(dir, ".orga", "runs")), false);
  assert.deepEqual(findFilesNamed(dir, ["supervisor.pid", "supervisor.log"]), []);
}

test("run start rejects a board with a dangling dependency, matching board validate's exit code and committing nothing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir, [
      {
        id: "t1",
        title: "Task 1",
        briefPath: "brief.md",
        entry: { workflowId: "wf1", stageId: "s1" },
        dependencies: ["missing-task"],
        priority: 0,
        requiredWorkflowVersions: {},
        claims: "unknown",
        verification: [],
        enabled: true,
      },
    ]);

    const runIo = ioAt(dir);
    const runCode = await main(["node", "orga", "run", "start", "--board", boardPath], runIo);
    const validateIo = ioAt(dir);
    const validateCode = await main(["node", "orga", "board", "validate", "--board", boardPath], validateIo);

    assert.equal(runCode, EXIT_CODES.INVALID_ARGS);
    assert.equal(validateCode, EXIT_CODES.INVALID_ARGS);
    assert.equal(runCode, validateCode);

    assertSemanticRejection(dir, boardPath, runIo, "t1");
  });
});

test("run start rejects a board with a dependency cycle, matching board validate's exit code and committing nothing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir, [
      {
        id: "cycle-a",
        title: "Cycle A",
        briefPath: "brief.md",
        entry: { workflowId: "wf1", stageId: "s1" },
        dependencies: ["cycle-b"],
        priority: 0,
        requiredWorkflowVersions: {},
        claims: "unknown",
        verification: [],
        enabled: true,
      },
      {
        id: "cycle-b",
        title: "Cycle B",
        briefPath: "brief.md",
        entry: { workflowId: "wf1", stageId: "s1" },
        dependencies: ["cycle-a"],
        priority: 0,
        requiredWorkflowVersions: {},
        claims: "unknown",
        verification: [],
        enabled: true,
      },
    ]);

    const runIo = ioAt(dir);
    const runCode = await main(["node", "orga", "run", "start", "--board", boardPath], runIo);
    const validateIo = ioAt(dir);
    const validateCode = await main(["node", "orga", "board", "validate", "--board", boardPath], validateIo);

    assert.equal(runCode, EXIT_CODES.INVALID_ARGS);
    assert.equal(validateCode, EXIT_CODES.INVALID_ARGS);
    assert.equal(runCode, validateCode);

    assertSemanticRejection(dir, boardPath, runIo, "cycle-a");
  });
});

test("run start rejects a board with a duplicate task id, matching board validate's exit code and committing nothing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir, [
      {
        id: "dup-task",
        title: "First",
        briefPath: "brief.md",
        entry: { workflowId: "wf1", stageId: "s1" },
        dependencies: [],
        priority: 0,
        requiredWorkflowVersions: {},
        claims: "unknown",
        verification: [],
        enabled: true,
      },
      {
        id: "dup-task",
        title: "Second",
        briefPath: "brief.md",
        entry: { workflowId: "wf1", stageId: "s1" },
        dependencies: [],
        priority: 0,
        requiredWorkflowVersions: {},
        claims: "unknown",
        verification: [],
        enabled: true,
      },
    ]);

    const runIo = ioAt(dir);
    const runCode = await main(["node", "orga", "run", "start", "--board", boardPath], runIo);
    const validateIo = ioAt(dir);
    const validateCode = await main(["node", "orga", "board", "validate", "--board", boardPath], validateIo);

    assert.equal(runCode, EXIT_CODES.INVALID_ARGS);
    assert.equal(validateCode, EXIT_CODES.INVALID_ARGS);
    assert.equal(runCode, validateCode);

    assertSemanticRejection(dir, boardPath, runIo, "dup-task");
  });
});

test("run start commits the run and spawns a supervisor; run status reports it; unknown run id is 3", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir);
    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const started = JSON.parse(io.outLines[io.outLines.length - 1] as string) as {
      runId: string;
      supervisorPid: number;
    };
    try {
      const statusIo = ioAt(dir);
      const statusCode = await main(["node", "orga", "run", "status", started.runId, "--json"], statusIo);
      assert.equal(statusCode, EXIT_CODES.OK);
      const run = JSON.parse(statusIo.outLines[0] as string) as { id: string };
      assert.equal(run.id, started.runId);

      const missingIo = ioAt(dir);
      const missingCode = await main(["node", "orga", "run", "status", "does-not-exist"], missingIo);
      assert.equal(missingCode, EXIT_CODES.NOT_FOUND);
    } finally {
      killGroupBestEffort(started.supervisorPid);
    }
  });
});

test("run wait rejects an unknown --until state with 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir);
    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const started = JSON.parse(io.outLines[0] as string) as { runId: string; supervisorPid: number };
    try {
      const waitIo = ioAt(dir);
      const waitCode = await main(["node", "orga", "run", "wait", started.runId, "--until", "not-a-state"], waitIo);
      assert.equal(waitCode, EXIT_CODES.INVALID_ARGS);
    } finally {
      killGroupBestEffort(started.supervisorPid);
    }
  });
});

test("run wait returns 14 when the timeout elapses while the run is still going", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir);
    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    const started = JSON.parse(io.outLines[0] as string) as { runId: string; supervisorPid: number };
    try {
      seedWaitingOperatorTask(dir, started.runId, Date.now());
      const waitIo = ioAt(dir);
      const waitCode = await main(
        ["node", "orga", "run", "wait", started.runId, "--until", "succeeded,failed", "--timeout", "50ms"],
        waitIo,
      );
      assert.equal(waitCode, EXIT_CODES.WAIT_TIMEOUT);
    } finally {
      killGroupBestEffort(started.supervisorPid);
    }
  });
});

// ── run dry-run: spawns nothing ─────────────────────────────────────────────

test("run dry-run compiles every task's packet, spawns nothing, and inserts zero attempts/workers rows", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir);
    const io = ioAt(dir);

    const before = childCountOfSelf();
    const code = await main(["node", "orga", "run", "dry-run", "--board", boardPath, "--json"], io);
    const after = childCountOfSelf();
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(after, before, "dry-run must spawn zero child processes");

    const result = JSON.parse(io.outLines[0] as string) as { runId: string; packetPaths: string[] };
    assert.equal(result.packetPaths.length, 1);
    assert.ok(fs.existsSync(result.packetPaths[0] as string));
    const packetText = fs.readFileSync(result.packetPaths[0] as string, "utf8");
    assert.match(packetText, /## Packet Header/);
    assert.match(packetText, /## Instructions/);

    const db = openStore(dir);
    try {
      const attempts = db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number };
      const workers = db.prepare("SELECT COUNT(*) AS n FROM workers").get() as { n: number };
      assert.equal(attempts.n, 0);
      assert.equal(workers.n, 0);
    } finally {
      db.close();
    }
  });
});

// Portable across BSD (macOS) and GNU `ps`: lists every pid/ppid pair on the
// system and counts the ones whose parent is this test process, rather than
// relying on a `--ppid` flag only one of the two implementations accepts.
function childCountOfSelf(): number {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
    const selfPid = process.pid;
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => Number(line.split(/\s+/)[1]) === selfPid).length;
  } catch {
    return 0;
  }
}

// ── run pause / cancel / kill: not-found mapping ────────────────────────────

test("run pause, run cancel, and run kill each exit 3 for an unknown run id", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    for (const args of [
      ["run", "pause", "nope"],
      ["run", "cancel", "nope"],
      ["run", "kill", "nope"],
    ]) {
      const io = ioAt(dir);
      const code = await main(["node", "orga", ...args], io);
      assert.equal(code, EXIT_CODES.NOT_FOUND, `${args.join(" ")} must exit 3`);
    }
  });
});

test("kill-all with no runs exits 0", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const io = ioAt(dir);
    const code = await main(["node", "orga", "kill-all", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.deepEqual(JSON.parse(io.outLines[0] as string), {});
  });
});

// ── exit-code table: reachability and closure ───────────────────────────────

test("runStateToExitCode covers exactly the five section-25.3 terminal dispositions", () => {
  assert.equal(runStateToExitCode("succeeded"), EXIT_CODES.OK);
  assert.equal(runStateToExitCode("waiting-operator"), EXIT_CODES.WAITING_OPERATOR);
  assert.equal(runStateToExitCode("blocked"), EXIT_CODES.BLOCKED);
  assert.equal(runStateToExitCode("failed"), EXIT_CODES.FAILED);
  assert.equal(runStateToExitCode("cancelled"), EXIT_CODES.CANCELLED);
  for (const nonTerminal of ["starting", "running", "cancelling", "paused"]) {
    assert.equal(runStateToExitCode(nonTerminal), null, `${nonTerminal} must not map to a code`);
  }
});

function seedRunAtState(root: string, runId: string, state: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(runId, "board.json", state, state, now);
    });
  } finally {
    db.close();
  }
}

// ── run questions ────────────────────────────────────────────────────────

interface QuestionSeed {
  id: string;
  runId: string;
  taskId: string | null;
  owner: string;
  blockingScope: string;
  prompt: string;
  status: string;
  createdAt: number;
  payload: string | null;
  safeDefault?: string | null;
}

function seedQuestion(root: string, seed: QuestionSeed): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO questions (id, run_id, task_id, owner, blocking_scope, prompt, safe_default, answer, status, created_at, answered_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
      ).run(
        seed.id,
        seed.runId,
        seed.taskId,
        seed.owner,
        seed.blockingScope,
        seed.prompt,
        seed.safeDefault ?? null,
        seed.status,
        seed.createdAt,
        seed.payload,
      );
    });
  } finally {
    db.close();
  }
}

test("run questions --json emits open rows ordered by created_at, with payload parsed back to the verbatim question", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q1";
    seedRunAtState(dir, runId, "waiting-operator", 1000);
    const question = { id: "oq-1", taskId: "t1", owner: "operator", question: "which way?", context: "c", impact: "i", blocks: [] };
    seedQuestion(dir, {
      id: `${runId}#oq-1#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "which way?",
      status: "open",
      createdAt: 2000,
      payload: JSON.stringify(question),
    });
    seedQuestion(dir, {
      id: `${runId}#oq-0#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "earlier one",
      status: "open",
      createdAt: 1000,
      payload: null,
    });
    seedQuestion(dir, {
      id: `${runId}#oq-2#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "already answered",
      status: "answered",
      createdAt: 500,
      payload: null,
    });

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "questions", runId, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(io.outLines.length, 1);
    const parsed = JSON.parse(io.outLines[0] as string) as {
      runId: string;
      questions: Array<{ rowId: string; taskId: string | null; blockingScope: string; status: string; question: unknown }>;
    };
    assert.equal(parsed.runId, runId);
    assert.equal(parsed.questions.length, 2);
    assert.equal(parsed.questions[0]!.rowId, `${runId}#oq-0#t1`);
    assert.equal(parsed.questions[0]!.question, null);
    assert.equal(parsed.questions[1]!.rowId, `${runId}#oq-1#t1`);
    assert.equal(parsed.questions[1]!.taskId, "t1");
    assert.equal(parsed.questions[1]!.blockingScope, "task");
    assert.equal(parsed.questions[1]!.status, "open");
    assert.deepEqual(parsed.questions[1]!.question, question);
  });
});

test("run questions --json with no open questions emits an empty array and exits 0", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q2";
    seedRunAtState(dir, runId, "running", 1000);

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "questions", runId, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.deepEqual(JSON.parse(io.outLines[0] as string), { runId, questions: [] });
  });
});

test("run questions without --json prints a table with a single row, or a single no-open-questions line", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q3";
    seedRunAtState(dir, runId, "waiting-operator", 1000);
    seedQuestion(dir, {
      id: `${runId}#oq-1#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "which way?",
      status: "open",
      createdAt: 2000,
      payload: null,
      safeDefault: "go left",
    });

    const withRowsIo = ioAt(dir);
    const withRowsCode = await main(["node", "orga", "run", "questions", runId], withRowsIo);
    assert.equal(withRowsCode, EXIT_CODES.OK);
    assert.equal(withRowsIo.outLines.length, 2);
    assert.throws(() => JSON.parse(withRowsIo.outLines[0] as string));
    assert.equal(withRowsIo.outLines[0], "id              question    default  blocked tasks");
    assert.equal(withRowsIo.outLines[1], `${runId}#oq-1#t1  which way?  go left  t1           `);

    const emptyRunId = "run-q3-empty";
    seedRunAtState(dir, emptyRunId, "running", 1000);
    const emptyIo = ioAt(dir);
    const emptyCode = await main(["node", "orga", "run", "questions", emptyRunId], emptyIo);
    assert.equal(emptyCode, EXIT_CODES.OK);
    assert.deepEqual(emptyIo.outLines, ["no open questions"]);
  });
});

test("run questions without --json aggregates fan-out and mixed run+task rows by raw question id", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q4";
    seedRunAtState(dir, runId, "waiting-operator", 1000);

    seedQuestion(dir, {
      id: `${runId}#legacy#t9`,
      runId,
      taskId: "t9",
      owner: "operator",
      blockingScope: "task",
      prompt: "legacy prompt\nwith a newline",
      status: "open",
      createdAt: 500,
      payload: null,
      safeDefault: "keep\ndefault",
    });

    const fanoutQuestion = { id: "oq-1", owner: "operator", question: "fanout A", blocks: ["t1", "t2"] };
    seedQuestion(dir, {
      id: `${runId}#oq-1#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "fanout A",
      status: "open",
      createdAt: 1000,
      payload: JSON.stringify(fanoutQuestion),
      safeDefault: "left directions",
    });
    seedQuestion(dir, {
      id: `${runId}#oq-1#t2`,
      runId,
      taskId: "t2",
      owner: "operator",
      blockingScope: "task",
      prompt: "fanout B",
      status: "open",
      createdAt: 1000,
      payload: JSON.stringify({ ...fanoutQuestion, question: "fanout B" }),
    });

    const mixedQuestion = { id: "oq-2", owner: "operator", question: "mixed", blocks: [runId, "t3"] };
    seedQuestion(dir, {
      id: `${runId}#oq-2#run`,
      runId,
      taskId: null,
      owner: "operator",
      blockingScope: "run",
      prompt: "mixed",
      status: "open",
      createdAt: 2000,
      payload: JSON.stringify(mixedQuestion),
    });
    seedQuestion(dir, {
      id: `${runId}#oq-2#t3`,
      runId,
      taskId: "t3",
      owner: "operator",
      blockingScope: "task",
      prompt: "mixed later",
      status: "open",
      createdAt: 2500,
      payload: JSON.stringify({ ...mixedQuestion, question: "mixed later" }),
    });

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "questions", runId], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(io.outLines.length, 4);
    assert.equal(io.outLines[0], "id                question                      default          blocked tasks");
    assert.equal(io.outLines[1], `${runId}#legacy#t9  legacy prompt with a newline  keep default     t9           `);
    assert.equal(io.outLines[2], "oq-1              fanout A                      left directions  t1, t2       ");
    assert.equal(io.outLines[3], "oq-2              mixed                         (none)           (run), t3    ");
  });
});

test("run questions exits 3 for an unknown run id and 2 for a missing run id", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    const unknownIo = ioAt(dir);
    const unknownCode = await main(["node", "orga", "run", "questions", "does-not-exist"], unknownIo);
    assert.equal(unknownCode, EXIT_CODES.NOT_FOUND);

    const missingIo = ioAt(dir);
    const missingCode = await main(["node", "orga", "run", "questions"], missingIo);
    assert.equal(missingCode, EXIT_CODES.INVALID_ARGS);
  });
});

test("run questions --template writes an answers file that round-trips through run answer for a plain, an unrepresentable, and a missing default", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q5";
    seedRunAtState(dir, runId, "waiting-operator", 1000);

    const plainRowId = `${runId}#oq-plain#t1`;
    const quoteRowId = `${runId}#oq-quote#t2`;
    const noneRowId = `${runId}#oq-none#t3`;
    const plainId = "oq-plain";
    const quoteId = "oq-quote";
    const noneId = "oq-none";

    seedQuestion(dir, {
      id: plainRowId,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "plain default",
      status: "open",
      createdAt: 1000,
      payload: JSON.stringify({ id: plainId, owner: "operator", question: "plain default", blocks: ["t1"] }),
      safeDefault: "go left",
    });
    seedQuestion(dir, {
      id: quoteRowId,
      runId,
      taskId: "t2",
      owner: "operator",
      blockingScope: "task",
      prompt: "unrepresentable default",
      status: "open",
      createdAt: 2000,
      payload: JSON.stringify({ id: quoteId, owner: "operator", question: "unrepresentable default", blocks: ["t2"] }),
      safeDefault: 'contains "a quote"',
    });
    seedQuestion(dir, {
      id: noneRowId,
      runId,
      taskId: "t3",
      owner: "operator",
      blockingScope: "task",
      prompt: "no default",
      status: "open",
      createdAt: 3000,
      payload: JSON.stringify({ id: noneId, owner: "operator", question: "no default", blocks: ["t3"] }),
      safeDefault: null,
    });

    const templatePath = path.join(dir, "answers-template.yaml");
    const writeIo = ioAt(dir);
    const writeCode = await main(["node", "orga", "run", "questions", runId, "--template", templatePath], writeIo);
    assert.equal(writeCode, EXIT_CODES.OK);
    assert.equal(writeIo.outLines.length, 1);
    assert.ok((writeIo.outLines[0] as string).includes(templatePath));

    const templateText = fs.readFileSync(templatePath, "utf8");
    assert.ok(templateText.startsWith("answers:\n"));
    assert.ok(templateText.includes(`  ${plainId}: "go left"`));
    assert.ok(templateText.includes(`  ${quoteId}: ""`));
    assert.ok(templateText.includes(`  ${noneId}: ""`));
    const quoteCommentLine = templateText
      .split("\n")
      .find((line) => line.trimStart().startsWith("#") && line.includes(quoteId));
    assert.ok(quoteCommentLine, "expected a comment line naming the unrepresentable-default id");
    const noneCommentLine = templateText
      .split("\n")
      .find((line) => line.trimStart().startsWith("#") && line.includes(noneId));
    assert.ok(noneCommentLine, "expected a comment line naming the no-default id");

    const answerIo = ioAt(dir);
    const answerCode = await main(
      ["node", "orga", "run", "answer", runId, "--file", templatePath, "--json"],
      answerIo,
    );
    assert.equal(answerCode, EXIT_CODES.OK);
    const answerOutput = JSON.parse(answerIo.outLines[0] as string) as {
      answered: Array<{ questionId: string; rowIds: string[] }>;
    };
    assert.equal(answerOutput.answered.length, 3);
    assert.deepEqual(
      answerOutput.answered.map((entry) => entry.questionId).sort(),
      [noneId, plainId, quoteId].sort(),
    );

    const db = openStore(dir);
    try {
      const plainRow = db.prepare(`SELECT answer, status FROM questions WHERE id = ?`).get(plainRowId) as {
        answer: string;
        status: string;
      };
      assert.equal(plainRow.answer, "go left");
      assert.equal(plainRow.status, "answered");

      const quoteRow = db.prepare(`SELECT answer, status FROM questions WHERE id = ?`).get(quoteRowId) as {
        answer: string;
        status: string;
      };
      assert.equal(quoteRow.answer, "");
      assert.equal(quoteRow.status, "answered");

      const noneRow = db.prepare(`SELECT answer, status FROM questions WHERE id = ?`).get(noneRowId) as {
        answer: string;
        status: string;
      };
      assert.equal(noneRow.answer, "");
      assert.equal(noneRow.status, "answered");
    } finally {
      db.close();
    }
  });
});

test("run questions --template with zero pending questions prints the no-open-questions line and writes no file", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q6";
    seedRunAtState(dir, runId, "running", 1000);

    const templatePath = path.join(dir, "answers-template.yaml");
    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "questions", runId, "--template", templatePath], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.deepEqual(io.outLines, ["no open questions"]);
    assert.equal(fs.existsSync(templatePath), false);
  });
});

test("run questions --template combined with --json is a usage error, exit 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q7";
    seedRunAtState(dir, runId, "waiting-operator", 1000);
    seedQuestion(dir, {
      id: `${runId}#oq-1#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "which way?",
      status: "open",
      createdAt: 1000,
      payload: null,
      safeDefault: "go left",
    });

    const templatePath = path.join(dir, "answers-template.yaml");
    const io = ioAt(dir);
    const code = await main(
      ["node", "orga", "run", "questions", runId, "--template", templatePath, "--json"],
      io,
    );
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.equal(fs.existsSync(templatePath), false);
  });
});

test("run questions --template prints one confirmation line naming the path and both counts, without the table", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-q8";
    seedRunAtState(dir, runId, "waiting-operator", 1000);
    seedQuestion(dir, {
      id: `${runId}#oq-a#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "a",
      status: "open",
      createdAt: 1000,
      payload: null,
      safeDefault: "default a",
    });
    seedQuestion(dir, {
      id: `${runId}#oq-b#t2`,
      runId,
      taskId: "t2",
      owner: "operator",
      blockingScope: "task",
      prompt: "b",
      status: "open",
      createdAt: 2000,
      payload: null,
      safeDefault: "default b",
    });
    seedQuestion(dir, {
      id: `${runId}#oq-c#t3`,
      runId,
      taskId: "t3",
      owner: "operator",
      blockingScope: "task",
      prompt: "c",
      status: "open",
      createdAt: 3000,
      payload: null,
      safeDefault: null,
    });

    const templatePath = path.join(dir, "answers-template.yaml");
    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "questions", runId, "--template", templatePath], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(io.outLines.length, 1);
    const line = io.outLines[0] as string;
    assert.ok(line.includes(templatePath), `expected line to include ${templatePath}: ${line}`);
    const withoutPath = line.split(templatePath).join("");
    assert.match(withoutPath, /\b2\b/);
    assert.match(withoutPath, /\b1\b/);
    assert.match(withoutPath, /prefilled/);
    assert.match(withoutPath, /blank/);
  });
});

// ── run status: pending-question visibility ─────────────────────────────────

test("run status reports pending-questions=<n> aggregated by raw id, both on the human line and --json's additive fields", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-s1";
    seedRunAtState(dir, runId, "waiting-operator", 1000);

    const zeroIo = ioAt(dir);
    const zeroCode = await main(["node", "orga", "run", "status", runId], zeroIo);
    assert.equal(zeroCode, EXIT_CODES.OK);
    assert.equal(
      zeroIo.outLines[0],
      `run ${runId}: state=waiting-operator desired=waiting-operator pending-questions=0`,
    );

    const fanoutQuestion = { id: "oq-1", owner: "operator", question: "fanout", blocks: ["t1", "t2"] };
    seedQuestion(dir, {
      id: `${runId}#oq-1#t1`,
      runId,
      taskId: "t1",
      owner: "operator",
      blockingScope: "task",
      prompt: "fanout",
      status: "open",
      createdAt: 1000,
      payload: JSON.stringify(fanoutQuestion),
      safeDefault: "pick one",
    });
    seedQuestion(dir, {
      id: `${runId}#oq-1#t2`,
      runId,
      taskId: "t2",
      owner: "operator",
      blockingScope: "task",
      prompt: "fanout",
      status: "open",
      createdAt: 1500,
      payload: JSON.stringify(fanoutQuestion),
    });

    const mixedQuestion = { id: "oq-2", owner: "operator", question: "mixed", blocks: [runId, "t3"] };
    seedQuestion(dir, {
      id: `${runId}#oq-2#run`,
      runId,
      taskId: null,
      owner: "operator",
      blockingScope: "run",
      prompt: "mixed",
      status: "open",
      createdAt: 2000,
      payload: JSON.stringify(mixedQuestion),
    });
    seedQuestion(dir, {
      id: `${runId}#oq-2#t3`,
      runId,
      taskId: "t3",
      owner: "operator",
      blockingScope: "task",
      prompt: "mixed",
      status: "open",
      createdAt: 2500,
      payload: JSON.stringify(mixedQuestion),
    });

    seedQuestion(dir, {
      id: `${runId}#oq-3#t9`,
      runId,
      taskId: "t9",
      owner: "operator",
      blockingScope: "task",
      prompt: "already answered",
      status: "answered",
      createdAt: 100,
      payload: null,
    });

    const humanIo = ioAt(dir);
    const humanCode = await main(["node", "orga", "run", "status", runId], humanIo);
    assert.equal(humanCode, EXIT_CODES.OK);
    assert.equal(humanIo.outLines.length, 1);
    assert.equal(
      humanIo.outLines[0],
      `run ${runId}: state=waiting-operator desired=waiting-operator pending-questions=2`,
    );

    const jsonIo = ioAt(dir);
    const jsonCode = await main(["node", "orga", "run", "status", runId, "--json"], jsonIo);
    assert.equal(jsonCode, EXIT_CODES.OK);
    const value = JSON.parse(jsonIo.outLines[0] as string) as {
      id: string;
      pendingQuestionCount: number;
      pendingQuestions: Array<{
        questionId: string;
        taskIds: string[];
        blocksRun: boolean;
        status: string;
        question: unknown;
      }>;
    };
    assert.equal(value.id, runId);
    assert.equal(value.pendingQuestionCount, 2);
    assert.equal(value.pendingQuestions.length, 2);
    assert.deepEqual(value.pendingQuestions[0], {
      questionId: "oq-1",
      taskIds: ["t1", "t2"],
      blocksRun: false,
      status: "open",
      question: fanoutQuestion,
    });
    assert.deepEqual(value.pendingQuestions[1], {
      questionId: "oq-2",
      taskIds: ["t3"],
      blocksRun: true,
      status: "open",
      question: mixedQuestion,
    });
  });
});

// Exit codes 0/2/3/14 are driven through real `orga` invocations below. The
// five state-derived codes (10/11/12/13, plus 0's `succeeded` case) are
// exercised through `run wait` against a directly-seeded `runs` row rather
// than a live scheduler tick: `run wait`'s state-to-code mapping is what this
// test is actually proving, and P5's scheduler (schedulerTick,
// classifyTick in scheduler.ts) never itself writes `state = 'failed'` for a
// run — no step in the six-step tick body goals spec section 11 defines
// produces that disposition in this phase, so a live run can reach every
// code this table declares except 12. The fixture suite's real end-to-end
// runs additionally prove 10/11/13 (and 4, via a real losing supervisor)
// against a live scheduler, not just this mapping.
test("every documented exit code is reachable from at least one command", async () => {
  const reachable = new Set<number>();

  await withTempWorkspace(async (dir) => {
    // 0
    reachable.add(await main(["node", "orga", "init"], ioAt(dir)));
    // 2
    reachable.add(await main(["node", "orga", "run", "start"], ioAt(dir)));
    // 3
    reachable.add(await main(["node", "orga", "run", "status", "nope"], ioAt(dir)));

    const boardPath = writeBoard(dir);
    const startIo = ioAt(dir);
    await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], startIo);
    const started = JSON.parse(startIo.outLines[0] as string) as { runId: string; supervisorPid: number };
    try {
      seedWaitingOperatorTask(dir, started.runId, Date.now());
      // 14
      reachable.add(
        await main(
          ["node", "orga", "run", "wait", started.runId, "--until", "succeeded", "--timeout", "50ms"],
          ioAt(dir),
        ),
      );
    } finally {
      killGroupBestEffort(started.supervisorPid);
    }

    for (const state of ["succeeded", "waiting-operator", "blocked", "failed", "cancelled"]) {
      const runId = `seeded-${state}`;
      seedRunAtState(dir, runId, state, Date.now());
      const code = await main(["node", "orga", "run", "wait", runId, "--until", state], ioAt(dir));
      reachable.add(code);
    }

    // 4: the same catch-all fallback `supervisor.ts` itself uses for every
    // lease/tick error ("mapped to exit code 4, per the process-health scheme
    // fixed by tick.ts") — here triggered by a missing `.orga` store
    // (`openStore` throws `ProjectRootError`) rather than an engine
    // invariant, since P5f owns no invariant of its own to violate; the
    // mapping itself is what this asserts.
    fs.rmSync(path.join(dir, ".orga"), { recursive: true, force: true });
    reachable.add(await main(["node", "orga", "run", "status", "does-not-matter"], ioAt(dir)));
  });

  for (const code of KNOWN_EXIT_CODES) {
    if (code === EXIT_CODES.VENDOR_UNAVAILABLE) continue; // see below
    assert.ok(reachable.has(code), `exit code ${code} must be reachable from some command`);
  }
});

// Exit code 15 ("vendor unavailable or unauthenticated") has no producer
// anywhere in this command surface: no command here talks to a vendor
// adapter (a vendor adapter is explicitly out of this child's scope), so no
// argv this CLI accepts can return it today. It stays declared in the table
// for the phase that adds a vendor-facing command (`doctor`, P6/P8/P9); this
// test only asserts it exists as a distinct, correctly-valued member.
test("exit code 15 (vendor unavailable) is declared but has no command-reachable producer in this phase", () => {
  assert.equal(EXIT_CODES.VENDOR_UNAVAILABLE, 15);
  assert.ok((KNOWN_EXIT_CODES as readonly number[]).includes(15));
});

test("no command returns a code outside the documented table", async () => {
  await withTempWorkspace(async (dir) => {
    const attempts: Array<[string[], Io]> = [
      [["node", "orga", "init"], ioAt(dir)],
      [["node", "orga", "not-a-command"], ioAt(dir)],
      [["node", "orga", "run", "status", "nope"], ioAt(dir)],
      [["node", "orga", "run", "start"], ioAt(dir)],
      [["node", "orga", "kill-all"], ioAt(dir)],
    ];
    for (const [argv, io] of attempts) {
      const code = await main(argv, io);
      assert.ok((KNOWN_EXIT_CODES as readonly number[]).includes(code), `${argv.join(" ")} returned undocumented code ${code}`);
    }
  });
});

// ── output channel discipline: --json is the only thing on stdout ──────────

test("--json output on a piped stdout parses as JSON with no stray line, and diagnostics stay on stderr", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const child = spawn(process.execPath, [ORGA_BIN_PATH, "kill-all", "--json"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));
    assert.equal(code, EXIT_CODES.OK, `stderr: ${stderr}`);

    const lines = stdout.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1, `stdout must carry exactly one JSON line, got: ${JSON.stringify(stdout)}`);
    assert.doesNotThrow(() => JSON.parse(lines[0] as string));
  });
});

test("a human-readable (non-JSON) run status prints on stdout, not JSON", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir);
    const io = ioAt(dir);
    await main(["node", "orga", "run", "start", "--board", boardPath, "--json"], io);
    const started = JSON.parse(io.outLines[0] as string) as { runId: string; supervisorPid: number };
    try {
      const statusIo = ioAt(dir);
      await main(["node", "orga", "run", "status", started.runId], statusIo);
      assert.equal(statusIo.outLines.length, 1);
      assert.throws(() => JSON.parse(statusIo.outLines[0] as string));
      assert.match(statusIo.outLines[0] as string, /^run /);
    } finally {
      killGroupBestEffort(started.supervisorPid);
    }
  });
});

// ── run start --foreground: the supervisor runs in the calling process ─────

test("run start --foreground returns only after the run rests, mapped to the matching exit code, spawning no detached supervisor", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const boardPath = writeBoard(dir);
    const io = ioAt(dir);

    const before = childCountOfSelf();
    const code = await main(["node", "orga", "run", "start", "--board", boardPath, "--foreground", "--json"], io);
    const after = childCountOfSelf();

    assert.equal(after, before, "--foreground must spawn no detached child process");
    assert.equal(io.outLines.length, 1, "exactly one stdout value after the wait ends");
    const run = JSON.parse(io.outLines[0] as string) as RunRow;
    assert.equal(run.state, "succeeded", "a board whose only task is deliberately disabled has nothing to dispatch and rests at succeeded");
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(runStateToExitCode(run.state), code);

    const runDir = path.join(dir, ".orga", "runs", run.id);
    assert.ok(!fs.existsSync(path.join(runDir, "supervisor.log")), "no supervisor.log: nothing was spawned");
    assert.ok(!fs.existsSync(path.join(runDir, "supervisor.pid")), "no supervisor.pid: nothing was spawned");
  });
});

// `cmdRunStartForeground`'s source is the mechanically-checkable proof that
// the interrupt handler is installed synchronously, ahead of any worker the
// run could ever spawn: `installForegroundInterruptHandler` must appear
// before the `runSupervisor` call, with no `await` and no other
// process-spawning statement between the two.
test("the interrupt handler is installed before runSupervisor is awaited, with nothing spawning in between", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/cli/commands.ts", import.meta.url)), "utf8");
  const bodyStart = source.indexOf("async function cmdRunStartForeground");
  const bodyEnd = source.indexOf("\n}\n", bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "cmdRunStartForeground must exist as a named function");
  const body = source.slice(bodyStart, bodyEnd);

  const installAt = body.indexOf("installForegroundInterruptHandler(");
  const runSupervisorAt = body.indexOf("await runSupervisor(");
  assert.ok(installAt >= 0, "must install the foreground interrupt handler");
  assert.ok(runSupervisorAt >= 0, "must await runSupervisor");
  assert.ok(installAt < runSupervisorAt, "the handler must install before runSupervisor is awaited");

  const between = body.slice(installAt, runSupervisorAt);
  assert.ok(!/\bawait\b/.test(between), "no await may sit between installing the handler and awaiting runSupervisor");
  assert.ok(!/\bspawn\(/.test(between), "no process may spawn between installing the handler and awaiting runSupervisor");
});

// A live SIGINT race against this phase's `--foreground` path is not a
// reliable black-box CLI assertion: this board's single task is disabled, so
// the in-process supervisor's own first tick always rests immediately, and
// the window between installing the handler and the process resting is on
// the order of single-digit milliseconds — too small to hit deterministically
// from outside the process. `installForegroundInterruptHandler`'s own
// signal-handling correctness (durable cancellation ahead of a competing
// exit handler, real SIGTERM/SIGKILL escalation of a live worker) is
// covered end to end by `test/kill.test.ts`; the assertion above is what is
// mechanically checkable at this layer.
