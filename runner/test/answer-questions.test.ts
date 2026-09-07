import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import { initProject } from "../src/store/init.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import { persistOperatorQuestions } from "../src/engine/operator-questions.ts";
import { acquireLease } from "../src/store/lease.ts";
import { DEFAULT_TICK_INTERVAL_MS } from "../src/engine/tick.ts";
import type { Io, SpawnFn } from "../src/cli/commands.ts";
import type { QuestionRow } from "../src/store/types.ts";

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

function countingSpawnFn(fakePid: number): { spawnFn: SpawnFn; callCount: () => number } {
  let calls = 0;
  const spawnFn: SpawnFn = () => {
    calls += 1;
    return { pid: fakePid, unref() {} };
  };
  return { spawnFn, callCount: () => calls };
}

function insertRun(db: DatabaseSync, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(runId, "board.json", "running", "running", now);
  });
}

function insertTask(db: DatabaseSync, id: string, runId: string, taskKey: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, runId, taskKey, `Task ${id}`, "brief.md", "task-board", null, "[]", 0, "implementing", null, now, now);
  });
}

function makeQuestion(id: string, taskId: string | undefined, blocks: readonly string[]): Record<string, unknown> {
  return {
    id,
    owner: "operator",
    question: `question ${id}`,
    context: "ctx",
    impact: "impact",
    safeDefault: null,
    taskId,
    blocks,
  };
}

function makeQuestionWithDefault(
  id: string,
  taskId: string | undefined,
  blocks: readonly string[],
  summary: string,
): Record<string, unknown> {
  return {
    id,
    owner: "operator",
    question: `question ${id}`,
    context: "ctx",
    impact: "impact",
    safeDefault: { summary },
    taskId,
    blocks,
  };
}

function questionRowsFor(db: DatabaseSync, runId: string): QuestionRow[] {
  return db
    .prepare(`SELECT * FROM questions WHERE run_id = ? ORDER BY id ASC`)
    .all(runId) as unknown as QuestionRow[];
}

function writeAnswersFile(dir: string, name: string, entries: Record<string, string>): string {
  const lines = ["answers:", ...Object.entries(entries).map(([key, value]) => `  ${key}: ${value}`)];
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

function eventsFor(db: DatabaseSync, runId: string): Array<{ type: string; payload: string }> {
  return db
    .prepare(`SELECT type, payload FROM events WHERE run_id = ? ORDER BY seq ASC`)
    .all(runId) as unknown as Array<{ type: string; payload: string }>;
}

function answersDirFor(dir: string, runId: string): string {
  return path.join(dir, ".orga", "runs", runId, "answers");
}

test("a key answered across its fan-out (task row plus run row) writes one .v1 artifact, updates both rows, and appends one event", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      insertTask(db, "task-a-row", runId, "task-a", 1_000_000);
      persistOperatorQuestions(
        db,
        { runId, questions: [makeQuestion("q1", "task-a", [runId])] },
        2_000_000,
      );
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const answersPath = writeAnswersFile(dir, "answers.yaml", { q1: "use option A" });
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as {
      runId: string;
      answered: Array<{ questionId: string; rowIds: string[]; artifact: { path: string; sha256: string } }>;
      unblockedTaskIds: string[];
    };
    assert.equal(output.runId, runId);
    assert.equal(output.answered.length, 1);
    assert.equal(output.answered[0]!.questionId, "q1");
    assert.equal(output.answered[0]!.rowIds.length, 2);
    assert.equal(output.answered[0]!.artifact.path, `.orga/runs/${runId}/answers/q1.v1.json`);
    assert.match(output.answered[0]!.artifact.sha256, /^[0-9a-f]{64}$/);

    const artifactAbsPath = path.join(dir, output.answered[0]!.artifact.path);
    const artifactContent = JSON.parse(fs.readFileSync(artifactAbsPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(artifactContent), ["questionId", "answer", "rowIds", "blockedTaskIds", "answeredAt"]);
    assert.equal(artifactContent.questionId, "q1");
    assert.equal(artifactContent.answer, "use option A");
    assert.equal(fs.readFileSync(artifactAbsPath, "utf8").endsWith("\n"), true);

    const dbAfter = openStore(dir);
    try {
      const rows = questionRowsFor(dbAfter, runId);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.status, "answered");
        assert.equal(row.answer, "use option A");
        assert.equal(typeof row.answered_at, "number");
        assert.ok((row.answered_at as number) > 0);
      }
      const events = eventsFor(dbAfter, runId);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "question.answered");
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      assert.equal(payload.questionId, "q1");
      assert.equal(payload.previousState, "open");
      assert.equal(payload.nextState, "answered");
      assert.equal(payload.reasonCode, "operator-answer");
      assert.deepEqual((payload.rowIds as string[]).slice().sort(), rows.map((r) => r.id).sort());
    } finally {
      dbAfter.close();
    }
  });
});

