import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import {
  claimSetComplete,
  createAttemptRecord,
  dispatchAttempt,
  isDispatchEligible,
  permissiveOutOfScopeConditions,
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

test("dispatch.ts's four remaining out-of-scope conditions each carry a P6/P8 marker naming the phase that replaces them, and claimSetComplete/worktreeMatchesRecordedBase no longer appear in that block", () => {
  const conditionNames = ["claimsDoNotOverlapActive", "vendorSlotAvailable", "readinessProbePassed", "noControllerOrIntegrationLockConflict"];
  for (const name of conditionNames) {
    const lineMatch = dispatchSource.match(new RegExp(`^\\s*${name}: (?:boolean|true);.*$`, "m"));
    assert.ok(lineMatch, `no declaration/assignment line found for ${name}`);
  }
  // Every out-of-scope condition's hard-coded permissive assignment (in
  // `permissiveOutOfScopeConditions`) carries a `// P6:` or `// P8:` marker,
  // so a later phase narrowing scope cannot silently drop one.
  const permissiveBlock = dispatchSource.slice(
    dispatchSource.indexOf("export function permissiveOutOfScopeConditions"),
    dispatchSource.indexOf("export interface ClaimSetCompleteInput"),
  );
  const markerCount = (permissiveBlock.match(/\/\/ P[68]:/g) ?? []).length;
  assert.equal(markerCount, 4, "expected exactly four P6/P8 markers, one per remaining out-of-scope condition");
  assert.ok(!permissiveBlock.includes("claimSetComplete"), "claimSetComplete must not appear inside the permissive block");
  assert.ok(!permissiveBlock.includes("worktreeMatchesRecordedBase"), "worktreeMatchesRecordedBase must not appear inside the permissive block");

  const conditionsInterface = dispatchSource.slice(
    dispatchSource.indexOf("export interface DispatchConditions"),
    dispatchSource.indexOf("export function permissiveOutOfScopeConditions"),
  );
  assert.match(conditionsInterface, /claimSetComplete: boolean;/);
  assert.match(conditionsInterface, /worktreeMatchesRecordedBase: boolean;/);
});

test("isDispatchEligible: the ten-condition conjunction requires every condition, and priority filtering never bypasses it", () => {
  const allTrue: DispatchConditions = {
    dependenciesSatisfied: true,
    noUnresolvedBlockingQuestion: true,
    stageInputArtifactsValid: true,
    workerSlotAvailable: true,
    claimSetComplete: true,
    worktreeMatchesRecordedBase: true,
    ...permissiveOutOfScopeConditions(),
  };
  assert.equal(isDispatchEligible(allTrue), true);

  for (const key of Object.keys(allTrue) as Array<keyof DispatchConditions>) {
    assert.equal(isDispatchEligible({ ...allTrue, [key]: false }), false, `${key} must be a hard requirement`);
  }
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
