// Regenerates the fake-adapter board run committed under
// `examples/runner/board-run/.orga/runs/<runId>/`. Every filesystem write
// this script hands to the runner (project directory, store, workspace,
// streams directory, supervisor log) lives under `os.tmpdir()`; the only
// writes into this checkout are the final allowlisted copies into
// `examples/runner/board-run/`. `runId` is generated fresh on every run, so
// the destination's prior `.orga/runs/` contents are replaced, not merged.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProcessRegistry,
  waitFor,
  startGitFixtureRun,
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
  type FixtureTaskSpec,
} from "../evals/fixtures/harness.ts";
import { renderBoard } from "../src/board/render.ts";

const TICK_INTERVAL_MS = 100;
const TASK_WAIT_TIMEOUT_MS = 60000;

interface ExampleTask {
  readonly id: string;
  readonly briefPath: string;
  readonly claimedFile: string;
  readonly dependsOn: readonly string[];
}

const BLOCKER: ExampleTask = {
  id: "task-blocker",
  briefPath: "task-blocker-brief.md",
  claimedFile: "task-blocker.txt",
  dependsOn: [],
};

const DEPENDENT: ExampleTask = {
  id: "task-dependent",
  briefPath: "task-dependent-brief.md",
  claimedFile: "task-dependent.txt",
  dependsOn: [BLOCKER.id],
};

const TASKS: readonly ExampleTask[] = [BLOCKER, DEPENDENT];

const ATTEMPT_ARTIFACT_FILENAMES = [
  "dispatch-log.tsv",
  "spec-reviewer.report.txt",
  "quality-reviewer.report.txt",
] as const;

function seedTaskRows(dir: string, runId: string, now: number): void {
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      for (const task of TASKS) {
        db.prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          runId,
          task.id,
          task.id,
          path.join(dir, task.briefPath),
          "dev-workflow",
          "implementation",
          JSON.stringify(task.dependsOn),
          0,
          "implementing",
          null,
          now,
          now,
        );
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(`claim-${task.id}`, runId, task.id, "files", JSON.stringify([task.claimedFile]), now);
      }
    });
  } finally {
    db.close();
  }
}

function writeTaskStreams(streamsDir: string, task: ExampleTask): void {
  writeStream(streamsDir, "implement", task.id, [
    outputLine(`working on ${task.id}`),
    writeFileLine(task.claimedFile, `${task.id} content\n`),
    reportLine({
      taskId: task.id,
      stageId: "implement",
      roleId: "implementer",
      status: "completed",
      summary: `Implemented ${task.id}.`,
    }),
    exitLine(0),
  ]);
  writeStream(streamsDir, "review-spec", task.id, [
    outputLine("reviewing the spec"),
    reportLine({ taskId: task.id, stageId: "review-spec", roleId: "spec-reviewer", status: "completed", verdict: "pass" }),
    exitLine(0),
  ]);
  writeStream(streamsDir, "review-quality", task.id, [
    outputLine("reviewing quality"),
    reportLine({
      taskId: task.id,
      stageId: "review-quality",
      roleId: "code-quality-reviewer",
      status: "completed",
      verdict: "pass",
    }),
    exitLine(0),
  ]);
  writeStream(streamsDir, "cross-task-review", task.id, [
    outputLine("cross-task reviewing"),
    reportLine({
      taskId: task.id,
      stageId: "cross-task-review",
      roleId: "code-quality-reviewer",
      status: "completed",
      verdict: "pass",
    }),
    exitLine(0),
  ]);
}

function assertExactAttemptArtifacts(attemptDir: string): void {
  const entries = fs.readdirSync(attemptDir).sort();
  const expected = [...ATTEMPT_ARTIFACT_FILENAMES].sort();
  assert.deepStrictEqual(
    entries,
    expected,
    `${attemptDir} must hold exactly ${expected.join(", ")}; found ${entries.join(", ") || "(empty)"}`,
  );
}

function copyRunTree(runTreeRoot: string, destinationRunRoot: string): void {
  fs.mkdirSync(destinationRunRoot, { recursive: true });
  fs.copyFileSync(path.join(runTreeRoot, "BOARD.md"), path.join(destinationRunRoot, "BOARD.md"));
  fs.copyFileSync(path.join(runTreeRoot, "events.jsonl"), path.join(destinationRunRoot, "events.jsonl"));

  for (const task of TASKS) {
    const sourceTaskDir = path.join(runTreeRoot, "tasks", task.id);
    const sourceAttemptDir = path.join(sourceTaskDir, "attempt1-artifacts");
    assertExactAttemptArtifacts(sourceAttemptDir);

    const destTaskDir = path.join(destinationRunRoot, "tasks", task.id);
    const destAttemptDir = path.join(destTaskDir, "attempt1-artifacts");
    fs.mkdirSync(destAttemptDir, { recursive: true });

    fs.copyFileSync(path.join(sourceTaskDir, "ledger.json"), path.join(destTaskDir, "ledger.json"));
    for (const filename of ATTEMPT_ARTIFACT_FILENAMES) {
      fs.copyFileSync(path.join(sourceAttemptDir, filename), path.join(destAttemptDir, filename));
    }
  }
}

async function regenerate(destinationBoardRunDir: string): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();

    const fixtureTasks: FixtureTaskSpec[] = TASKS.map((task) => ({
      id: task.id,
      briefPath: task.briefPath,
      dependsOn: task.dependsOn,
    }));
    const { runId } = startGitFixtureRun(dir, fixtureTasks);

    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-runner-example-streams-"));
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-runner-example-logs-"));
    try {
      seedTaskRows(dir, runId, Date.now());
      for (const task of TASKS) writeTaskStreams(streamsDir, task);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
        workspaceMode: "in-place",
        logPath: path.join(logsDir, "supervisor.log"),
      });
      registry.track(supervisor.pid);

      for (const task of TASKS) {
        const integrated = await waitFor(
          () => readTaskRow(dir, task.id)?.disposition === "integrated",
          TASK_WAIT_TIMEOUT_MS,
        );
        assert.ok(
          integrated,
          `task ${task.id} must reach disposition "integrated"; row=${JSON.stringify(readTaskRow(dir, task.id))}`,
        );
      }

      registry.killAll();
      await registry.allDead();

      renderBoard(dir, runId);

      const runTreeRoot = path.join(dir, ".orga", "runs", runId);
      fs.rmSync(path.join(destinationBoardRunDir, ".orga"), { recursive: true, force: true });
      const destinationRunRoot = path.join(destinationBoardRunDir, ".orga", "runs", runId);
      copyRunTree(runTreeRoot, destinationRunRoot);
    } finally {
      registry.killAll();
      await registry.allDead();
      fs.rmSync(streamsDir, { recursive: true, force: true });
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

export async function main(): Promise<void> {
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const destinationBoardRunDir = path.join(repoRoot, "examples", "runner", "board-run");
  await regenerate(destinationBoardRunDir);
  process.stdout.write(`regenerated ${path.relative(repoRoot, destinationBoardRunDir)}\n`);
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