test("re-running the same answers file is a complete no-op the second time", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(db, { runId, questions: [makeQuestion("q1", undefined, [runId])] }, 2_000_000);
    } finally {
      db.close();
    }

    const io1 = ioAt(dir);
    const answersPath = writeAnswersFile(dir, "answers.yaml", { q1: "an answer" });
    const first = await main(["node", "orga", "run", "answer", runId, "--file", answersPath], io1);
    assert.equal(first, EXIT_CODES.OK);

    const dbAfterFirst = openStore(dir);
    let eventCountAfterFirst: number;
    let fileCountAfterFirst: number;
    try {
      eventCountAfterFirst = eventsFor(dbAfterFirst, runId).length;
    } finally {
      dbAfterFirst.close();
    }
    fileCountAfterFirst = fs.readdirSync(answersDirFor(dir, runId)).length;

    const io2 = ioAt(dir);
    const second = await main(["node", "orga", "run", "answer", runId, "--file", answersPath], io2);
    assert.equal(second, EXIT_CODES.OK);

    const dbAfterSecond = openStore(dir);
    try {
      assert.equal(eventsFor(dbAfterSecond, runId).length, eventCountAfterFirst);
    } finally {
      dbAfterSecond.close();
    }
    assert.equal(fs.readdirSync(answersDirFor(dir, runId)).length, fileCountAfterFirst);
  });
});

test("an unknown key mixed with a valid key exits 3 and writes nothing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(db, { runId, questions: [makeQuestion("q1", undefined, [runId])] }, 2_000_000);
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const answersPath = writeAnswersFile(dir, "answers.yaml", { q1: "an answer", "no-such-key": "whatever" });
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath], io);
    assert.equal(code, EXIT_CODES.NOT_FOUND);

    assert.equal(fs.existsSync(answersDirFor(dir, runId)), false);

    const dbAfter = openStore(dir);
    try {
      const rows = questionRowsFor(dbAfter, runId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "open");
      assert.equal(eventsFor(dbAfter, runId).length, 0);
    } finally {
      dbAfter.close();
    }
  });
});

test("a key whose rows are all already answered is a no-op, absent from `answered`, alongside a key with an open row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(
        db,
        { runId, questions: [makeQuestion("q-old", undefined, [runId]), makeQuestion("q-new", undefined, [runId])] },
        2_000_000,
      );
    } finally {
      db.close();
    }

    const firstPath = writeAnswersFile(dir, "first.yaml", { "q-old": "first answer" });
    const firstCode = await main(["node", "orga", "run", "answer", runId, "--file", firstPath], ioAt(dir));
    assert.equal(firstCode, EXIT_CODES.OK);

    const io = ioAt(dir);
    const secondPath = writeAnswersFile(dir, "second.yaml", { "q-old": "first answer", "q-new": "second answer" });
    const code = await main(["node", "orga", "run", "answer", runId, "--file", secondPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as { answered: Array<{ questionId: string }> };
    assert.deepEqual(
      output.answered.map((a) => a.questionId),
      ["q-new"],
    );
  });
});

test("a withdrawn-only key is a no-op, not an error", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(db, { runId, questions: [makeQuestion("q-withdrawn", undefined, [runId])] }, 2_000_000);
      withTransaction(db, () => {
        db.prepare(`UPDATE questions SET status = 'withdrawn' WHERE run_id = ?`).run(runId);
      });
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const answersPath = writeAnswersFile(dir, "answers.yaml", { "q-withdrawn": "an answer" });
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as { answered: unknown[] };
    assert.equal(output.answered.length, 0);
    assert.equal(fs.existsSync(answersDirFor(dir, runId)), false);
  });
});

test("a NULL payload row is matched only by reconstructed id, not left unmatched", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      insertTask(db, "task-a-row", runId, "task-a", 1_000_000);
      persistOperatorQuestions(
        db,
        { runId, questions: [makeQuestion("q-null", "task-a", [runId])] },
        2_000_000,
      );
      withTransaction(db, () => {
        db.prepare(`UPDATE questions SET payload = NULL WHERE run_id = ?`).run(runId);
      });
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const answersPath = writeAnswersFile(dir, "answers.yaml", { "q-null": "an answer" });
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as { answered: Array<{ questionId: string; rowIds: string[] }> };
    assert.equal(output.answered.length, 1);
    assert.equal(output.answered[0]!.rowIds.length, 2);
  });
});

