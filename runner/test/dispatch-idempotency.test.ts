import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import {
  claimSetComplete,
  claimsDoNotOverlapActive,
  createAttemptRecord,
  dispatchAttempt,
  isDispatchEligible,
  noControllerOrIntegrationLockConflict,
  readinessProbePassed,
  vendorSlotAvailable,
  worktreeMatchesRecordedBase,
  type AttemptRecordInput,
  type DispatchAttemptInput,
  type DispatchConditions,
} from "../src/engine/dispatch.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const dispatchSourcePath = fileURLToPath(new URL("../src/engine/dispatch.ts", import.meta.url));
const dispatchSource = fs.readFileSync(dispatchSourcePath, "utf8");

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "starting", now);
  });
}

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function baseAttemptInput(overrides: Partial<AttemptRecordInput> = {}): AttemptRecordInput {
  return {
    attemptId: "attempt-a",
    runId: "run-1",
    taskId: "task-1",
    stageId: "implementation",
    role: "implementer",
    round: 1,
    inputVersion: "v1",
    vendor: "fake",
    model: "fake",
    configJson: "{}",
    mutating: true,
    ...overrides,
  };
}

test("createAttemptRecord: a duplicate idempotency key is rejected rather than inserted as a second row", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);

      const first = createAttemptRecord(db, baseAttemptInput(), 1000);
      assert.equal(first.created, true);

      const second = createAttemptRecord(db, baseAttemptInput({ attemptId: "attempt-b" }), 1001);
      assert.equal(second.created, false);
      if (!second.created) {
        assert.equal(second.reason, "duplicate");
      }

      const rows = db.prepare("SELECT id FROM attempts WHERE run_id = ?").all("run-1") as Array<{ id: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, "attempt-a");
    } finally {
      db.close();
    }
  });
});

test("createAttemptRecord: a different round or input_version is not a duplicate", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      const first = createAttemptRecord(db, baseAttemptInput(), 1000);
      assert.equal(first.created, true);

      const differentRound = createAttemptRecord(
        db,
        baseAttemptInput({ attemptId: "attempt-b", round: 2 }),
        1001,
      );
      assert.equal(differentRound.created, true);

      const rows = db.prepare("SELECT id FROM attempts WHERE run_id = ?").all("run-1") as Array<{ id: string }>;
      assert.equal(rows.length, 2);
    } finally {
      db.close();
    }
  });
});

test("dispatchAttempt: two dispatch calls racing the same key yield exactly one attempts row, one worker, and one spawned attempt", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-2", 1000);
      const adapter = new FakeAdapter({ terminate: noopTerminate, scenarioFor: () => "well-formed" });

      const input: DispatchAttemptInput = {
        runId: "run-2",
        taskId: "task-2",
        stageId: "implement",
        role: "implementer",
        round: 1,
        inputVersion: "v1",
        vendor: "fake",
        model: "fake",
        configJson: "{}",
        mutating: true,
        timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
        workingDirectory: dir,
        environment: process.env,
        packet: "packet body",
      };

      const [first, second] = await Promise.all([
        dispatchAttempt(db, adapter, input, () => 2000),
        dispatchAttempt(db, adapter, input, () => 2001),
      ]);

      const results = [first, second];
      const dispatched = results.filter((r) => r.dispatched);
      const duplicates = results.filter((r) => !r.dispatched);
      assert.equal(dispatched.length, 1, "exactly one caller should win the race");
      assert.equal(duplicates.length, 1, "the loser should observe a duplicate, not spawn a second worker");

      const attemptRows = db.prepare("SELECT id, status FROM attempts WHERE run_id = ?").all("run-2") as Array<{
        id: string;
        status: string;
      }>;
      assert.equal(attemptRows.length, 1);
      assert.equal(attemptRows[0]?.status, "running");

      const workerRows = db.prepare("SELECT id FROM workers WHERE run_id = ?").all("run-2") as Array<{ id: string }>;
      assert.equal(workerRows.length, 1);
    } finally {
      db.close();
    }
  });
});

test("dispatch.ts's DispatchConditions declares all ten conditions as real boolean fields, and permissiveOutOfScopeConditions no longer exists", () => {
  assert.ok(
    !dispatchSource.includes("permissiveOutOfScopeConditions"),
    "the permissive stub function must be fully removed once nothing calls it",
  );

  const conditionsInterface = dispatchSource.slice(
    dispatchSource.indexOf("export interface DispatchConditions"),
    dispatchSource.indexOf("function parseClaimPaths"),
  );
  const conditionNames = [
    "dependenciesSatisfied",
    "noUnresolvedBlockingQuestion",
    "stageInputArtifactsValid",
    "workerSlotAvailable",
    "claimSetComplete",
    "worktreeMatchesRecordedBase",
    "claimsDoNotOverlapActive",
    "vendorSlotAvailable",
    "readinessProbePassed",
    "noControllerOrIntegrationLockConflict",
  ];
  for (const name of conditionNames) {
    assert.match(
      conditionsInterface,
      new RegExp(`${name}: boolean;`),
      `${name} must be declared as a real boolean field, not left permissive`,
    );
  }
});

