// Fixture: descendant-process-cleanup.
//
// A fake worker spawns a grandchild in the same process group which
// outlives its parent. After cancel, and separately after a wall-timeout
// kill, `process.kill(-pgid, 0)` must throw ESRCH for every process group id
// the run ever recorded.
//
// `replay.ts`'s scripted-stream format has no "spawn a grandchild" op, and
// it is P5c-owned fixture infrastructure this child does not modify, so
// neither case can dispatch its worker through the real scheduler
// (`createSchedulerTick`/`FakeAdapter`) — that always spawns `replay.ts`
// itself. Both cases instead seed the attempt/worker rows directly (the same
// technique fixtures 04 and 07 use) and point them at a small standalone
// script that spawns a real, group-inheriting grandchild. The "cancel" case
// still exercises the real graceful path end to end — a live supervisor
// process running `withOperatorTermination` over a stub tick body (P5b's own
// `restingStubBody`, exactly as `pause-cancel.test.ts`'s "run cancel end to
// end" test does) so `run cancel`'s control row is actually acknowledged and
// acted on, not merely inserted. The wall-timeout case has no supervisor
// alive at all — the same "no live supervisor" precondition `killRun`
// documents for itself — so it goes through `run kill` (P5e) directly,
// standing in for whatever future watchdog decides an attempt exceeded its
// wall budget; this fixture asserts the group-cleanup guarantee that call
// makes, not the timeout-detection logic itself.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import {
  ProcessRegistry,
  waitFor,
  groupAlive,
  startFixtureRun,
  readRunRow,
  allRows,
  openStore,
  withTransaction,
  withFixtureWorkspace,
} from "./harness.ts";
import { main } from "../../bin/orga.ts";
import type { Io } from "../../src/cli/commands.ts";

const TICK_INTERVAL_MS = 200;
const CANCEL_GRACE_MS = 250;

const DB_PATH = fileURLToPath(new URL("../../src/store/db.ts", import.meta.url));
const LEASE_PATH = fileURLToPath(new URL("../../src/store/lease.ts", import.meta.url));
const TICK_PATH = fileURLToPath(new URL("../../src/engine/tick.ts", import.meta.url));
const CONTROL_COMMANDS_PATH = fileURLToPath(new URL("../../src/engine/control-commands.ts", import.meta.url));

