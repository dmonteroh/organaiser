import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { main } from "../bin/orga.ts";
import { EXIT_CODES, runStateToExitCode } from "../src/cli/exit-codes.ts";
import { initProject } from "../src/store/init.ts";
import { openStore } from "../src/store/db.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";
import { exitLine, outputLine, reportLine, writeFileLine, writeStream } from "../evals/fixtures/harness.ts";
import type { Io } from "../src/cli/commands.ts";
import type { RunRow } from "../src/store/types.ts";

// Copied local board builder per this repo's established convention (see
// `test/cli.test.ts`, `test/run-start-materialization.test.ts`): each test
// file that needs to build a board keeps its own copy rather than importing
// one across test files.
function minimalBoard(tasks: unknown[]): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: { tasks },
  };
}

function writeBoard(dir: string, tasks: unknown[]): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(minimalBoard(tasks), null, 2));
  return boardPath;
}

interface TaskOverrides {
  id: string;
  title?: string;
  briefPath?: string;
  workflowId?: string;
  stageId?: string;
  dependencies?: string[];
  priority?: number;
  claims?: unknown;
  enabled?: boolean;
}

function buildTask(overrides: TaskOverrides): Record<string, unknown> {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    briefPath: overrides.briefPath ?? "brief.md",
    entry: { workflowId: overrides.workflowId ?? "wf1", stageId: overrides.stageId ?? "analyst-initial" },
    dependencies: overrides.dependencies ?? [],
    priority: overrides.priority ?? 0,
    requiredWorkflowVersions: {},
    claims: overrides.claims ?? "unknown",
    verification: [],
    enabled: overrides.enabled ?? true,
  };
}

function boardAndPath(dir: string, tasks: unknown[]): { boardPath: string } {
  const boardPath = writeBoard(dir, tasks);
  return { boardPath };
}

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

// The fake dispatch route resolves its working directory to the real
// process.cwd() whenever no WorkspaceProvider is configured, so any marker a
// scripted stream writes lands under the real process.cwd(), not this test's
// temp workspace, and must be addressed (and cleaned up) there.
function markerPaths(): { relPath: string; absPath: string } {
  const relPath = path.join(".orga", "run-start-materialization-e2e-tmp", randomUUID(), "marker.txt");
  return { relPath, absPath: path.join(process.cwd(), relPath) };
}

const TASK_ID = "task-e2e";
const MARKER_TEXT = "materialized task wrote this file\n";