test("isDispatchEligible: the ten-condition conjunction requires every condition, and priority filtering never bypasses it", () => {
  const allTrue: DispatchConditions = {
    dependenciesSatisfied: true,
    noUnresolvedBlockingQuestion: true,
    stageInputArtifactsValid: true,
    workerSlotAvailable: true,
    claimSetComplete: true,
    worktreeMatchesRecordedBase: true,
    claimsDoNotOverlapActive: true,
    vendorSlotAvailable: true,
    readinessProbePassed: true,
    noControllerOrIntegrationLockConflict: true,
  };
  assert.equal(isDispatchEligible(allTrue), true);

  for (const key of Object.keys(allTrue) as Array<keyof DispatchConditions>) {
    assert.equal(isDispatchEligible({ ...allTrue, [key]: false }), false, `${key} must be a hard requirement`);
  }
});

test("vendorSlotAvailable: a fake vendor or an absent vendorSlots map is unconditionally available, preserving the old permissive stub's behavior", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      assert.equal(
        vendorSlotAvailable(db, { runId: "run-1", vendor: "fake", vendorSlots: { codex: 1, claude: 1 } }),
        true,
        "a fake vendor is always available regardless of vendorSlots",
      );
      assert.equal(
        vendorSlotAvailable(db, { runId: "run-1", vendor: "codex", vendorSlots: undefined }),
        true,
        "no vendorSlots map at all is always available",
      );
    } finally {
      db.close();
    }
  });
});

test("vendorSlotAvailable: a real vendor is gated on the count of active, non-reaped attempts against its configured slot count", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, interrupt_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?)`,
        ).run("attempt-1", "run-1", "task-1", "implementation", "implementer", 1, "v1", "codex", "codex", "{}", 1, 1000);
        db.prepare(
          `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, worktree_id, heartbeat_at, started_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run("worker-1", "run-1", "attempt-1", 111, 111, 1000, 1000);
      });

      assert.equal(
        vendorSlotAvailable(db, { runId: "run-1", vendor: "codex", vendorSlots: { codex: 1, claude: 1 } }),
        false,
        "one live attempt already fills the single codex slot",
      );
      assert.equal(
        vendorSlotAvailable(db, { runId: "run-1", vendor: "claude", vendorSlots: { codex: 1, claude: 1 } }),
        true,
        "the live attempt is for codex, not claude",
      );

      withTransaction(db, () => {
        db.prepare(`UPDATE workers SET termination_state = 'exited', ended_at = ? WHERE id = ?`).run(2000, "worker-1");
      });
      assert.equal(
        vendorSlotAvailable(db, { runId: "run-1", vendor: "codex", vendorSlots: { codex: 1, claude: 1 } }),
        true,
        "a reaped worker no longer counts as active",
      );
    } finally {
      db.close();
    }
  });
});

test("readinessProbePassed: a fake vendor or no probe facts at all is unconditionally passed, preserving the old permissive stub's behavior", () => {
  assert.equal(
    readinessProbePassed({ vendor: "fake", probe: { authenticationOutcome: "unauthenticated", isKnownBadVersion: true } }),
    true,
  );
  assert.equal(readinessProbePassed({ vendor: "codex", probe: undefined }), true);
});

test("readinessProbePassed: a real vendor requires authentication and excludes known-bad versions", () => {
  assert.equal(
    readinessProbePassed({ vendor: "codex", probe: { authenticationOutcome: "authenticated", isKnownBadVersion: false } }),
    true,
  );
  assert.equal(
    readinessProbePassed({ vendor: "codex", probe: { authenticationOutcome: "unauthenticated", isKnownBadVersion: false } }),
    false,
  );
  assert.equal(
    readinessProbePassed({ vendor: "claude", probe: { authenticationOutcome: "authenticated", isKnownBadVersion: true } }),
    false,
  );
});

test("claimsDoNotOverlapActive: false only when an intersecting claim belongs to a task with a live, non-reaped attempt", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("claim-a", "run-1", "task-a", "files", JSON.stringify(["shared.txt"]), 1000);
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("claim-b", "run-1", "task-b", "files", JSON.stringify(["shared.txt"]), 1000);
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("claim-c", "run-1", "task-c", "files", JSON.stringify(["disjoint.txt"]), 1000);
      });

      assert.equal(
        claimsDoNotOverlapActive(db, { runId: "run-1", taskId: "task-a" }),
        true,
        "an intersecting claim with no active attempt does not block dispatch",
      );
      assert.equal(
        claimsDoNotOverlapActive(db, { runId: "run-1", taskId: "task-no-claims" }),
        true,
        "a candidate with no claim of its own has nothing to intersect",
      );

      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, interrupt_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?)`,
        ).run("attempt-b", "run-1", "task-b", "implementation", "implementer", 1, "v1", "fake", "fake", "{}", 1, 1000);
        db.prepare(
          `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, worktree_id, heartbeat_at, started_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run("worker-b", "run-1", "attempt-b", 222, 222, 1000, 1000);
      });

      assert.equal(
        claimsDoNotOverlapActive(db, { runId: "run-1", taskId: "task-a" }),
        false,
        "task-b now holds an intersecting claim and has a live attempt",
      );
      assert.equal(
        claimsDoNotOverlapActive(db, { runId: "run-1", taskId: "task-c" }),
        true,
        "task-c's claim is disjoint from every other task's",
      );
    } finally {
      db.close();
    }
  });
});

