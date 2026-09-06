import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { MIGRATIONS, applyMigrations, appliedMigrationVersions } from "../src/store/migrations.ts";
import {
  appendMinorFindings,
  claimMinorFindingsAppend,
  writeMinorFindingsFile,
  DEFAULT_FOLLOWUPS_FILE_PATH,
  type MinorFinding,
} from "../src/engine/minor-findings.ts";
import { loadConfig } from "../src/cli/config.ts";
import { resolveRecordMinors, type DevelopmentStageInput } from "../src/engine/workflow-stages.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const RUN_ID = "run-1";
const TASK_ID = "task-1";

function schemaMigrationVersions(db: DatabaseSync): number[] {
  return (
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>
  ).map((row) => row.version);
}

// ── migration version 2 ───────────────────────────────────────────────────

test("a store initialized from empty reaches version 2", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      assert.deepEqual(
        schemaMigrationVersions(db),
        MIGRATIONS.map((m) => m.version),
      );
      const index = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'minor_finding_appends_idempotency_key'`,
        )
        .all();
      assert.equal(index.length, 1);
      const table = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'minor_finding_appends'`)
        .all();
      assert.equal(table.length, 1);
    } finally {
      db.close();
    }
  });
});

test("a store already at version 1 migrates to 2 without data loss", async () => {
  await withTempWorkspace(async (dir) => {
    const dbPath = path.join(dir, "state.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(MIGRATIONS[0]!.up);
      appliedMigrationVersions(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, Date.now());
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(RUN_ID, "board.yaml", "running", "starting", Date.now());
      });

      applyMigrations(db);

      assert.deepEqual(
        schemaMigrationVersions(db),
        MIGRATIONS.map((m) => m.version),
      );
      const runs = db.prepare("SELECT id FROM runs").all() as Array<{ id: string }>;
      assert.deepEqual(
        runs.map((row) => row.id),
        [RUN_ID],
      );
      const table = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'minor_finding_appends'`)
        .all();
      assert.equal(table.length, 1);
    } finally {
      db.close();
    }
  });
});

// ── idempotent append keyed by (run, task, attempt) ─────────────────────

function countAppendRows(db: DatabaseSync, attemptId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ?`,
    )
    .get(RUN_ID, TASK_ID, attemptId) as { n: number };
  return row.n;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("appendMinorFindings called twice with the same triple appends once", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const followUpsFilePath = path.join(dir, "FOLLOWUPS.md");
      const findings: MinorFinding[] = [{ summary: "tidy up the helper", path: "src/example.ts", line: 10 }];

      const first = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });
      const second = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });

      assert.equal(first, "true");
      assert.equal(second, "true");
      assert.equal(occurrences(fs.readFileSync(followUpsFilePath, "utf8"), "tidy up the helper"), 1);
      assert.equal(countAppendRows(db, "attempt-1"), 1);
    } finally {
      db.close();
    }
  });
});

test("a different attempt id for the same run and task appends again", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const followUpsFilePath = path.join(dir, "FOLLOWUPS.md");
      const findingsA: MinorFinding[] = [{ summary: "finding from attempt one", path: "src/a.ts" }];
      const findingsB: MinorFinding[] = [{ summary: "finding from attempt two", path: "src/b.ts" }];

      const first = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings: findingsA, followUpsFilePath });
      const second = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-2", findings: findingsB, followUpsFilePath });

      assert.equal(first, "true");
      assert.equal(second, "true");
      const contents = fs.readFileSync(followUpsFilePath, "utf8");
      assert.equal(occurrences(contents, "finding from attempt one"), 1);
      assert.equal(occurrences(contents, "finding from attempt two"), 1);
      assert.equal(countAppendRows(db, "attempt-1"), 1);
      assert.equal(countAppendRows(db, "attempt-2"), 1);
    } finally {
      db.close();
    }
  });
});

// ── crash-safety between the guard row and the file append ──────────────

test("a process that stops after the guard row commits but before the file append still reaches exactly one append on retry", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const followUpsFilePath = path.join(dir, "FOLLOWUPS.md");
      const findings: MinorFinding[] = [{ summary: "crash-safety check", path: "src/example.ts" }];

      // Simulates a process killed exactly between the guard row and the
      // file append: claim the triple and stop, as `appendMinorFindings`'s
      // own first phase would leave things at that exact point.
      const claim = claimMinorFindingsAppend({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1" });
      assert.equal(claim.alreadyAppended, false);
      assert.equal(fs.existsSync(followUpsFilePath), false);

      const retry = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });
      assert.equal(retry, "true");
      assert.equal(occurrences(fs.readFileSync(followUpsFilePath, "utf8"), "crash-safety check"), 1);
      assert.equal(countAppendRows(db, "attempt-1"), 1);

      const retryAgain = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });
      assert.equal(retryAgain, "true");
      assert.equal(occurrences(fs.readFileSync(followUpsFilePath, "utf8"), "crash-safety check"), 1);
      assert.equal(countAppendRows(db, "attempt-1"), 1);
    } finally {
      db.close();
    }
  });
});

