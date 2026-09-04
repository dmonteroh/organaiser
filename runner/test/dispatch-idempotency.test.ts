import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import {
  createAttemptRecord,
  dispatchAttempt,
  isDispatchEligible,
  permissiveOutOfScopeConditions,
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

test("dispatch.ts's six out-of-scope conditions each carry a P6/P7/P8 marker naming the phase that replaces them", () => {
  const conditionNames = [
    "claimSetComplete",
    "claimsDoNotOverlapActive",
    "vendorSlotAvailable",
    "readinessProbePassed",
    "worktreeMatchesRecordedBase",
    "noControllerOrIntegrationLockConflict",
  ];
  for (const name of conditionNames) {
    const lineMatch = dispatchSource.match(new RegExp(`^\\s*${name}: (?:boolean|true);.*$`, "m"));
    assert.ok(lineMatch, `no declaration/assignment line found for ${name}`);
  }
  // Every out-of-scope condition's hard-coded permissive assignment (in
  // `permissiveOutOfScopeConditions`) carries a `// P6:`, `// P7:`, or `// P8:`
  // marker, so a later phase narrowing scope cannot silently drop one.
  const permissiveBlock = dispatchSource.slice(
    dispatchSource.indexOf("export function permissiveOutOfScopeConditions"),
    dispatchSource.indexOf("// Priority filtering happens only after this conjunction"),
  );
  const markerCount = (permissiveBlock.match(/\/\/ P[678]:/g) ?? []).length;
  assert.equal(markerCount, 6, "expected exactly six P6/P7/P8 markers, one per out-of-scope condition");
});

test("isDispatchEligible: the ten-condition conjunction requires every condition, and priority filtering never bypasses it", () => {
  const allTrue: DispatchConditions = {
    dependenciesSatisfied: true,
    noUnresolvedBlockingQuestion: true,
    stageInputArtifactsValid: true,
    workerSlotAvailable: true,
    ...permissiveOutOfScopeConditions(),
  };
  assert.equal(isDispatchEligible(allTrue), true);

  for (const key of Object.keys(allTrue) as Array<keyof DispatchConditions>) {
    assert.equal(isDispatchEligible({ ...allTrue, [key]: false }), false, `${key} must be a hard requirement`);
  }
});