test("a nonexistent --file path exits 2, not 4", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const code = await main(
      ["node", "orga", "run", "answer", runId, "--file", path.join(dir, "does-not-exist.yaml")],
      io,
    );
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
  });
});

test("a dialect error in the answers file exits 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
    } finally {
      db.close();
    }

    const answersPath = path.join(dir, "answers.yaml");
    fs.writeFileSync(answersPath, "answers:\n  q1: {}\n");

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
  });
});

test("a non-string answer value exits 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
    } finally {
      db.close();
    }

    const answersPath = path.join(dir, "answers.yaml");
    fs.writeFileSync(answersPath, "answers:\n  q1: 42\n");

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
  });
});

test("a missing `answers` top-level key exits 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
    } finally {
      db.close();
    }

    const answersPath = path.join(dir, "answers.yaml");
    fs.writeFileSync(answersPath, "notAnswers:\n  q1: an answer\n");

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
  });
});

test("unblockedTaskIds is empty while a task's other open question remains, and populated once the last one is answered", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      insertTask(db, "task-a-row", runId, "task-a", 1_000_000);
      persistOperatorQuestions(
        db,
        {
          runId,
          questions: [makeQuestion("q1", "task-a", []), makeQuestion("q2", "task-a", [])],
        },
        2_000_000,
      );
    } finally {
      db.close();
    }

    const firstPath = writeAnswersFile(dir, "first.yaml", { q1: "answer one" });
    const io1 = ioAt(dir);
    const firstCode = await main(["node", "orga", "run", "answer", runId, "--file", firstPath, "--json"], io1);
    assert.equal(firstCode, EXIT_CODES.OK);
    const firstOutput = JSON.parse(io1.outLines[0] as string) as { unblockedTaskIds: string[] };
    assert.deepEqual(firstOutput.unblockedTaskIds, []);

    const secondPath = writeAnswersFile(dir, "second.yaml", { q2: "answer two" });
    const io2 = ioAt(dir);
    const secondCode = await main(["node", "orga", "run", "answer", runId, "--file", secondPath, "--json"], io2);
    assert.equal(secondCode, EXIT_CODES.OK);
    const secondOutput = JSON.parse(io2.outLines[0] as string) as { unblockedTaskIds: string[] };
    assert.deepEqual(secondOutput.unblockedTaskIds, ["task-a-row"]);
  });
});

test("a pre-existing .v1 artifact forces the write to .v2 without overwriting .v1", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(db, { runId, questions: [makeQuestion("q1", undefined, [runId])] }, 2_000_000);
    } finally {
      db.close();
    }

    const answersDir = answersDirFor(dir, runId);
    fs.mkdirSync(answersDir, { recursive: true, mode: 0o700 });
    const preexistingPath = path.join(answersDir, "q1.v1.json");
    fs.writeFileSync(preexistingPath, "{}\n", { mode: 0o600 });

    const io = ioAt(dir);
    const answersPath = writeAnswersFile(dir, "answers.yaml", { q1: "an answer" });
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as { answered: Array<{ artifact: { path: string } }> };
    assert.equal(output.answered[0]!.artifact.path, `.orga/runs/${runId}/answers/q1.v2.json`);
    assert.equal(fs.readFileSync(preexistingPath, "utf8"), "{}\n");
    assert.ok(fs.existsSync(path.join(answersDir, "q1.v2.json")));
  });
});

function seedAnswerableRun(dir: string, runId: string): string {
  const db = openStore(dir);
  try {
    insertRun(db, runId, 1_000_000);
    persistOperatorQuestions(db, { runId, questions: [makeQuestion("q1", undefined, [runId])] }, 2_000_000);
  } finally {
    db.close();
  }
  return writeAnswersFile(dir, `${runId}-answers.yaml`, { q1: "an answer" });
}

test("run answer --json: a live supervisor lease suppresses the spawn and reports a null supervisorPid", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const answersPath = seedAnswerableRun(dir, runId);

    const seedDb = openStore(dir);
    try {
      acquireLease(seedDb, { runId, ownerPid: process.pid, tickIntervalMs: DEFAULT_TICK_INTERVAL_MS, now: () => Date.now() });
    } finally {
      seedDb.close();
    }

    const { spawnFn, callCount } = countingSpawnFn(99999);
    const io = ioAt(dir);
    io.spawnFn = spawnFn;
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(callCount(), 0);

    const output = JSON.parse(io.outLines[0] as string) as { supervisorPid: number | null };
    assert.equal(output.supervisorPid, null);
  });
});

