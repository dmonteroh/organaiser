// Fixture: board-parallelism.
//
// Five independent claims about the board scheduler's dispatch gating and,
// for the two claim-shaped ones, its per-tick worker-slot concurrency:
// `dependencyOrder`, `operatorBlockDoesNotGlobalStop`, and
// `terminalTaskNeverDispatches` drive a real `spawnFixtureSupervisor`
// process against a seeded pair of tasks; `claimOverlapSerializes` and
// `disjointClaimsParallelize` call `dispatchEligible` directly, in-process,
// with a hand-built multi-slot `DispatchProfile`, since
// `spawnFixtureSupervisor`'s own `test-supervisor.ts` never threads a
// `DispatchProfile` through and so can never exercise `maxWorkerSlots > 1`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  ProcessRegistry,
  waitFor,
  startFixtureRun,
  seedTasks,
  countRows,
  spawnFixtureSupervisor,
  writeStream,
  wellFormedStream,
  withFixtureWorkspace,
  openStore,
  withTransaction,
  recordedPgidsForRun,
} from "./harness.ts";
import { createSchedulerRuntime, dispatchEligible, type DispatchProfile } from "../../src/engine/scheduler.ts";
import type { TickContext } from "../../src/engine/tick.ts";
import { FakeAdapter, type TerminateFn } from "../../src/adapters/fake.ts";
import type { ResolvedVendorProfile } from "../../src/cli/profiles.ts";

const TICK_INTERVAL_MS = 100;

const stubTerminate: TerminateFn = async ({ pgid }) => {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
  return { signalSent: "SIGKILL", exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
};

function fakeVendorProfile(): ResolvedVendorProfile {
  return {
    executable: "fake",
    model: "fake",
    effort: "medium",
    permissionMode: "default",
    sandboxMode: "workspace-write",
    toolPolicy: { allowedTools: [], disallowedTools: [] },
    environmentAllowlist: [],
    timeouts: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
    budgetUsd: null,
    maxConcurrentProcesses: 2,
  };
}

function twoSlotDispatchProfile(): DispatchProfile {
  return {
    vendor: "fake",
    profile: fakeVendorProfile(),
    cliVersion: null,
    workflowRevision: null,
    authenticationOutcome: "authenticated",
    isKnownBadVersion: false,
    concurrency: { maxWorkerSlots: 2, vendorSlots: { codex: 2, claude: 2 } },
  };
}

export async function dependencyOrder(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [
        { id: "task-blocker" },
        { id: "task-dependent", dependsOn: ["task-blocker"] },
      ]);
      const now = Date.now();
      const blockerBriefPath = path.join(dir, "task-blocker-brief.md");
      fs.writeFileSync(blockerBriefPath, "# task-blocker\n");
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-blocker", runId, "task-blocker", "task-blocker", blockerBriefPath, "dev-workflow", "implementation", "[]", 1, "defined", null, now, now);
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-dependent", runId, "task-dependent", "task-dependent", "brief.md", "dev-workflow", "implementation", '["task-blocker"]', 0, "defined", null, now, now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(
        streamsDir,
        "implementation",
        "task-blocker",
        wellFormedStream({ taskId: "task-blocker", stageId: "implementation" }),
      );
      // task-dependent deliberately has no stream: if it ever dispatched
      // ahead of its unresolved dependency it would crash on the missing
      // file rather than proving the ordering claim.

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      const blockerDispatched = await waitFor(
        () => countRows(dir, `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-blocker'`, runId) === 1,
        5000,
      );
      assert.ok(blockerDispatched, "the unblocked dependency must dispatch");

      const dependentAttempts = countRows(
        dir,
        `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-dependent'`,
        runId,
      );
      assert.equal(dependentAttempts, 0, "a task must never dispatch ahead of its unsatisfied dependency");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function operatorBlockDoesNotGlobalStop(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-blocked" }, { id: "task-clear" }]);
      const now = Date.now();
      const clearBriefPath = path.join(dir, "task-clear-brief.md");
      fs.writeFileSync(clearBriefPath, "# task-clear\n");
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-blocked", runId, "task-blocked", "task-blocked", "brief.md", "dev-workflow", "implementation", "[]", 0, "defined", null, now, now);
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-clear", runId, "task-clear", "task-clear", clearBriefPath, "dev-workflow", "implementation", "[]", 1, "defined", null, now, now);
          db.prepare(
            `INSERT INTO questions (id, run_id, task_id, owner, blocking_scope, prompt, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("question-task-blocked", runId, "task-blocked", "operator", "task", "needs a decision", "open", now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(
        streamsDir,
        "implementation",
        "task-clear",
        wellFormedStream({ taskId: "task-clear", stageId: "implementation" }),
      );
      // task-blocked deliberately has no stream: an open blocking question
      // must keep it from ever reaching dispatch.

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      const clearDispatched = await waitFor(
        () => countRows(dir, `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-clear'`, runId) === 1,
        5000,
      );
      assert.ok(clearDispatched, "an unrelated, unblocked task must still dispatch");

      const blockedAttempts = countRows(
        dir,
        `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-blocked'`,
        runId,
      );
      assert.equal(blockedAttempts, 0, "a task with an open blocking question must never dispatch");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function terminalTaskNeverDispatches(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-terminal" }, { id: "task-active" }]);
      const now = Date.now();
      const activeBriefPath = path.join(dir, "task-active-brief.md");
      fs.writeFileSync(activeBriefPath, "# task-active\n");
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-terminal", runId, "task-terminal", "task-terminal", "brief.md", "dev-workflow", "implementation", "[]", 0, "integrated", "integrated", now, now);
          db.prepare(
            `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("task-active", runId, "task-active", "task-active", activeBriefPath, "dev-workflow", "implementation", "[]", 1, "defined", null, now, now);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(
        streamsDir,
        "implementation",
        "task-active",
        wellFormedStream({ taskId: "task-active", stageId: "implementation" }),
      );
      // task-terminal deliberately has no stream: a task whose disposition
      // is already terminal must never be selected as a dispatch candidate.

      const supervisor = spawnFixtureSupervisor(dir, runId, {
        tickIntervalMs: TICK_INTERVAL_MS,
        operatorPollWindowMs: TICK_INTERVAL_MS * 4,
        cancelGraceMs: TICK_INTERVAL_MS,
        streamsDir,
      });
      registry.track(supervisor.pid);

      const activeDispatched = await waitFor(
        () => countRows(dir, `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-active'`, runId) === 1,
        5000,
      );
      assert.ok(activeDispatched, "an active task must still dispatch while a terminal task sits alongside it");

      const terminalAttempts = countRows(
        dir,
        `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id = 'task-terminal'`,
        runId,
      );
      assert.equal(terminalAttempts, 0, "a task with a non-null disposition must never be selected as a dispatch candidate");
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function claimOverlapSerializes(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }, { id: "task-b" }]);
      const now = Date.now();
      seedTasks(
        dir,
        runId,
        [
          { id: "task-a", claimedPaths: ["shared.txt"] },
          { id: "task-b", claimedPaths: ["shared.txt"] },
        ],
        now,
      );
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(`UPDATE tasks SET stage_id = 'integration' WHERE run_id = ? AND id IN ('task-a', 'task-b')`).run(runId);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "integration", "task-a", wellFormedStream({ taskId: "task-a", stageId: "integration" }));
      writeStream(streamsDir, "integration", "task-b", wellFormedStream({ taskId: "task-b", stageId: "integration" }));

      const adapter = new FakeAdapter({ terminate: stubTerminate, streamsDir, scenarioFor: (attempt) => attempt.taskId });
      const runtime = createSchedulerRuntime();
      const ctx: TickContext = {
        db: openStore(dir),
        runId,
        tickIndex: 0,
        now: () => now,
        leaseDeadlineMs: now + 60000,
        signal: new AbortController().signal,
      };
      try {
        try {
          await dispatchEligible(ctx, runtime, adapter, undefined, twoSlotDispatchProfile());
        } finally {
          for (const pgid of recordedPgidsForRun(dir, runId)) registry.track(pgid);
        }

        assert.equal(
          runtime.liveAttemptByTaskId.size,
          1,
          "two tasks with overlapping claims must never hold live attempts simultaneously",
        );
      } finally {
        ctx.db.close();
      }
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}

