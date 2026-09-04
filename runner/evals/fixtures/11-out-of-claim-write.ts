// Fixture: out-of-claim-write.
//
// A fake-adapter attempt is dispatched into a runner-owned worktree for a
// task whose only declared claim is `claimed.txt`. The worker process writes
// both `claimed.txt` and `unclaimed.txt` via `write-file` ops that precede
// its report line, so both writes land before the supervisor ever reaps the
// attempt. `validateAttemptClaims` must then reject the attempt on the
// unclaimed path: the attempt row is recorded failed, one
// `attempt.claim-violation` event carries that path, the task's stage is
// unchanged, the worktrees row stays `active`, and the file the worker wrote
// is still on disk.

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
  countRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  reportLine,
  exitLine,
  writeFileLine,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";

const TICK_INTERVAL_MS = 100;

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

export async function outOfClaimWrite(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const { runId } = startGitFixtureRun(dir, [{ id: "task-a" }]);
    // Streams live outside the operator's checkout: a directory inside `dir`
    // would itself be a new untracked path the moment it is written, which
    // `assertOperatorCheckoutUnchanged` would then (correctly) flag.
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-fixture-streams-"));

    await assertOperatorCheckoutUnchanged(dir, async () => {
      try {
        seedTasks(dir, runId, [{ id: "task-a" }], Date.now());
        seedFilesClaim(dir, runId, "task-a", ["claimed.txt"]);

        writeStream(streamsDir, "implementation", "task-a", [
          writeFileLine("claimed.txt", "claimed contents\n"),
          writeFileLine("unclaimed.txt", "unclaimed contents\n"),
          outputLine("writing files"),
          reportLine({ taskId: "task-a", stageId: "implementation", status: "completed", summary: "wrote two files" }),
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

        const violationRecorded = await waitFor(
          () => countRows(dir, `SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`, runId) > 0,
          6000,
        );
        assert.ok(violationRecorded, "an attempt.claim-violation event must be recorded for the out-of-claim write");

        const attempts = allRows<{ id: string; status: string }>(
          dir,
          `SELECT id, status FROM attempts WHERE run_id = ? AND task_id = 'task-a'`,
          runId,
        );
        assert.equal(attempts.length, 1, "exactly one attempt row for task-a");
        assert.equal(attempts[0]?.status, "failed", "an out-of-claim write must be recorded failed");

        const violationEvents = allRows<{ payload: string }>(
          dir,
          `SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`,
          runId,
        );
        assert.equal(violationEvents.length, 1);
        const payload = JSON.parse(violationEvents[0]!.payload) as { outOfClaim: string[] };
        assert.deepEqual(payload.outOfClaim, ["unclaimed.txt"]);

        const taskAfter = readTaskRow(dir, "task-a");
        assert.equal(taskAfter?.stage_id, "implementation", "the rejected attempt must not advance the task's stage");

        const worktreeRows = allRows<{ path: string; cleanup_state: string }>(
          dir,
          `SELECT path, cleanup_state FROM worktrees WHERE run_id = ? AND task_id = 'task-a'`,
          runId,
        );
        assert.equal(worktreeRows.length, 1);
        assert.equal(worktreeRows[0]?.cleanup_state, "active", "a claim rejection leaves the worktrees row active");

        const unclaimedPath = path.join(worktreeRows[0]!.path, "unclaimed.txt");
        assert.ok(fs.existsSync(unclaimedPath), "the file the worker wrote is still present in the worktree");
      } finally {
        registry.killAll();
        await registry.allDead();
        fs.rmSync(streamsDir, { recursive: true, force: true });
      }
    });
  });
}
