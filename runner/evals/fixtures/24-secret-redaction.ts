// Fixture: secret-redaction.
//
// A distinctive literal secret is declared through a project `orga.yaml`
// `redaction:` block, seeded into a task's title, and echoed by the fake
// worker on its stream and in its report. The task is driven through the
// full `dev-workflow` pipeline (implement, review-spec, review-quality,
// cross-task-review) to a terminal `integrated` disposition on the fake
// adapter under `in-place` workspace mode, exercising the three real write
// boundaries under `.orga/runs/<runId>/`: `mirrorEvent` (events.jsonl),
// `writeLedger` (tasks/<taskId>/ledger.json), and `writeAtomic` (BOARD.md,
// rendered directly since this harness's own `test-supervisor.ts` never
// threads a `renderRoot` through `createSchedulerTick`). Every file found
// anywhere under the completed run tree, with no per-file exclusions, must
// carry no trace of the raw secret.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  startFixtureRun,
  readTaskRow,
  spawnFixtureSupervisor,
  writeStream,
  reportLine,
  outputLine,
  exitLine,
  writeFileLine,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";
import { initProject } from "../../src/store/init.ts";
import { renderBoard } from "../../src/board/render.ts";

const TICK_INTERVAL_MS = 100;
const SECRET = "ORGA-FIXTURE-SECRET-7f3c9a1e";
const SECRET_PATTERN = "ORGA-FIXTURE-SECRET-[0-9a-f]+";
const TASK_ID = "task-a";
const CLAIMED_FILE = "task-a.txt";

function appendRedactionBlock(dir: string): void {
  const orgaYamlPath = path.join(dir, "orga.yaml");
  const existing = fs.readFileSync(orgaYamlPath, "utf8");
  const block = ["redaction:", "  secretPatterns:", `    - ${SECRET_PATTERN}`, ""].join("\n");
  fs.writeFileSync(orgaYamlPath, `${existing}${block}`);
}

function gitCapture(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

// A `startGitFixtureRun`-equivalent setup with the project's own
// `redaction:` block appended and committed before the first event of the
// run (`run.created`) is ever mirrored: `redactorForRoot` memoizes by
// resolved root for the life of the process, so a redaction config written
// after that first mirror call would never take effect for this run.
function startGitFixtureRunWithRedaction(
  dir: string,
  tasks: Parameters<typeof startFixtureRun>[1],
): ReturnType<typeof startFixtureRun> {
  gitCapture(dir, ["init", "-q"]);
  gitCapture(dir, ["config", "commit.gpgsign", "false"]);
  gitCapture(dir, ["config", "user.name", "Fixture Operator"]);
  gitCapture(dir, ["config", "user.email", "fixture-operator@example.com"]);

  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n", "utf8");
  gitCapture(dir, ["add", "--", "seed.txt"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);

  initProject(dir);
  appendRedactionBlock(dir);

  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);

  return startFixtureRun(dir, tasks);
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

export async function secretRedaction(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();

    const title = `leaks ${SECRET} unless redacted`;
    const { runId } = startGitFixtureRunWithRedaction(dir, [{ id: TASK_ID, title }]);

    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));
    try {
      const now = Date.now();
      const briefPath = path.join(dir, "brief.md");
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(TASK_ID, runId, TASK_ID, title, briefPath, "dev-workflow", "implementation", "[]", 0, "implementing", null, now, now);
          db.prepare(
            `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(`claim-${TASK_ID}`, runId, TASK_ID, "files", JSON.stringify([CLAIMED_FILE]), now);
        });
      } finally {
        db.close();
      }

      writeStream(streamsDir, "implement", TASK_ID, [
        outputLine(`working, internal note: ${SECRET}`),
        writeFileLine(CLAIMED_FILE, "task-a content\n"),
        reportLine({
          taskId: TASK_ID,
          stageId: "implement",
          roleId: "implementer",
          status: "completed",
          summary: `Implemented the change. Debug value: ${SECRET}`,
        }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "review-spec", TASK_ID, [
        outputLine("reviewing the spec"),
        reportLine({ taskId: TASK_ID, stageId: "review-spec", roleId: "spec-reviewer", status: "completed", verdict: "pass" }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "review-quality", TASK_ID, [
        outputLine("reviewing quality"),
        reportLine({
          taskId: TASK_ID,
          stageId: "review-quality",
          roleId: "code-quality-reviewer",
          status: "completed",
          verdict: "pass",
        }),
        exitLine(0),
      ]);
      writeStream(streamsDir, "cross-task-review", TASK_ID, [
        outputLine("cross-task reviewing"),
        reportLine({
          taskId: TASK_ID,
          stageId: "cross-task-review",
          roleId: "code-quality-reviewer",
          status: "completed",
          verdict: "pass",
        }),
        exitLine(0),
      ]);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
        workspaceMode: "in-place",
      });
      registry.track(supervisor.pid);

      const integrated = await waitFor(() => readTaskRow(dir, TASK_ID)?.disposition === "integrated", 20000);
      assert.ok(
        integrated,
        `task ${TASK_ID} must reach disposition "integrated"; row=${JSON.stringify(readTaskRow(dir, TASK_ID))}`,
      );

      registry.killAll();
      await registry.allDead();

      const runTreeRoot = path.join(dir, ".orga", "runs", runId);
      const eventsPath = path.join(runTreeRoot, "events.jsonl");
      const ledgerPath = path.join(runTreeRoot, "tasks", TASK_ID, "ledger.json");
      const supervisorLogPath = path.join(runTreeRoot, "supervisor.log");
      const supervisorPidPath = path.join(runTreeRoot, "supervisor.pid");
      for (const requiredPath of [eventsPath, ledgerPath, supervisorLogPath, supervisorPidPath]) {
        assert.ok(fs.existsSync(requiredPath), `expected write boundary output missing: ${requiredPath}`);
      }

      const boardPath = renderBoard(dir, runId);
      const boardContent = fs.readFileSync(boardPath, "utf8");
      assert.ok(!boardContent.includes(SECRET), "BOARD.md must not contain the raw secret literal");
      assert.ok(
        boardContent.includes("[REDACTED]"),
        "BOARD.md must show the redacted placeholder in place of the secret-bearing task title",
      );

      const files = collectFiles(runTreeRoot);
      assert.ok(files.length > 0, "the completed run tree must contain at least one file to scan");
      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        assert.ok(
          !content.includes(SECRET),
          `${path.relative(runTreeRoot, file)} must not contain the raw secret literal anywhere under the completed run tree`,
        );
      }
    } finally {
      registry.killAll();
      await registry.allDead();
      fs.rmSync(streamsDir, { recursive: true, force: true });
    }
  });
}
