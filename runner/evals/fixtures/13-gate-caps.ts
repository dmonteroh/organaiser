// Fixture: gate-caps.
//
// Two tasks, priority-ordered: `gate-capped`'s `review-spec` stage always
// fails, so `runDevelopmentStages` loops through `fix-spec` and back until
// `specReviewGate`'s cap durably parks it; `drainer` is an independent task
// whose own pipeline passes cleanly. Single-lane serial dispatch means
// `drainer` is untouched while `gate-capped`'s whole capped pipeline runs
// inside one tick; this fixture proves the very next tick still dispatches
// `drainer` rather than the run wedging on the capped task, and that every
// one of the three capped rounds' findings landed durably in the `gates`
// table, not only the last.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  startGitFixtureRun,
  assertOperatorCheckoutUnchanged,
  seedTasks,
  readTaskRow,
  allRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  reportLine,
  exitLine,
  wellFormedStream,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";

const TICK_INTERVAL_MS = 100;
const TERMINAL_WAIT_MS = 20000;

// `claimSetComplete` requires a `claims` row to exist for any mutating
// dispatch once a workspace provider is present (`dispatch.ts`); neither
// fixture task writes a file, so an empty declared set is enough to keep
// `validateAttemptClaims`'s own parity check trivially satisfied too.
function seedEmptyFilesClaim(dir: string, runId: string, taskId: string): void {
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`claim-${taskId}`, runId, taskId, "files", JSON.stringify([]), Date.now());
    });
  } finally {
    db.close();
  }
}

interface GateRow {
  round: number;
  verdict: string | null;
  evidence_ref: string | null;
  cap: number;
}

export async function gateCapParksTask(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const tasks = [
      { id: "gate-capped", priority: 0 },
      { id: "drainer", priority: 1 },
    ];
    const { runId } = startGitFixtureRun(dir, tasks);
    // Streams live outside the operator's checkout: a directory inside `dir`
    // would itself be a new untracked path the moment it is written, which
    // `assertOperatorCheckoutUnchanged` would then (correctly) flag.
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    await assertOperatorCheckoutUnchanged(dir, async () => {
      try {
        seedTasks(dir, runId, tasks, Date.now());
        seedEmptyFilesClaim(dir, runId, "gate-capped");
        seedEmptyFilesClaim(dir, runId, "drainer");

        writeStream(
          streamsDir,
          "implement",
          "gate-capped",
          wellFormedStream({ taskId: "gate-capped", stageId: "implement", roleId: "implementer", status: "completed" }),
        );
        writeStream(
          streamsDir,
          "fix-spec",
          "gate-capped",
          wellFormedStream({ taskId: "gate-capped", stageId: "fix-spec", roleId: "implementer", status: "completed" }),
        );
        writeStream(streamsDir, "review-spec", "gate-capped", [
          outputLine("reviewing"),
          reportLine({
            taskId: "gate-capped",
            stageId: "review-spec",
            roleId: "spec-reviewer",
            status: "completed",
            verdict: "fail",
            findings: [
              { id: "spec-finding", severity: "minor", summary: "recurring spec gap", path: "src/example.ts" },
            ],
          }),
          exitLine(0),
        ]);

        writeStream(
          streamsDir,
          "implement",
          "drainer",
          wellFormedStream({ taskId: "drainer", stageId: "implement", roleId: "implementer", status: "completed" }),
        );
        writeStream(streamsDir, "review-spec", "drainer", [
          outputLine("reviewing"),
          reportLine({
            taskId: "drainer",
            stageId: "review-spec",
            roleId: "spec-reviewer",
            status: "completed",
            verdict: "pass",
          }),
          exitLine(0),
        ]);
        writeStream(streamsDir, "review-quality", "drainer", [
          outputLine("reviewing"),
          reportLine({
            taskId: "drainer",
            stageId: "review-quality",
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
          workspaceMode: "worktree",
        });
        registry.track(supervisor.pid);

        const cappedParked = await waitFor(
          () => readTaskRow(dir, "gate-capped")?.disposition === "parked",
          TERMINAL_WAIT_MS,
        );
        assert.ok(
          cappedParked,
          `gate-capped never parked; row: ${JSON.stringify(readTaskRow(dir, "gate-capped"))}`,
        );

        const gateRows = allRows<GateRow>(
          dir,
          `SELECT round, verdict, evidence_ref, cap FROM gates
             WHERE run_id = ? AND task_id = 'gate-capped' AND gate_type = 'specReviewGate'
             ORDER BY round ASC`,
          runId,
        );
        assert.equal(gateRows.length, 3, `expected 3 durable specReviewGate rounds; got ${JSON.stringify(gateRows)}`);
        assert.deepEqual(gateRows.map((row) => row.round), [1, 2, 3]);
        for (const row of gateRows) {
          assert.equal(row.verdict, "fail");
          assert.equal(row.cap, 3);
          assert.ok(row.evidence_ref, `round ${row.round} must carry recorded evidence`);
          const report = JSON.parse(row.evidence_ref as string) as { findings?: Array<{ id: string }> };
          assert.deepEqual(
            report.findings?.map((finding) => finding.id),
            ["spec-finding"],
            `round ${row.round}'s evidence must carry the reported finding`,
          );
        }

        const drainerAdvanced = await waitFor(() => {
          const row = readTaskRow(dir, "drainer");
          return row !== undefined && row.stage_id !== "implementation" && row.stage_id !== null;
        }, TERMINAL_WAIT_MS);
        assert.ok(
          drainerAdvanced,
          `drainer, unrelated to gate-capped's cap, must advance past implementation once the lane frees up; row: ${JSON.stringify(readTaskRow(dir, "drainer"))}`,
        );
      } finally {
        registry.killAll();
        await registry.allDead();
        fs.rmSync(streamsDir, { recursive: true, force: true });
      }
    });
  });
}
