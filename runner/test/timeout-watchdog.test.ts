import assert from "node:assert/strict";
import test from "node:test";

import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor, ExecutionSurface } from "../src/adapters/adapter.ts";
import { watchForTimeout, type WatchdogClock, type WatchdogTimedOut } from "../src/engine/timeout-watchdog.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pgid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pgid) && Date.now() < deadline) {
    await sleep(10);
  }
}

const terminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  let signalSent: NodeJS.Signals | null = null;
  try {
    process.kill(-pgid, "SIGTERM");
    signalSent = "SIGTERM";
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && isAlive(pgid)) {
    await sleep(10);
  }
  if (isAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
      signalSent = "SIGKILL";
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && isAlive(pgid); i++) await sleep(10);
  }
  return {
    signalSent,
    exitCode: null,
    killedProcessTree: !isAlive(pgid),
    timedOutWaitingForExit: isAlive(pgid),
  };
};

const clock: WatchdogClock = { now: () => Date.now() };

function attempt(stageId: string, scenario: string, roleId = "implementer"): AttemptDescriptor {
  return {
    attemptId: scenario,
    runId: "run_test",
    taskId: "task_test",
    stageId,
    roleId,
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 5000 },
  };
}

async function surfaceIn(cwd: string): Promise<ExecutionSurface> {
  return {
    workingDirectory: cwd,
    environment: process.env,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };
}

test("spawnMs fires when no event arrives within the budget, and terminates the group", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "no-events");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    try {
      const result = await watchForTimeout(
        adapter,
        handle,
        { spawnMs: 150, idleMs: 5000, wallMs: 5000 },
        clock,
        100,
      );
      assert.equal(result.outcome, "spawn-timeout");
      const timedOut = result as WatchdogTimedOut;
      assert.equal(timedOut.termination.length, 1);
      assert.equal(timedOut.termination[0].pgid, handle.pgid);
      assert.equal(timedOut.termination[0].signalled, true);
      await waitUntilDead(handle.pgid, 500);
      assert.equal(isAlive(handle.pgid), false);
    } finally {
      if (isAlive(handle.pgid)) await terminate({ pid: handle.pid, pgid: handle.pgid }, 50);
    }
  });
});

test("idleMs fires only after the first event, once the gap since the last event exceeds the budget", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "silent-until-killed");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    try {
      const result = await watchForTimeout(
        adapter,
        handle,
        { spawnMs: 5000, idleMs: 150, wallMs: 5000 },
        clock,
        100,
      );
      assert.equal(result.outcome, "idle-timeout");
      const timedOut = result as WatchdogTimedOut;
      assert.equal(timedOut.termination[0].pgid, handle.pgid);
      assert.equal(timedOut.termination[0].signalled, true);
      await waitUntilDead(handle.pgid, 500);
      assert.equal(isAlive(handle.pgid), false);
    } finally {
      if (isAlive(handle.pgid)) await terminate({ pid: handle.pid, pgid: handle.pgid }, 50);
    }
  });
});

test("wallMs fires at an absolute bound regardless of ongoing stream activity", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "chatty-no-commit");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    try {
      const result = await watchForTimeout(
        adapter,
        handle,
        { spawnMs: 5000, idleMs: 5000, wallMs: 300 },
        clock,
        100,
      );
      assert.equal(result.outcome, "wall-timeout");
      const timedOut = result as WatchdogTimedOut;
      assert.equal(timedOut.termination[0].pgid, handle.pgid);
      assert.equal(timedOut.termination[0].signalled, true);
      await waitUntilDead(handle.pgid, 500);
      assert.equal(isAlive(handle.pgid), false);
    } finally {
      if (isAlive(handle.pgid)) await terminate({ pid: handle.pid, pgid: handle.pgid }, 50);
    }
  });
});

test("no timeout fires, and no signal is sent, when exit arrives before any budget", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "well-formed");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    const result = await watchForTimeout(
      adapter,
      handle,
      { spawnMs: 5000, idleMs: 5000, wallMs: 5000 },
      clock,
      100,
    );
    assert.equal(result.outcome, "no-timeout");
    assert.equal((result as unknown as WatchdogTimedOut).termination, undefined);
  });
});

test("the watchdog's promise resolves once terminateGroups escalates to SIGKILL against a SIGTERM-trapping process", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "sigterm-trap");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    try {
      const result = await watchForTimeout(
        adapter,
        handle,
        { spawnMs: 5000, idleMs: 150, wallMs: 5000 },
        clock,
        200,
      );
      assert.equal(result.outcome, "idle-timeout");
      const timedOut = result as WatchdogTimedOut;
      assert.equal(timedOut.termination[0].pgid, handle.pgid);
      assert.equal(timedOut.termination[0].killed, true);
      await waitUntilDead(handle.pgid, 500);
      assert.equal(isAlive(handle.pgid), false);
    } finally {
      if (isAlive(handle.pgid)) await terminate({ pid: handle.pid, pgid: handle.pgid }, 50);
    }
  });
});
