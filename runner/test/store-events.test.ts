import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { openStore, withTransaction } from "../src/store/db.ts";
import { appendEvent, mirrorEvent, eventsJsonlPath, EventTransactionError } from "../src/store/events.ts";
import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const DB_MODULE_URL = new URL("../src/store/db.ts", import.meta.url).href;
const EVENTS_MODULE_URL = new URL("../src/store/events.ts", import.meta.url).href;

function insertRun(db: ReturnType<typeof openStore>, runId: string): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "starting", Date.now());
  });
}

test("appendEvent throws when called outside an open transaction", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1");
      assert.throws(
        () =>
          appendEvent(db, {
            id: "evt-1",
            run_id: "run-1",
            type: "test",
            payload: "{}",
            created_at: Date.now(),
          }),
        EventTransactionError,
      );
    } finally {
      db.close();
    }
  });
});

test("appendEvent assigns strictly increasing seq per run_id inside the caller's transaction", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1");
      const seqs: number[] = [];
      for (let i = 0; i < 5; i++) {
        withTransaction(db, () => {
          const row = appendEvent(db, {
            id: `evt-${i}`,
            run_id: "run-1",
            type: "test",
            payload: "{}",
            created_at: Date.now(),
          });
          seqs.push(row.seq);
        });
      }
      assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
    } finally {
      db.close();
    }
  });
});

test("mirrorEvent appends a JSON line matching the table row; a rolled-back transaction writes no line", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1");

      let committedRow: ReturnType<typeof appendEvent> | undefined;
      withTransaction(db, () => {
        committedRow = appendEvent(db, {
          id: "evt-committed",
          run_id: "run-1",
          type: "test",
          payload: "{}",
          created_at: Date.now(),
        });
      });
      mirrorEvent(dir, committedRow!);

      assert.throws(() => {
        withTransaction(db, () => {
          appendEvent(db, {
            id: "evt-rolled-back",
            run_id: "run-1",
            type: "test",
            payload: "{}",
            created_at: Date.now(),
          });
          throw new Error("boom");
        });
      }, /boom/);

      const filePath = eventsJsonlPath(dir, "run-1");
      const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.seq, 1);
      assert.equal(parsed.id, "evt-committed");

      const tableRows = db.prepare("SELECT * FROM events WHERE run_id = ?").all("run-1") as Array<{
        seq: number;
      }>;
      assert.equal(tableRows.length, 1);
      assert.equal(tableRows[0].seq, 1);

      const fileMode = fs.statSync(filePath).mode & 0o777;
      assert.equal(fileMode, 0o600);
      const dirMode = fs.statSync(path.dirname(filePath)).mode & 0o777;
      assert.equal(dirMode, 0o700);
    } finally {
      db.close();
    }
  });
});

function runWorker(dir: string, runId: string, prefix: string, count: number): Promise<void> {
  const code = `
    import { openStore, withTransaction } from ${JSON.stringify(DB_MODULE_URL)};
    import { appendEvent } from ${JSON.stringify(EVENTS_MODULE_URL)};
    const db = openStore(${JSON.stringify(dir)});
    for (let i = 0; i < ${count}; i++) {
      withTransaction(db, () => {
        appendEvent(db, {
          id: ${JSON.stringify(prefix)} + "-" + i,
          run_id: ${JSON.stringify(runId)},
          type: "concurrent-test",
          payload: "{}",
          created_at: Date.now(),
        });
      });
    }
    db.close();
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited ${code}: ${stderr}`));
    });
    child.on("error", reject);
  });
}

test("seq is race-safe across two concurrent connections: no gap, no duplicate, no interleave", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    insertRun(db, "run-1");
    db.close();

    const perWorker = 25;
    await Promise.all([
      runWorker(dir, "run-1", "a", perWorker),
      runWorker(dir, "run-1", "b", perWorker),
    ]);

    const verifyDb = openStore(dir);
    try {
      const rows = verifyDb
        .prepare("SELECT seq FROM events WHERE run_id = ? ORDER BY seq ASC")
        .all("run-1") as Array<{ seq: number }>;
      const seqs = rows.map((r) => r.seq);
      const expected = Array.from({ length: perWorker * 2 }, (_, i) => i + 1);
      assert.deepEqual(seqs, expected, "seq values must be exactly 1..N with no gap or duplicate");
    } finally {
      verifyDb.close();
    }
  });
});