test("noControllerOrIntegrationLockConflict: false only while a live, non-stale integration lock exists for the run", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);

      assert.equal(noControllerOrIntegrationLockConflict(db, { runId: "run-1", now: 2000 }), true);

      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO locks (id, run_id, kind, resource, owner_pid, acquired_at, heartbeat_at, released_at)
           VALUES (?, ?, 'integration', ?, ?, ?, ?, NULL)`,
        ).run("lock-1", "run-1", "refs/heads/main", process.pid, 1000, 2000);
      });

      assert.equal(
        noControllerOrIntegrationLockConflict(db, { runId: "run-1", now: 2500 }),
        false,
        "a fresh integration lock blocks dispatch",
      );
      assert.equal(
        noControllerOrIntegrationLockConflict(db, { runId: "run-1", now: 2500 + 300000 }),
        true,
        "a stale integration lock no longer blocks dispatch",
      );

      withTransaction(db, () => {
        db.prepare(`UPDATE locks SET released_at = ? WHERE id = ?`).run(3000, "lock-1");
      });
      assert.equal(noControllerOrIntegrationLockConflict(db, { runId: "run-1", now: 3001 }), true);
    } finally {
      db.close();
    }
  });
});

test("claimSetComplete: table-driven over mutating/provider/claims-row combinations", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("claim-1", "run-1", "task-with-claims", "files", JSON.stringify(["a.txt"]), 1000);
      });

      const cases: Array<{ name: string; input: Parameters<typeof claimSetComplete>[1]; expected: boolean }> = [
        {
          name: "non-mutating dispatch is always complete",
          input: { runId: "run-1", taskId: "task-no-claims", mutating: false, workspaceProviderPresent: true },
          expected: true,
        },
        {
          name: "no workspace provider is always complete",
          input: { runId: "run-1", taskId: "task-no-claims", mutating: true, workspaceProviderPresent: false },
          expected: true,
        },
        {
          name: "mutating, provider present, no claims row",
          input: { runId: "run-1", taskId: "task-no-claims", mutating: true, workspaceProviderPresent: true },
          expected: false,
        },
        {
          name: "mutating, provider present, a claims row exists",
          input: { runId: "run-1", taskId: "task-with-claims", mutating: true, workspaceProviderPresent: true },
          expected: true,
        },
      ];

      for (const { name, input, expected } of cases) {
        assert.equal(claimSetComplete(db, input), expected, name);
      }
    } finally {
      db.close();
    }
  });
});

test("worktreeMatchesRecordedBase: table-driven over no-row/matching-handle/leftover-row combinations", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      insertRun(db, "run-1", 1000);
      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO worktrees (id, run_id, task_id, path, branch, base_commit, cleanup_state, created_at, cleaned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run("wt-1", "run-1", "task-active", "/tmp/wt-1", "orga/task/task-active", "abc123", "active", 1000);
        db.prepare(
          `INSERT INTO worktrees (id, run_id, task_id, path, branch, base_commit, cleanup_state, created_at, cleaned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("wt-2", "run-1", "task-cleaned", "/tmp/wt-2", "orga/task/task-cleaned", "def456", "cleaned", 1000, 1001);
      });

      const cases: Array<{ name: string; input: Parameters<typeof worktreeMatchesRecordedBase>[1]; expected: boolean }> = [
        {
          name: "no active worktrees row: nothing to match",
          input: { runId: "run-1", taskId: "task-with-no-row", heldBaseCommit: null },
          expected: true,
        },
        {
          name: "an active row but a cleaned row is irrelevant: still nothing to match",
          input: { runId: "run-1", taskId: "task-cleaned", heldBaseCommit: null },
          expected: true,
        },
        {
          name: "active row, held handle matches the recorded base commit",
          input: { runId: "run-1", taskId: "task-active", heldBaseCommit: "abc123" },
          expected: true,
        },
        {
          name: "active row, held handle for a different base commit",
          input: { runId: "run-1", taskId: "task-active", heldBaseCommit: "zzz999" },
          expected: false,
        },
        {
          name: "active row, no held handle at all (a leftover blocks dispatch)",
          input: { runId: "run-1", taskId: "task-active", heldBaseCommit: null },
          expected: false,
        },
      ];

      for (const { name, input, expected } of cases) {
        assert.equal(worktreeMatchesRecordedBase(db, input), expected, name);
      }
    } finally {
      db.close();
    }
  });
});