const GRANDCHILD_SCRIPT = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
// Spawned WITHOUT its own "detached": it inherits this process's group
// rather than starting a new one, so it stays reachable by a group signal
// sent to this process's pgid, and it would outlive this parent if only the
// parent were torn down — which never happens here, since both cleanup
// paths signal the whole recorded group.
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 120000);"], {
  stdio: "ignore",
});
process.stdout.write("GRANDCHILD_PID:" + grandchild.pid + "\\n");
setTimeout(() => {}, 120000);
`;

function fakeIo(dir: string, env: NodeJS.ProcessEnv = {}): Io {
  return {
    stdout: () => {},
    stderr: () => {},
    cwd: () => dir,
    now: () => Date.now(),
    env,
  };
}

async function spawnGrandchildParent(dir: string): Promise<{ pgid: number; grandchildPid: number }> {
  const scriptPath = path.join(dir, "grandchild-parent.cjs");
  fs.writeFileSync(scriptPath, GRANDCHILD_SCRIPT);

  const child = spawn(process.execPath, [scriptPath], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pgid = child.pid as number;
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));

  const gotGrandchild = await waitFor(() => /GRANDCHILD_PID:(\d+)/.test(stdout), 3000);
  if (!gotGrandchild) throw new Error(`grandchild never reported its pid; stdout so far: ${stdout}`);
  const grandchildPid = Number(/GRANDCHILD_PID:(\d+)/.exec(stdout)?.[1]);
  return { pgid, grandchildPid };
}

function seedAttemptAndWorker(dir: string, runId: string, pgid: number): void {
  const now = Date.now();
  const db = openStore(dir);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("task-a", runId, "task-a", "Task A", "brief.md", "dev-workflow", "implementation", "[]", 0, "implementing", null, now, now);
      db.prepare(
        `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("att-1", runId, "task-a", "implementation", "implementer", 1, "v1", "fake", "fake", "{}", 0, "running", now, now);
      db.prepare(
        `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("w-1", runId, "att-1", pgid, pgid, now, now);
    });
  } finally {
    db.close();
  }
}

function assertNoLiveDescendant(dir: string, runId: string, pgid: number, grandchildPid: number): void {
  assert.throws(() => process.kill(-pgid, 0), /ESRCH/, `group ${pgid} must have no live descendant`);
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/, "the grandchild must not have outlived its parent's group");
  const recordedPgids = allRows<{ pgid: number }>(dir, `SELECT DISTINCT pgid FROM workers WHERE run_id = ?`, runId);
  for (const worker of recordedPgids) {
    assert.throws(() => process.kill(-worker.pgid, 0), /ESRCH/, `recorded group ${worker.pgid} must have no live descendant`);
  }
}

export async function descendantProcessCleanupCancel(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    let supervisorPid: number | undefined;
    try {
      const { runId } = startFixtureRun(dir, [{ id: "placeholder" }]);
      const { pgid, grandchildPid } = await spawnGrandchildParent(dir);
      registry.track(pgid);
      seedAttemptAndWorker(dir, runId, pgid);

      const scriptPath = path.join(dir, "stub-supervisor.mjs");
      const script = `
        import { openStore } from ${JSON.stringify(DB_PATH)};
        import { acquireLease } from ${JSON.stringify(LEASE_PATH)};
        import { runTickShell, restingStubBody } from ${JSON.stringify(TICK_PATH)};
        import { withOperatorTermination } from ${JSON.stringify(CONTROL_COMMANDS_PATH)};

        const db = openStore(${JSON.stringify(dir)});
        acquireLease(db, { runId: ${JSON.stringify(runId)}, ownerPid: process.pid, tickIntervalMs: ${TICK_INTERVAL_MS}, now: Date.now });
        const body = withOperatorTermination(restingStubBody({ kind: "active" }), {
          installSigtermTrap: true,
          defaultCancelGraceMs: ${CANCEL_GRACE_MS},
        });
        const exit = await runTickShell({
          db,
          runId: ${JSON.stringify(runId)},
          body,
          tickIntervalMs: ${TICK_INTERVAL_MS},
          operatorPollWindowMs: ${TICK_INTERVAL_MS * 4},
        });
        process.exit(exit.exitCode);
      `;
      fs.writeFileSync(scriptPath, script);
      const supervisor = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
      supervisorPid = supervisor.pid;
      supervisor.stdout?.resume();
      supervisor.stderr?.resume();

      const leaseUp = await waitFor(
        () => allRows(dir, `SELECT 1 AS x FROM locks WHERE resource = ? AND released_at IS NULL`, runId).length === 1,
        2000,
      );
      assert.ok(leaseUp, "the stub supervisor must hold a lease before cancel is issued");

      const cancelStart = Date.now();
      const cancelCode = await main(["node", "orga", "run", "cancel", runId], fakeIo(dir));
      assert.equal(cancelCode, 0);

      const acked = await waitFor(
        () => allRows(dir, `SELECT 1 AS x FROM control WHERE run_id = ? AND acked_at IS NOT NULL`, runId).length === 1,
        2000,
      );
      assert.ok(acked, "the control row must be acknowledged by the live supervisor");

      const gone = await waitFor(() => !groupAlive(pgid), 3000);
      const elapsed = Date.now() - cancelStart;
      assert.ok(gone, "the worker group must be gone after cancel");
      assert.ok(elapsed >= CANCEL_GRACE_MS - 50, `the grace period must be honored (took ${elapsed}ms)`);

      const supervisorExited = await waitFor(() => supervisor.exitCode !== null, 2000);
      assert.ok(supervisorExited);

      assertNoLiveDescendant(dir, runId, pgid, grandchildPid);

      const attempt = allRows<{ status: string; interrupt_reason: string | null }>(
        dir,
        `SELECT status, interrupt_reason FROM attempts WHERE run_id = ?`,
        runId,
      )[0] as { status: string; interrupt_reason: string | null };
      assert.equal(attempt.status, "interrupted");
      assert.equal(attempt.interrupt_reason, "operator-cancel");

      const run = readRunRow(dir, runId);
      assert.equal(run.state, "cancelled");
    } finally {
      if (typeof supervisorPid === "number") {
        try {
          process.kill(supervisorPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function descendantProcessCleanupWallTimeout(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "placeholder" }]);
      const { pgid, grandchildPid } = await spawnGrandchildParent(dir);
      registry.track(pgid);
      seedAttemptAndWorker(dir, runId, pgid);

      // No live supervisor exists for this run at all — the precondition
      // `killRun` (P5e) documents for itself — standing in for a future
      // wall-timeout watchdog that decides, with no supervisor of its own
      // yet running, to end an attempt that has exceeded its budget.
      // `run kill`'s grace period (config.ts's `runner.cancel_grace_ms`,
      // resolved from the layered config surface `ORGA_CANCEL_GRACE_MS`
      // env) defaults to 10 real seconds — appropriate for production, far
      // too slow for a fixture that only needs to prove the group is
      // eventually gone, not exercise the grace-period duration itself
      // (fixture 09 already does that).
      const result = await main(["node", "orga", "run", "kill", runId], fakeIo(dir, { ORGA_CANCEL_GRACE_MS: String(CANCEL_GRACE_MS) }));
      assert.equal(result, 0);

      const gone = await waitFor(() => !groupAlive(pgid), 3000);
      assert.ok(gone);

      assertNoLiveDescendant(dir, runId, pgid, grandchildPid);
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
