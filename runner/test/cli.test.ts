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

function minimalBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: {
      tasks: [
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
          enabled: true,
        },
      ],
    },
  };
}

function writeBoard(dir: string): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(minimalBoard(), null, 2));
  return boardPath;
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
}

function seedQuestion(root: string, seed: QuestionSeed): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO questions (id, run_id, task_id, owner, blocking_scope, prompt, safe_default, answer, status, created_at, answered_at, payload)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
      ).run(seed.id, seed.runId, seed.taskId, seed.owner, seed.blockingScope, seed.prompt, seed.status, seed.createdAt, seed.payload);
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

test("run questions without --json prints one human line per row, or a single no-open-questions line", async () => {
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
    });

    const withRowsIo = ioAt(dir);
    const withRowsCode = await main(["node", "orga", "run", "questions", runId], withRowsIo);
    assert.equal(withRowsCode, EXIT_CODES.OK);
    assert.equal(withRowsIo.outLines.length, 1);
    assert.throws(() => JSON.parse(withRowsIo.outLines[0] as string));
    assert.equal(withRowsIo.outLines[0], `- ${runId}#oq-1#t1 [task] owner=operator: which way?`);

    const emptyRunId = "run-q3-empty";
    seedRunAtState(dir, emptyRunId, "running", 1000);
    const emptyIo = ioAt(dir);
    const emptyCode = await main(["node", "orga", "run", "questions", emptyRunId], emptyIo);
    assert.equal(emptyCode, EXIT_CODES.OK);
    assert.deepEqual(emptyIo.outLines, ["no open questions"]);
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
    assert.equal(run.state, "succeeded", "an empty board has nothing to dispatch and rests at succeeded");
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
// reliable black-box CLI assertion: with no task materialized into the
// `tasks` table by any command in this build (`run start` included), the
// in-process supervisor's own first tick always rests immediately, so the
// window between installing the handler and the process resting is on the
// order of single-digit milliseconds — too small to hit deterministically
// from outside the process. `installForegroundInterruptHandler`'s own
// signal-handling correctness (durable cancellation ahead of a competing
// exit handler, real SIGTERM/SIGKILL escalation of a live worker) is
// covered end to end by `test/kill.test.ts`; the assertion above is what is
// mechanically checkable at this layer.
