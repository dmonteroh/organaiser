import assert from "node:assert/strict";
import test from "node:test";

import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor, ExecutionSurface, NormalizedEvent } from "../src/adapters/adapter.ts";
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

// Minimal SIGTERM-then-SIGKILL escalation for tests that need `cancel` to actually end
// a real spawned process group. The fake adapter's `cancel` delegates termination to a
// caller-supplied callback rather than implementing the sequence itself; this is that
// callback, scoped to what this test file needs to exercise it end to end.
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

function attempt(stageId: string, scenario: string, roleId = "implementer"): AttemptDescriptor {
  return {
    attemptId: scenario,
    runId: "run_test",
    taskId: "task_test",
    stageId,
    roleId,
    timeoutBudget: { spawnMs: 5000, idleMs: 300, wallMs: 30000 },
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

async function drain(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

test("well-formed successful report classifies ok with the parsed report", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "well-formed");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    await drain(adapter.observe(handle));
    const artifacts = await adapter.collect(handle);
    const outcome = await adapter.classify(artifacts);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.failureClass, null);
    assert.equal(outcome.report?.roleId, "implementer");
    assert.equal(artifacts.exitCode, 0);
  });
});

test("report missing a required field classifies schema-invalid via createReportValidator", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "missing-required-field");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    await drain(adapter.observe(handle));
    const artifacts = await adapter.collect(handle);
    const outcome = await adapter.classify(artifacts);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failureClass, "schema-invalid");
    assert.match(outcome.reason ?? "", /summary/);
  });
});

test("report with an unknown verdict value classifies schema-invalid via createReportValidator", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("review-spec", "unknown-verdict", "spec-reviewer");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    await drain(adapter.observe(handle));
    const artifacts = await adapter.collect(handle);
    const outcome = await adapter.classify(artifacts);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failureClass, "schema-invalid");
    assert.match(outcome.reason ?? "", /verdict/);
  });
});

test("a run that emits no output for longer than the idle budget stays silent through that stretch, then completes", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "idle-timeout");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));

    const iterator = adapter.observe(handle)[Symbol.asyncIterator]();
    const firstEventAt = Date.now();
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.ok(Date.now() - firstEventAt >= 300, "the stream must stay silent past the idle budget before its first event");

    const rest: NormalizedEvent[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      rest.push(next.value);
    }
    const artifacts = await adapter.collect(handle);
    const outcome = await adapter.classify(artifacts);
    assert.equal(outcome.ok, true);
  });
});

test("a process that exits non-zero with no report classifies worker-crash", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "nonzero-exit");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    await drain(adapter.observe(handle));
    const artifacts = await adapter.collect(handle);
    assert.equal(artifacts.exitCode, 1);
    assert.equal(artifacts.candidateReportText, null);
    const outcome = await adapter.classify(artifacts);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failureClass, "worker-crash");
  });
});

test("a process that traps SIGTERM is actually killed by cancel via the supplied terminate callback", async () => {
  await withTempWorkspace(async (dir) => {
    const adapter = new FakeAdapter({ terminate });
    const desc = attempt("implement", "sigterm-trap");
    const handle = await adapter.start(desc, "packet body", await surfaceIn(dir));
    try {
      assert.ok(handle.pid > 0);
      assert.equal(handle.pgid, handle.pid);
      assert.ok(isAlive(handle.pgid), "the replayed process must be a real, live process group");

      // The scripted stream traps SIGTERM only after emitting its first output line, so
      // observing that line first guarantees the trap is installed before cancel fires
      // (the script's own next step, the long sleep, is what actually yields back to its
      // event loop; everything before it runs synchronously).
      const iterator = adapter.observe(handle)[Symbol.asyncIterator]();
      await iterator.next();

      const report = await adapter.cancel(handle, 200);
      assert.equal(report.attemptId, desc.attemptId);
      assert.equal(report.killedProcessTree, true);
      assert.equal(report.signalSent, "SIGKILL");
      assert.equal(isAlive(handle.pgid), false);
    } finally {
      if (isAlive(handle.pgid)) {
        await terminate({ pid: handle.pid, pgid: handle.pgid }, 50);
      }
    }
  });
});

test("probe reports the nine CapabilityReport fields without touching credential files", async () => {
  const adapter = new FakeAdapter({ terminate });
  const report = await adapter.probe({
    executablePath: "/usr/local/bin/fake-vendor",
    requestedModel: "fake-model",
    requestedEffort: "medium",
    workingDirectory: process.cwd(),
    environment: {},
  });
  assert.deepEqual(Object.keys(report).sort(), [
    "adapterVersion",
    "authenticationOutcome",
    "cliVersion",
    "executablePath",
    "permissionAndSandboxConfiguration",
    "requestedEffort",
    "requestedModel",
    "structuredOutputMode",
    "workingDirectoryBehavior",
  ]);
  assert.equal(report.requestedModel, "fake-model");
});