test("run answer --json: a stale supervisor lease triggers a spawn and reports the new pid", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const answersPath = seedAnswerableRun(dir, runId);

    const seedDb = openStore(dir);
    try {
      acquireLease(seedDb, {
        runId,
        ownerPid: process.pid,
        tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
        now: () => Date.now() - (3 * DEFAULT_TICK_INTERVAL_MS + 1000),
      });
    } finally {
      seedDb.close();
    }

    const { spawnFn, callCount } = countingSpawnFn(99999);
    const io = ioAt(dir);
    io.spawnFn = spawnFn;
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(callCount(), 1);

    const output = JSON.parse(io.outLines[0] as string) as { supervisorPid: number | null };
    assert.equal(output.supervisorPid, 99999);
  });
});

test("run answer --json: no supervisor lease triggers a spawn and reports the new pid", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const answersPath = seedAnswerableRun(dir, runId);

    const { spawnFn, callCount } = countingSpawnFn(99999);
    const io = ioAt(dir);
    io.spawnFn = spawnFn;
    const code = await main(["node", "orga", "run", "answer", runId, "--file", answersPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(callCount(), 1);

    const output = JSON.parse(io.outLines[0] as string) as { supervisorPid: number | null };
    assert.equal(output.supervisorPid, 99999);
  });
});

test("run answer --json --no-supervisor: never spawns and reports a null supervisorPid, for every lease state", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    const leaseSeeders: Array<(seedDb: ReturnType<typeof openStore>, runId: string) => void> = [
      (seedDb, runId) =>
        acquireLease(seedDb, { runId, ownerPid: process.pid, tickIntervalMs: DEFAULT_TICK_INTERVAL_MS, now: () => Date.now() }),
      (seedDb, runId) =>
        acquireLease(seedDb, {
          runId,
          ownerPid: process.pid,
          tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
          now: () => Date.now() - (3 * DEFAULT_TICK_INTERVAL_MS + 1000),
        }),
      () => {},
    ];

    for (const [index, seedLease] of leaseSeeders.entries()) {
      const runId = `run-${index}`;
      const answersPath = seedAnswerableRun(dir, runId);

      const seedDb = openStore(dir);
      try {
        seedLease(seedDb, runId);
      } finally {
        seedDb.close();
      }

      const { spawnFn, callCount } = countingSpawnFn(99999);
      const io = ioAt(dir);
      io.spawnFn = spawnFn;
      const code = await main(
        ["node", "orga", "run", "answer", runId, "--file", answersPath, "--json", "--no-supervisor"],
        io,
      );
      assert.equal(code, EXIT_CODES.OK);
      assert.equal(callCount(), 0);

      const output = JSON.parse(io.outLines[0] as string) as { supervisorPid: number | null };
      assert.equal(output.supervisorPid, null);
    }
  });
});

test("an unknown run id exits 3 before the answers file is read", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const io = ioAt(dir);
    const code = await main(
      ["node", "orga", "run", "answer", "no-such-run", "--file", path.join(dir, "also-missing.yaml")],
      io,
    );
    assert.equal(code, EXIT_CODES.NOT_FOUND);
  });
});

test("missing <run-id> or --file exits 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const noRunId = await main(["node", "orga", "run", "answer", "--file", "x.yaml"], ioAt(dir));
    assert.equal(noRunId, EXIT_CODES.INVALID_ARGS);

    const noFile = await main(["node", "orga", "run", "answer", "run-1"], ioAt(dir));
    assert.equal(noFile, EXIT_CODES.INVALID_ARGS);
  });
});

test("the inline form answers a fanned-out question (task row plus run row) exactly like --file", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      insertTask(db, "task-a-row", runId, "task-a", 1_000_000);
      persistOperatorQuestions(
        db,
        { runId, questions: [makeQuestion("q1", "task-a", [runId])] },
        2_000_000,
      );
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "q1", "use option A", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as {
      answered: Array<{ questionId: string; rowIds: string[] }>;
      skippedQuestions: string[];
    };
    assert.equal(output.answered.length, 1);
    assert.equal(output.answered[0]!.questionId, "q1");
    assert.equal(output.answered[0]!.rowIds.length, 2);
    assert.deepEqual(output.skippedQuestions, []);

    const dbAfter = openStore(dir);
    try {
      const rows = questionRowsFor(dbAfter, runId);
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.status, "answered");
        assert.equal(row.answer, "use option A");
      }
    } finally {
      dbAfter.close();
    }
  });
});

