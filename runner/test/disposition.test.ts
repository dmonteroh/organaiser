import { test } from "node:test";
import assert from "node:assert/strict";

import {
  recomputeDisposition,
  compareDisposition,
  deriveVerificationFact,
} from "../src/engine/disposition.ts";
import type { Facts } from "../src/engine/predicates.ts";
import type { BarrierAttemptRecord } from "../src/engine/barrier.ts";

function baseFacts(overrides: Partial<Facts> = {}): Facts {
  return {
    verificationMode: "legacy",
    frontmatterStatus: "Done",
    integrationCommit: "abc1234",
    integrationCommitExists: true,
    integrationCommitIsAncestor: true,
    implementerCommits: ["abc1234"],
    implementerCommitsAllExist: true,
    reuseLanded: false,
    specReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
    qualityReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
    verification: { status: "pass" },
    ...overrides,
  };
}

test("recomputeDisposition returns integrated with no gaps when accept() accepts", () => {
  const result = recomputeDisposition(baseFacts());
  assert.deepEqual(result, { state: "integrated", gaps: [] });
});

test("recomputeDisposition returns not-integrated carrying accept()'s gaps otherwise", () => {
  const result = recomputeDisposition(baseFacts({ frontmatterStatus: "Approved" }));
  assert.equal(result.state, "not-integrated");
  assert.deepEqual(result.gaps, ["status"]);
});

test("compareDisposition: agree when stored integrated and recomputed integrated", () => {
  assert.equal(
    compareDisposition({ state: "integrated", gaps: [] }, "integrated"),
    "agree",
  );
});

test("compareDisposition: diverged when stored integrated and recomputed not-integrated", () => {
  assert.equal(
    compareDisposition({ state: "not-integrated", gaps: ["status"] }, "integrated"),
    "diverged",
  );
});

test("compareDisposition: not-applicable for every other stored disposition, regardless of recomputed", () => {
  const stateValues: Array<"integrated" | "not-integrated"> = ["integrated", "not-integrated"];
  const storedValues = ["superseded", "shelved", "cancelled", "parked", "waiting-operator"] as const;
  for (const stored of storedValues) {
    for (const state of stateValues) {
      assert.equal(compareDisposition({ state, gaps: [] }, stored), "not-applicable");
    }
  }
});

function makeAttempt(overrides: Partial<BarrierAttemptRecord> = {}): BarrierAttemptRecord {
  return {
    attemptId: "attempt1",
    verdict: "pass",
    failedCondition: null,
    checkResults: null,
    workerClaims: null,
    claimsParity: null,
    failureDetail: null,
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("deriveVerificationFact returns null for an empty attempts array", () => {
  assert.equal(deriveVerificationFact([], "legacy"), null);
});

test("deriveVerificationFact reports a single pass", () => {
  const attempts = [makeAttempt({ attemptId: "attempt1", verdict: "pass" })];
  assert.deepEqual(deriveVerificationFact(attempts, "legacy"), {
    status: "pass",
    mode: "legacy",
    attempt: "attempt1",
  });
});

test("deriveVerificationFact reports a single fail", () => {
  const attempts = [makeAttempt({ attemptId: "attempt1", verdict: "fail" })];
  assert.deepEqual(deriveVerificationFact(attempts, "legacy"), {
    status: "fail",
    mode: "legacy",
    attempt: "attempt1",
  });
});

test("deriveVerificationFact: a pass followed by a later fail still reports the pass", () => {
  const attempts = [
    makeAttempt({ attemptId: "attempt1", verdict: "pass" }),
    makeAttempt({ attemptId: "attempt2", verdict: "fail" }),
  ];
  assert.deepEqual(deriveVerificationFact(attempts, "declared"), {
    status: "pass",
    mode: "declared",
    attempt: "attempt1",
  });
});

test("deriveVerificationFact: a fail followed by a later pass reports the later pass", () => {
  const attempts = [
    makeAttempt({ attemptId: "attempt1", verdict: "fail" }),
    makeAttempt({ attemptId: "attempt2", verdict: "pass" }),
  ];
  assert.deepEqual(deriveVerificationFact(attempts, "legacy"), {
    status: "pass",
    mode: "legacy",
    attempt: "attempt2",
  });
});

test("deriveVerificationFact: no attempt passed falls back to the last attempt, still omits claimsParity when absent", () => {
  const attempts = [
    makeAttempt({ attemptId: "attempt1", verdict: "fail" }),
    makeAttempt({ attemptId: "attempt2", verdict: "fail" }),
  ];
  assert.deepEqual(deriveVerificationFact(attempts, "legacy"), {
    status: "fail",
    mode: "legacy",
    attempt: "attempt2",
  });
});

test("deriveVerificationFact includes claimsParity when the winning record carries one", () => {
  const attempts = [
    makeAttempt({
      attemptId: "attempt1",
      verdict: "pass",
      claimsParity: { parity: true, mode: "declared", mismatches: [] },
    }),
  ];
  assert.deepEqual(deriveVerificationFact(attempts, "declared"), {
    status: "pass",
    mode: "declared",
    attempt: "attempt1",
    claimsParity: true,
  });
});