test("orga run start --foreground materializes a board task and its scripted worker's file write lands on disk", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);

    // The implementer dispatch path resolves briefPath against
    // process.resolve(projectRoot, briefPath) with no fallback and no
    // try/catch; an absolute path makes that resolution independent of
    // which directory is treated as the project root.
    const briefPath = path.join(dir, "brief.md");
    fs.writeFileSync(
      briefPath,
      ["# Task Brief", "", "## Acceptance Criteria", "", "- [ ] The scripted implementer writes the marker file.", ""].join(
        "\n",
      ),
    );

    const task = buildTask({
      id: TASK_ID,
      briefPath,
      dependencies: [],
      claims: "unknown",
      // board-enabled-waiver: this test verifies that a genuinely enabled task materializes and its scripted worker's file write lands on disk, so enabled must be true here.
      enabled: true,
    });
    const { boardPath } = boardAndPath(dir, [task]);

    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-e2e-streams-"));
    const marker = markerPaths();

    // ORGA_FAKE_STREAMS_DIR and ORGA_VENDOR are read from the real
    // process.env by the production dispatch path (fakeIo's own `env` field
    // is inert for both), and process-global env is not isolated across
    // files under `node --test`, so both must be saved and restored to
    // their exact prior value rather than blindly deleted.
    const priorStreamsDir = process.env.ORGA_FAKE_STREAMS_DIR;
    const priorVendor = process.env.ORGA_VENDOR;
    process.env.ORGA_FAKE_STREAMS_DIR = streamsDir;
    delete process.env.ORGA_VENDOR;

    let runId: string | undefined;
    let db: ReturnType<typeof openStore> | undefined;
    try {
      writeStream(streamsDir, "implement", TASK_ID, [
        outputLine("implementing"),
        writeFileLine(marker.relPath, MARKER_TEXT),
        reportLine({ taskId: TASK_ID, stageId: "implement", roleId: "implementer", status: "completed" }),
        exitLine(0),
      ]);
      // Reviewer reports carry both `status: "completed"` (required by the
      // report schema) and `verdict` (the field the driver actually reads
      // for any non-implementer role); a report missing either parks the
      // run instead of completing it. Neither report includes a `findings`
      // key: a non-empty minor partition would resolve a follow-ups file
      // write against the real process.cwd(), not this test's temp
      // workspace.
      writeStream(streamsDir, "review-spec", TASK_ID, [
        outputLine("reviewing spec"),
        reportLine({
          taskId: TASK_ID,
          stageId: "review-spec",
          roleId: "spec-reviewer",
          status: "completed",
          verdict: "pass",
        }),
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
      writeStream(streamsDir, "integration", TASK_ID, [
        outputLine("integrating"),
        reportLine({ taskId: TASK_ID, stageId: "integration", roleId: "integrator", status: "completed" }),
        exitLine(0),
      ]);

      const io = ioAt(dir);
      const code = await main(
        ["node", "orga", "run", "start", "--board", boardPath, "--foreground", "--json"],
        io,
      );

      assert.equal(io.outLines.length, 1, "exactly one stdout line after the run rests");
      const run = JSON.parse(io.outLines[0] as string) as RunRow;
      runId = run.id;

      // The file the task's scripted worker wrote genuinely exists on
      // disk; this, not the run's terminal state, is what this test exists
      // to prove.
      assert.equal(
        fs.readFileSync(marker.absPath, "utf8"),
        MARKER_TEXT,
        "the implement stage's write-file op must land on disk",
      );

      db = openStore(dir);

      const attempts = db
        .prepare(`SELECT stage_id, role, vendor, status FROM attempts WHERE run_id = ? ORDER BY created_at`)
        .all(run.id) as Array<{ stage_id: string; role: string; vendor: string; status: string }>;

      const implementAttempt = attempts.find((a) => a.stage_id === "implement");
      assert.ok(implementAttempt, "an attempts row must exist for stage_id = implement");
      assert.equal(implementAttempt?.role, "implementer");
      assert.equal(implementAttempt?.vendor, "fake");
      assert.equal(implementAttempt?.status, "completed");

      const reviewSpecAttempt = attempts.find((a) => a.stage_id === "review-spec");
      assert.ok(reviewSpecAttempt, "an attempts row must exist for stage_id = review-spec");
      assert.equal(reviewSpecAttempt?.role, "spec-reviewer");

      const reviewQualityAttempt = attempts.find((a) => a.stage_id === "review-quality");
      assert.ok(reviewQualityAttempt, "an attempts row must exist for stage_id = review-quality");
      assert.equal(reviewQualityAttempt?.role, "code-quality-reviewer");

      const integrationAttempt = attempts.find((a) => a.stage_id === "integration");
      assert.ok(integrationAttempt, "an attempts row must exist for stage_id = integration");
      assert.equal(integrationAttempt?.role, "integrator");
      assert.equal(integrationAttempt?.status, "completed");

      assert.equal(
        attempts.filter((a) => a.stage_id === "implementation").length,
        0,
        "the aggregate board stage 'implementation' never itself produces an attempts row",
      );

      const events = db
        .prepare(
          `SELECT payload FROM events WHERE run_id = ? AND task_id = ? AND type = 'task.transitioned' ORDER BY seq`,
        )
        .all(run.id, TASK_ID) as Array<{ payload: string }>;
      const targets = events.map((event) => (JSON.parse(event.payload) as { target: string }).target);
      assert.deepEqual(targets, [
        "release-dependencies",
        "acquire-claims",
        "admit-to-batch",
        "product-specification",
        "task-refinement",
        "implementation",
        "integration-candidate",
        "integration",
        "reconcile-outcome",
        "integrated",
      ]);

      // The terminal branch of applyTransition sets stage_id back to NULL,
      // so the board-stage walk must be read from the event log, not
      // inferred from the final tasks row.
      const finalTask = db.prepare(`SELECT disposition, stage_id FROM tasks WHERE id = ?`).get(TASK_ID) as {
        disposition: string | null;
        stage_id: string | null;
      };
      assert.equal(finalTask.disposition, "integrated");
      assert.equal(finalTask.stage_id, null);

      assert.equal(run.state, "succeeded");
      assert.equal(code, EXIT_CODES.OK);
      assert.equal(runStateToExitCode(run.state), code);
    } finally {
      if (priorStreamsDir === undefined) delete process.env.ORGA_FAKE_STREAMS_DIR;
      else process.env.ORGA_FAKE_STREAMS_DIR = priorStreamsDir;
      if (priorVendor === undefined) delete process.env.ORGA_VENDOR;
      else process.env.ORGA_VENDOR = priorVendor;

      db?.close();
      fs.rmSync(streamsDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(marker.absPath), { recursive: true, force: true });
      // The barrier's evidence ledger and dispatch log write under
      // <process.cwd()>/.orga/runs/<runId>, the real process's own cwd, not
      // this test's temp workspace, because no WorkspaceProvider is
      // configured on this path.
      if (runId) {
        fs.rmSync(path.join(process.cwd(), ".orga", "runs", runId), { recursive: true, force: true });
      }
    }
  });
});