test("--file and --accept-defaults given together exits 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const io = ioAt(dir);
    const code = await main(
      ["node", "orga", "run", "answer", "run-1", "--file", "x.yaml", "--accept-defaults"],
      io,
    );
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
  });
});

test("one, three, or four positionals with neither --file nor --accept-defaults each exit 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const io = ioAt(dir);

    const onePositional = await main(["node", "orga", "run", "answer", runId, "q1"], io);
    assert.equal(onePositional, EXIT_CODES.INVALID_ARGS);

    const threePositionals = await main(["node", "orga", "run", "answer", runId, "q1", "text", "extra"], io);
    assert.equal(threePositionals, EXIT_CODES.INVALID_ARGS);

    const fourPositionals = await main(
      ["node", "orga", "run", "answer", runId, "q1", "text", "extra1", "extra2"],
      io,
    );
    assert.equal(fourPositionals, EXIT_CODES.INVALID_ARGS);
  });
});

test("--file with extra positionals beyond <run-id> is accepted and the extras are ignored", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const answersPath = seedAnswerableRun(dir, runId);

    const io = ioAt(dir);
    const code = await main(
      ["node", "orga", "run", "answer", runId, "ignored-1", "ignored-2", "--file", answersPath, "--json"],
      io,
    );
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as { answered: Array<{ questionId: string }> };
    assert.deepEqual(
      output.answered.map((a) => a.questionId),
      ["q1"],
    );
  });
});

test("--accept-defaults answers only the open questions with a usable default, and reports the rest as skipped", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(
        db,
        {
          runId,
          questions: [
            makeQuestionWithDefault("q-has-default", undefined, [runId], "the default answer"),
            makeQuestion("q-no-default", undefined, [runId]),
          ],
        },
        2_000_000,
      );
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "--accept-defaults", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as {
      answered: Array<{ questionId: string }>;
      skippedQuestions: string[];
    };
    assert.deepEqual(
      output.answered.map((a) => a.questionId),
      ["q-has-default"],
    );
    assert.deepEqual(output.skippedQuestions, ["q-no-default"]);

    const dbAfter = openStore(dir);
    try {
      const rows = questionRowsFor(dbAfter, runId);
      const answeredRow = rows.find((row) => row.status === "answered");
      assert.equal(answeredRow?.answer, "the default answer");
      const stillOpenRow = rows.find((row) => row.status === "open");
      assert.equal(stillOpenRow?.answer, null);
    } finally {
      dbAfter.close();
    }
  });
});

test("--accept-defaults skips a payload-IS-NULL open row by its own row id, even with a non-NULL safe_default", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    let rowId: string;
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(
        db,
        { runId, questions: [makeQuestionWithDefault("q-null", undefined, [runId], "the default answer")] },
        2_000_000,
      );
      withTransaction(db, () => {
        db.prepare(`UPDATE questions SET payload = NULL WHERE run_id = ?`).run(runId);
      });
      const row = db.prepare(`SELECT id FROM questions WHERE run_id = ?`).get(runId) as { id: string };
      rowId = row.id;
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "--accept-defaults", "--json"], io);
    assert.equal(code, EXIT_CODES.OK);

    const output = JSON.parse(io.outLines[0] as string) as {
      answered: Array<{ questionId: string }>;
      skippedQuestions: string[];
    };
    assert.equal(output.answered.length, 0);
    assert.deepEqual(output.skippedQuestions, [rowId!]);
  });
});

