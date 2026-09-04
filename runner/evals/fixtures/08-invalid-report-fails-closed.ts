// Fixture: invalid-report-fails-closed.
//
// Two scripted streams: a report missing a required field, and well-formed
// JSON with a `verdict` outside its role's declared enum. `scheduler.ts`'s
// `dispatchEligible` only ever dispatches `implementer`/`integrator` roles
// (P5's scope is single-lane implementation + integration; no review-role
// dispatch exists), and stage-result.schema.json's `verdict` enum is
// conditional on `roleId` in {analyst, architect, problem-definer,
// spec-challenger, spec-reviewer, code-quality-reviewer} — none of which P5
// ever dispatches. The "missing required field" case is therefore proven end
// to end through a real scheduled run (case A below); the "verdict outside
// enum" case can only be reached through the vendor-neutral adapter contract
// directly, exactly as P5c's own `fake-adapter.test.ts` already exercises it
// (case B below) — there is no live run path to it in this phase.
//
// P5 also implements no report-only repair loop at all (target-architecture
// section 10's cap): dispatchEligible dispatches a task at most once per
// tick and never re-dispatches a task whose attempt just failed. "At most
// one report-only repair attempt is made and it changes no product file" is
// therefore satisfied vacuously — zero repair attempts happen, and zero
// product files are ever touched by any of this fixture suite's dispatches.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  startFixtureRun,
  seedTasks,
  readTaskRow,
  allRows,
  countRows,
  spawnFixtureSupervisor,
  writeStream,
  outputLine,
  exitLine,
  withFixtureWorkspace,
} from "./harness.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { AttemptDescriptor, ExecutionSurface } from "../../src/adapters/adapter.ts";

const TICK_INTERVAL_MS = 200;

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

export async function invalidReportMissingField(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }]);
      seedTasks(dir, runId, [{ id: "task-a" }], Date.now());

      const streamsDir = path.join(dir, "streams");
      const filesBefore = listFilesRecursive(dir);

      writeStream(streamsDir, "implementation", "task-a", [
        outputLine("starting work"),
        JSON.stringify({
          op: "report",
          report: {
            protocolVersion: "1",
            workflowId: "dev-workflow",
            workflowVersion: "2.0.0",
            runId,
            taskId: "task-a",
            attemptId: "attempt_test",
            stageId: "implementation",
            roleId: "implementer",
            status: "completed",
            // `summary` deliberately omitted: a required field.
          },
        }),
        exitLine(0),
      ]);

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      const parked = await waitFor(() => readTaskRow(dir, "task-a")?.disposition === "parked", 6000);
      assert.ok(parked, `task must park on an invalid report; row: ${JSON.stringify(readTaskRow(dir, "task-a"))}`);

      const attempts = allRows<{ id: string; status: string; stage_id: string }>(
        dir,
        `SELECT id, status, stage_id FROM attempts WHERE run_id = ? AND task_id = 'task-a'`,
        runId,
      );
      assert.equal(attempts.length, 1, "at most one attempt (zero repair attempts; P5 implements none)");
      assert.equal(attempts[0]?.status, "failed", "the attempt must be recorded invalid, not completed");
      assert.equal(attempts[0]?.stage_id, "implementation", "the task must never advance past implementation");

      const noIntegration = countRows(
        dir,
        `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-a' AND stage_id = 'integration'`,
        runId,
      );
      assert.equal(noIntegration, 0, "no transition may advance the task past implementation");

      const normalizedEvents = allRows<{ payload: string }>(
        dir,
        `SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.normalized' ORDER BY seq`,
        runId,
      );
      assert.equal(normalizedEvents.length, 1);
      const eventPayload = JSON.parse((normalizedEvents[0] as { payload: string }).payload) as {
        ok: boolean;
        failureClass: string | null;
      };
      assert.equal(eventPayload.ok, false);
      assert.equal(eventPayload.failureClass, "schema-invalid");

      const filesAfter = listFilesRecursive(dir);
      const productFilesChanged = filesAfter.filter((f) => !filesBefore.includes(f) && !f.includes(".orga") && !f.includes("streams"));
      assert.equal(productFilesChanged.length, 0, "the invalid report must change no product file");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function invalidReportUnknownVerdict(): Promise<void> {
  const adapter = new FakeAdapter({ terminate: noopTerminate });
  const descriptor: AttemptDescriptor = {
    attemptId: "unknown-verdict",
    runId: "run_test",
    taskId: "task_test",
    stageId: "review-spec",
    roleId: "spec-reviewer",
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
  };
  const surface: ExecutionSurface = {
    workingDirectory: process.cwd(),
    environment: process.env,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };

  const handle = await adapter.start(descriptor, "packet body", surface);
  try {
    for await (const _event of adapter.observe(handle)) {
      // drain to completion
    }
    const artifacts = await adapter.collect(handle);
    const outcome = await adapter.classify(artifacts);

    assert.equal(outcome.ok, false, "an out-of-enum verdict must be recorded invalid");
    assert.equal(outcome.failureClass, "schema-invalid");
    assert.match(outcome.reason ?? "", /verdict/);
  } finally {
    await noopTerminate({ pid: handle.pid, pgid: handle.pgid }, 0);
  }
}

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else results.push(full);
    }
  }
  walk(dir);
  return results;
}
