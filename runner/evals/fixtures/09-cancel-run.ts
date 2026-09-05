// Fixture: cancel-run.
//
// A fake worker that traps and ignores SIGTERM. `run cancel` inserts exactly
// one acknowledged `control` row, the run passes through `cancelling` to
// `cancelled`, the worker group receives SIGTERM, survives the grace period,
// then receives SIGKILL, the in-flight attempt is `interrupted` with
// `interrupt_reason: operator-cancel`, no live descendant remains, and `run
// wait` exits 13. The `--now` variant sends SIGKILL with no grace wait.

import assert from "node:assert/strict";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  groupAlive,
  startFixtureRun,
  readRunRow,
  countRows,
  allRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  withFixtureWorkspace,
  openStore,
  withTransaction,
} from "./harness.ts";
import { main } from "../../bin/orga.ts";
import { EXIT_CODES } from "../../src/cli/exit-codes.ts";
import type { Io } from "../../src/cli/commands.ts";

const TICK_INTERVAL_MS = 200;
const CANCEL_GRACE_MS = 300;

function fakeIo(dir: string): Io {
  return {
    stdout: () => {},
    stderr: () => {},
    cwd: () => dir,
    now: () => Date.now(),
    env: {},
  };
}

async function setUp(dir: string) {
  const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
  const now = Date.now();
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("task-a", runId, "task-a", "task-a", "brief.md", "dev-workflow", "integration", "[]", 0, "defined", null, now, now);
    });
  } finally {
    db.close();
  }
  const streamsDir = path.join(dir, "streams");
  writeStream(streamsDir, "integration", "task-a", [
    outputLine("ignoring termination"),
    JSON.stringify({ op: "trap-sigterm" }),
    JSON.stringify({ op: "sleep", ms: 60000 }),
  ]);
  const supervisor = spawnFixtureSupervisor(dir, runId, {
    tickIntervalMs: TICK_INTERVAL_MS,
    operatorPollWindowMs: TICK_INTERVAL_MS * 4,
    cancelGraceMs: CANCEL_GRACE_MS,
    streamsDir,
  });
  return { runId, supervisor, streamsDir };
}

export async function cancelRunGraceful(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId, supervisor } = await setUp(dir);
      registry.track(supervisor.pid);

      const workerPgid = await waitFor(() => {
        const rows = allRows<{ pgid: number }>(dir, `SELECT pgid FROM workers WHERE run_id = ?`, runId);
        return rows.length > 0;
      }, 3000);
      assert.ok(workerPgid, "the trapping worker must be dispatched before cancel is issued");
      const pgid = (allRows<{ pgid: number }>(dir, `SELECT pgid FROM workers WHERE run_id = ?`, runId)[0] as { pgid: number }).pgid;
      registry.track(pgid);
      const groupUp = await waitFor(() => groupAlive(pgid), 2000);
      assert.ok(groupUp, "the worker group must be a real, live process group before cancel");

      const cancelStart = Date.now();
      const cancelIo = fakeIo(dir);
      const cancelCode = await main(["node", "orga", "run", "cancel", runId], cancelIo);
      assert.equal(cancelCode, EXIT_CODES.OK);

      const controlRows = countRows(dir, `SELECT COUNT(*) AS n FROM control WHERE run_id = ? AND kind = 'cancel'`, runId);
      assert.equal(controlRows, 1, "exactly one control row must be inserted");

      const acked = await waitFor(
        () => countRows(dir, `SELECT COUNT(*) AS n FROM control WHERE run_id = ? AND kind = 'cancel' AND acked_at IS NOT NULL`, runId) === 1,
        3000,
      );
      assert.ok(acked, "the control row must be acknowledged exactly once");

      const cancelling = await waitFor(() => readRunRow(dir, runId).state === "cancelling", 2000);
      assert.ok(cancelling, "the run must pass through cancelling");

      // Survives the grace period: still alive shortly after cancel, then
      // gone once the grace window elapses.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, CANCEL_GRACE_MS - 150)));
      assert.ok(groupAlive(pgid), "the trapping group must survive the grace period, not die on SIGTERM alone");

      const gone = await waitFor(() => !groupAlive(pgid), 3000);
      const elapsed = Date.now() - cancelStart;
      assert.ok(gone, "the worker group must eventually be SIGKILLed");
      assert.ok(elapsed >= CANCEL_GRACE_MS - 50, `the grace period must be honored (took ${elapsed}ms)`);

      const cancelled = await waitFor(() => readRunRow(dir, runId).state === "cancelled", 3000);
      assert.ok(cancelled, `run must reach cancelled; row: ${JSON.stringify(readRunRow(dir, runId))}`);

      const attempt = allRows<{ status: string; interrupt_reason: string | null }>(
        dir,
        `SELECT status, interrupt_reason FROM attempts WHERE run_id = ?`,
        runId,
      )[0] as { status: string; interrupt_reason: string | null };
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "operator-cancel");

      assert.throws(() => process.kill(-pgid, 0), /ESRCH/, "no live descendant may remain");

      const waitIo = fakeIo(dir);
      const waitCode = await main(["node", "orga", "run", "wait", runId, "--until", "cancelled"], waitIo);
      assert.equal(waitCode, EXIT_CODES.CANCELLED);
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function cancelRunNow(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId, supervisor } = await setUp(dir);
      registry.track(supervisor.pid);

      await waitFor(() => allRows(dir, `SELECT 1 AS x FROM workers WHERE run_id = ?`, runId).length > 0, 3000);
      const pgid = (allRows<{ pgid: number }>(dir, `SELECT pgid FROM workers WHERE run_id = ?`, runId)[0] as { pgid: number }).pgid;
      registry.track(pgid);
      await waitFor(() => groupAlive(pgid), 2000);

      const cancelStart = Date.now();
      const cancelIo = fakeIo(dir);
      const cancelCode = await main(["node", "orga", "run", "cancel", runId, "--now"], cancelIo);
      assert.equal(cancelCode, EXIT_CODES.OK);

      const controlRow = allRows<{ kind: string }>(dir, `SELECT kind FROM control WHERE run_id = ?`, runId)[0] as {
        kind: string;
      };
      assert.equal(controlRow.kind, "cancel-now");

      const gone = await waitFor(() => !groupAlive(pgid), 2000);
      const elapsed = Date.now() - cancelStart;
      assert.ok(gone, "the group must be gone");
      assert.ok(elapsed < CANCEL_GRACE_MS, `--now must not wait a grace window (took ${elapsed}ms)`);

      const cancelled = await waitFor(() => readRunRow(dir, runId).state === "cancelled", 3000);
      assert.ok(cancelled);
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