test("--accept-defaults with an empty built answer map takes the early return: exits 0, appends no event, and reports supervisorPid null despite a stale lease", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    const runIdEmpty = "run-empty";
    const dbEmpty = openStore(dir);
    try {
      insertRun(dbEmpty, runIdEmpty, 1_000_000);
    } finally {
      dbEmpty.close();
    }

    const runIdNoDefault = "run-no-default";
    const dbNoDefault = openStore(dir);
    try {
      insertRun(dbNoDefault, runIdNoDefault, 1_000_000);
      persistOperatorQuestions(
        dbNoDefault,
        { runId: runIdNoDefault, questions: [makeQuestion("q1", undefined, [runIdNoDefault])] },
        2_000_000,
      );
    } finally {
      dbNoDefault.close();
    }

    const cases: Array<{ runId: string; expectedSkipped: string[] }> = [
      { runId: runIdEmpty, expectedSkipped: [] },
      { runId: runIdNoDefault, expectedSkipped: ["q1"] },
    ];

    for (const { runId, expectedSkipped } of cases) {
      const seedDb = openStore(dir);
      try {
        acquireLease(seedDb, {
          runId,
          ownerPid: process.pid,
          tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
          now: () => Date.now() - (3 * DEFAULT_TICK_INTERVAL_MS + 1000),
        });
      } finally {
        seedDb.close();
      }

      const eventCountBefore = (() => {
        const db = openStore(dir);
        try {
          return eventsFor(db, runId).length;
        } finally {
          db.close();
        }
      })();

      const { spawnFn, callCount } = countingSpawnFn(99999);
      const io = ioAt(dir);
      io.spawnFn = spawnFn;
      const code = await main(["node", "orga", "run", "answer", runId, "--accept-defaults", "--json"], io);
      assert.equal(code, EXIT_CODES.OK);
      assert.equal(callCount(), 0);

      const output = JSON.parse(io.outLines[0] as string) as {
        answered: unknown[];
        unblockedTaskIds: unknown[];
        reopenedTasks: unknown[];
        skippedTasks: unknown[];
        skippedQuestions: string[];
        supervisorPid: number | null;
      };
      assert.deepEqual(output.answered, []);
      assert.deepEqual(output.unblockedTaskIds, []);
      assert.deepEqual(output.reopenedTasks, []);
      assert.deepEqual(output.skippedTasks, []);
      assert.deepEqual(output.skippedQuestions, expectedSkipped);
      assert.equal(output.supervisorPid, null);

      const dbAfter = openStore(dir);
      try {
        assert.equal(eventsFor(dbAfter, runId).length, eventCountBefore);
      } finally {
        dbAfter.close();
      }
    }
  });
});

test("skippedQuestions is an empty array in --json output for both the --file and inline forms", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    const fileRunId = "run-file";
    const fileAnswersPath = seedAnswerableRun(dir, fileRunId);
    const fileIo = ioAt(dir);
    const fileCode = await main(
      ["node", "orga", "run", "answer", fileRunId, "--file", fileAnswersPath, "--json"],
      fileIo,
    );
    assert.equal(fileCode, EXIT_CODES.OK);
    const fileOutput = JSON.parse(fileIo.outLines[0] as string) as { skippedQuestions: string[] };
    assert.deepEqual(fileOutput.skippedQuestions, []);

    const inlineRunId = "run-inline";
    const db = openStore(dir);
    try {
      insertRun(db, inlineRunId, 1_000_000);
      persistOperatorQuestions(
        db,
        { runId: inlineRunId, questions: [makeQuestion("q1", undefined, [inlineRunId])] },
        2_000_000,
      );
    } finally {
      db.close();
    }
    const inlineIo = ioAt(dir);
    const inlineCode = await main(
      ["node", "orga", "run", "answer", inlineRunId, "q1", "an answer", "--json"],
      inlineIo,
    );
    assert.equal(inlineCode, EXIT_CODES.OK);
    const inlineOutput = JSON.parse(inlineIo.outLines[0] as string) as { skippedQuestions: string[] };
    assert.deepEqual(inlineOutput.skippedQuestions, []);
  });
});

test("human-readable output prints the skipped-defaults line only when skippedQuestions is non-empty", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const runId = "run-1";
    const db = openStore(dir);
    try {
      insertRun(db, runId, 1_000_000);
      persistOperatorQuestions(
        db,
        {
          runId,
          questions: [
            makeQuestionWithDefault("q-has-default", undefined, [runId], "the default answer"),
            makeQuestion("q-no-default", undefined, [runId]),
          ],
        },
        2_000_000,
      );
    } finally {
      db.close();
    }

    const io = ioAt(dir);
    const code = await main(["node", "orga", "run", "answer", runId, "--accept-defaults"], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.ok(io.outLines.includes("skipped (no answerable default): q-no-default"));

    const fileRunId = "run-2";
    const fileAnswersPath = seedAnswerableRun(dir, fileRunId);
    const fileIo = ioAt(dir);
    const fileCode = await main(["node", "orga", "run", "answer", fileRunId, "--file", fileAnswersPath], fileIo);
    assert.equal(fileCode, EXIT_CODES.OK);
    assert.ok(!fileIo.outLines.some((line) => line.startsWith("skipped (no answerable default)")));
  });
});