export async function disjointClaimsParallelize(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    try {
      const { runId } = startFixtureRun(dir, [{ id: "task-a" }, { id: "task-b" }]);
      const now = Date.now();
      seedTasks(
        dir,
        runId,
        [
          { id: "task-a", claimedPaths: ["a.txt"] },
          { id: "task-b", claimedPaths: ["b.txt"] },
        ],
        now,
      );
      const db = openStore(dir);
      try {
        withTransaction(db, () => {
          db.prepare(`UPDATE tasks SET stage_id = 'integration' WHERE run_id = ? AND id IN ('task-a', 'task-b')`).run(runId);
        });
      } finally {
        db.close();
      }

      const streamsDir = path.join(dir, "streams");
      writeStream(streamsDir, "integration", "task-a", wellFormedStream({ taskId: "task-a", stageId: "integration" }));
      writeStream(streamsDir, "integration", "task-b", wellFormedStream({ taskId: "task-b", stageId: "integration" }));

      const adapter = new FakeAdapter({ terminate: stubTerminate, streamsDir, scenarioFor: (attempt) => attempt.taskId });
      const runtime = createSchedulerRuntime();
      const ctx: TickContext = {
        db: openStore(dir),
        runId,
        tickIndex: 0,
        now: () => now,
        leaseDeadlineMs: now + 60000,
        signal: new AbortController().signal,
      };
      try {
        try {
          await dispatchEligible(ctx, runtime, adapter, undefined, twoSlotDispatchProfile());
        } finally {
          for (const pgid of recordedPgidsForRun(dir, runId)) registry.track(pgid);
        }

        assert.equal(
          runtime.liveAttemptByTaskId.size,
          2,
          "two tasks with disjoint claims must both hold live attempts in the same tick",
        );
        assert.ok(runtime.liveAttemptByTaskId.has("task-a"));
        assert.ok(runtime.liveAttemptByTaskId.has("task-b"));
      } finally {
        ctx.db.close();
      }
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
