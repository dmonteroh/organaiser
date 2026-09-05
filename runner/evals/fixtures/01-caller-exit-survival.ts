// Fixture: caller-exit-survival.
//
// `src/engine/supervisor.ts` hardcodes a 1-second tick interval and a
// 5-minute operator-poll window with no override surface, and its
// production `FakeAdapter` binding keys a dispatched attempt's scenario by
// its randomly-generated attempt id — there is no way to pre-place a stream
// file for it. Driving this fixture through that literal entry point would
// mean either a multi-minute real-wall-clock test or a worker that always
// crashes instantly on a missing stream file, neither of which can exercise
// "a fake adapter that runs longer than two tick intervals." The fixture
// instead drives the caller through this suite's own `test-supervisor.ts`
// (harness.ts's `spawnFixtureSupervisor`) — the same real detached-spawn
// mechanism (`startRun`'s own spawn+`unref`, already proven independently in
// supervisor-detach.test.ts), parametrized to a real, fast tick interval, so
// the property under test (a caller's death cannot take the supervisor with
// it) is provable in real time rather than production's fixed one.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ProcessRegistry,
  alive,
  groupAlive,
  waitFor,
  startFixtureRun,
  readRunRow,
  allRows,
  writeStream,
  wellFormedStream,
  sleepLine,
  outputLine,
  exitLine,
  withFixtureWorkspace,
  TEST_SUPERVISOR_PATH,
  openStore,
  withTransaction,
} from "./harness.ts";
import { spawn } from "node:child_process";

const TICK_INTERVAL_MS = 200;

export async function callerExitSurvival(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    let callerPid: number | undefined;

    try {
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
      // Well past two tick intervals (2 * 200ms), so the run is still
      // actively ticking (a live worker) when the caller is killed.
      writeStream(streamsDir, "integration", "task-a", [
        outputLine("starting"),
        sleepLine(TICK_INTERVAL_MS * 6),
        ...wellFormedStream({ taskId: "task-a", stageId: "integration" }).slice(1),
      ]);

      const logPath = path.join(dir, ".orga", "runs", runId, "supervisor.log");
      const callerScript = path.join(dir, "caller.mjs");
      fs.writeFileSync(
        callerScript,
        `
        import { spawn } from "node:child_process";
        import fs from "node:fs";
        const logFd = fs.openSync(${JSON.stringify(logPath)}, "a");
        const child = spawn(process.execPath, [
          ${JSON.stringify(TEST_SUPERVISOR_PATH)},
          ${JSON.stringify(dir)},
          ${JSON.stringify(runId)},
          ${JSON.stringify(String(TICK_INTERVAL_MS))},
          ${JSON.stringify(String(TICK_INTERVAL_MS * 4))},
          ${JSON.stringify(String(TICK_INTERVAL_MS))},
          ${JSON.stringify(streamsDir)},
        ], { detached: true, stdio: ["ignore", logFd, logFd] });
        fs.closeSync(logFd);
        child.unref();
        process.stdout.write(JSON.stringify({ supervisorPid: child.pid }) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 10000));
        `,
      );

      const caller = spawn(process.execPath, [callerScript], { stdio: ["ignore", "pipe", "pipe"] });
      callerPid = caller.pid;
      let stdout = "";
      caller.stdout?.setEncoding("utf8");
      caller.stdout?.on("data", (chunk: string) => (stdout += chunk));
      let stderr = "";
      caller.stderr?.setEncoding("utf8");
      caller.stderr?.on("data", (chunk: string) => (stderr += chunk));

      const gotOutput = await waitFor(() => stdout.includes("\n"), 5000);
      assert.ok(gotOutput, `caller did not report the supervisor pid in time; stderr: ${stderr}`);
      const { supervisorPid } = JSON.parse(stdout.trim().split("\n")[0] as string) as { supervisorPid: number };
      registry.track(supervisorPid);

      const supervisorUp = await waitFor(() => alive(supervisorPid), 2000);
      assert.ok(supervisorUp, "the test supervisor must be alive before the caller is killed");

      const deathTimeMs = Date.now();
      caller.kill("SIGKILL");
      await new Promise<void>((resolve) => caller.on("exit", () => resolve()));
      assert.equal(alive(callerPid as number), false, "the caller must actually be dead");

      const stillAliveAfter1s = await waitFor(() => alive(supervisorPid), 1200);
      assert.ok(stillAliveAfter1s, "the recorded supervisor pid must be alive roughly a second after the caller's death");

      assert.ok(fs.existsSync(logPath), "supervisor.log must exist");
      const sizeBefore = fs.statSync(logPath).size;
      // Polled with a generous overall budget rather than a single fixed
      // sleep: the heartbeat write this waits on is a real, timer-driven
      // process write, and a fixed short window is exactly the kind of
      // assertion a loaded CI host turns flaky.
      const grew = await waitFor(() => fs.statSync(logPath).size > sizeBefore, 8000);
      const sizeAfter = fs.statSync(logPath).size;
      assert.ok(grew, `supervisor.log must strictly grow after the caller's death (before=${sizeBefore}, after=${sizeAfter})`);

      const reachedTerminal = await waitFor(() => {
        const run = readRunRow(dir, runId);
        return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
      }, 8000);
      assert.ok(reachedTerminal, `run did not reach a terminal state; last state: ${JSON.stringify(readRunRow(dir, runId))}`);

      const events = allRows<{ created_at: number }>(dir, `SELECT created_at FROM events WHERE run_id = ? ORDER BY seq`, runId);
      assert.ok(
        events.some((event) => event.created_at > deathTimeMs),
        "at least one events row must carry a timestamp later than the caller's death",
      );
    } finally {
      if (typeof callerPid === "number") {
        try {
          process.kill(callerPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      registry.killAll();
      await registry.allDead();
    }
  });
}