test("a process that stops after the file append but before the guard row is marked done still reaches exactly one append on retry", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const followUpsFilePath = path.join(dir, "FOLLOWUPS.md");
      const findings: MinorFinding[] = [{ summary: "write-then-mark crash-safety check", path: "src/example.ts" }];

      // Simulates a process killed exactly between the file write and
      // `markAppended`: claim the triple, write the file, and stop, leaving
      // the guard row at `appended_at IS NULL` even though the file already
      // carries the entry.
      const claim = claimMinorFindingsAppend({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1" });
      assert.equal(claim.alreadyAppended, false);
      writeMinorFindingsFile({ runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });
      assert.equal(occurrences(fs.readFileSync(followUpsFilePath, "utf8"), "write-then-mark crash-safety check"), 1);

      const guardRowBefore = db
        .prepare(`SELECT appended_at FROM minor_finding_appends WHERE id = ?`)
        .get(claim.id) as { appended_at: number | null };
      assert.equal(guardRowBefore.appended_at, null);

      const retry = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });
      assert.equal(retry, "true");
      assert.equal(occurrences(fs.readFileSync(followUpsFilePath, "utf8"), "write-then-mark crash-safety check"), 1);

      const guardRowAfter = db
        .prepare(`SELECT appended_at FROM minor_finding_appends WHERE id = ?`)
        .get(claim.id) as { appended_at: number | null };
      assert.notEqual(guardRowAfter.appended_at, null);
    } finally {
      db.close();
    }
  });
});

// ── failure path ──────────────────────────────────────────────────────────

test("appendMinorFindings returns \"false\" and leaves a recoverable guard row when the write fails", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const blockedParent = path.join(dir, "not-a-directory");
      fs.writeFileSync(blockedParent, "this is a file, not a directory");
      const followUpsFilePath = path.join(blockedParent, "nested", "FOLLOWUPS.md");
      const findings: MinorFinding[] = [{ summary: "unreachable write", path: "src/example.ts" }];

      const result = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath });

      assert.equal(result, "false");
      const guardRow = db
        .prepare(`SELECT appended_at FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ?`)
        .get(RUN_ID, TASK_ID, "attempt-1") as { appended_at: number | null } | undefined;
      assert.ok(guardRow, "the guard row must still exist after a failed write");
      assert.equal(guardRow.appended_at, null);
    } finally {
      db.close();
    }
  });
});

test("resolveRecordMinors returns \"false\" when the configured follow-ups write fails", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    const originalEnv = process.env.ORGA_FOLLOWUPS_FILE;
    try {
      const blockedParent = path.join(dir, "not-a-directory-2");
      fs.writeFileSync(blockedParent, "this is a file, not a directory");
      const followUpsFilePath = path.join(blockedParent, "nested", "FOLLOWUPS.md");
      process.env.ORGA_FOLLOWUPS_FILE = followUpsFilePath;

      const input: DevelopmentStageInput = {
        db,
        adapter: {} as unknown as DevelopmentStageInput["adapter"],
        runId: RUN_ID,
        taskId: TASK_ID,
        now: () => Date.now(),
        taskDir: dir,
        executionRoot: dir,
        requiredArtifacts: [],
        checks: {},
        env: process.env,
      };
      const ctx = {
        input,
        lastAgentAttempt: { attemptId: "attempt-1", pgid: 0 },
        barrierCache: null,
        lastAgentReport: {
          findings: [
            { id: "finding-1", severity: "minor", summary: "resolveRecordMinors failure check", path: "src/example.ts", line: 1 },
          ],
        },
      };

      const result = resolveRecordMinors(input, ctx);
      assert.equal(result, "false");
    } finally {
      if (originalEnv === undefined) delete process.env.ORGA_FOLLOWUPS_FILE;
      else process.env.ORGA_FOLLOWUPS_FILE = originalEnv;
      db.close();
    }
  });
});

test("an empty findings list never claims a row and never touches the file", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const followUpsFilePath = path.join(dir, "FOLLOWUPS.md");
      const result = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings: [], followUpsFilePath });
      assert.equal(result, "true");
      assert.equal(fs.existsSync(followUpsFilePath), false);
      assert.equal(countAppendRows(db, "attempt-1"), 0);
    } finally {
      db.close();
    }
  });
});

// ── the follow-ups file path is configuration, not a hard-coded literal ──

test("the follow-ups file path is whatever the caller's configuration supplies, not a literal inside the module", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const configuredPath = path.join(dir, "custom-followups.md");
      const findings: MinorFinding[] = [{ summary: "configurable path check", path: "src/example.ts" }];

      const result = appendMinorFindings({ db, runId: RUN_ID, taskId: TASK_ID, attemptId: "attempt-1", findings, followUpsFilePath: configuredPath });

      assert.equal(result, "true");
      assert.ok(fs.existsSync(configuredPath));
      assert.equal(fs.existsSync(path.join(dir, DEFAULT_FOLLOWUPS_FILE_PATH)), false);
      const outsideProjectTree = path.resolve(dir, "..", "escaped-followups.md");
      assert.equal(fs.existsSync(outsideProjectTree), false);
    } finally {
      db.close();
    }
  });
});

test("loadConfig's followUpsFilePath defaults to minor-findings.ts's own exported default", () => {
  assert.equal(loadConfig().followUpsFilePath, DEFAULT_FOLLOWUPS_FILE_PATH);
});

test("ORGA_FOLLOWUPS_FILE in the env layer overrides the default follow-ups file path", () => {
  const config = loadConfig({ env: { ORGA_FOLLOWUPS_FILE: "custom/path.md" } });
  assert.equal(config.followUpsFilePath, "custom/path.md");
});
