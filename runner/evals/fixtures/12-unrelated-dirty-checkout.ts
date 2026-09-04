// Fixture: unrelated-dirty-checkout-does-not-affect-task.
//
// Before the run is even seeded, the operator's checkout is dirtied with a
// file the task never touches, at a non-ignored path with known bytes. The
// task's own attempt runs to completion inside its own runner-owned
// worktree, observing nothing outside its declared (empty) claim set, so
// `validateAttemptClaims` records no violation. The pre-existing dirt in the
// operator's checkout must be exactly as untouched as everything else
// `assertOperatorCheckoutUnchanged` already covers.

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
  allRows,
  countRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  reportLine,
  exitLine,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";

const TICK_INTERVAL_MS = 100;
const DIRTY_CONTENTS = "unrelated operator dirt, never claimed by any task\n";

function seedFilesClaim(dir: string, runId: string, taskId: string, claimedPaths: readonly string[]): void {
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`claim-${taskId}`, runId, taskId, "files", JSON.stringify(claimedPaths), Date.now());
    });
  } finally {
    db.close();
  }
}

export async function unrelatedDirtyCheckoutDoesNotAffectTask(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const { runId } = startGitFixtureRun(dir, [{ id: "task-a" }]);

    const dirtyPath = path.join(dir, "operator-dirt.txt");
    fs.writeFileSync(dirtyPath, DIRTY_CONTENTS, "utf8");

    // Streams live outside the operator's checkout: a directory inside `dir`
    // would itself be a new untracked path the moment it is written, which
    // `assertOperatorCheckoutUnchanged` would then (correctly) flag.
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    await assertOperatorCheckoutUnchanged(dir, async () => {
      try {
        seedTasks(dir, runId, [{ id: "task-a" }], Date.now());
        seedFilesClaim(dir, runId, "task-a", []);

        writeStream(streamsDir, "implementation", "task-a", [
          outputLine("working"),
          reportLine({ taskId: "task-a", stageId: "implementation", status: "completed", summary: "did the work" }),
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

        const normalized = await waitFor(
          () => countRows(dir, `SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'attempt.normalized'`, runId) > 0,
          6000,
        );
        assert.ok(normalized, "the attempt must be normalized");

        const attempts = allRows<{ id: string; status: string }>(
          dir,
          `SELECT id, status FROM attempts WHERE run_id = ? AND task_id = 'task-a'`,
          runId,
        );
        assert.equal(attempts.length, 1, "exactly one attempt row for task-a");
        assert.equal(attempts[0]?.status, "completed", "the attempt must be recorded completed");

        const violations = countRows(
          dir,
          `SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`,
          runId,
        );
        assert.equal(violations, 0, "zero claim-violation events");
      } finally {
        registry.killAll();
        await registry.allDead();
        fs.rmSync(streamsDir, { recursive: true, force: true });
      }
    });

    assert.ok(fs.existsSync(dirtyPath), "the dirty file is still present");
    const statusAfter = fs.statSync(dirtyPath);
    assert.ok(statusAfter.isFile());
    const contentsAfter = fs.readFileSync(dirtyPath, "utf8");
    assert.equal(contentsAfter, DIRTY_CONTENTS, "the dirty file is byte-identical afterwards");
  });
}
