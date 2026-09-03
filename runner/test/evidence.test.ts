import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createLedger,
  recordEvidence,
  applyInvalidationKeys,
  appendAttempt,
  emptyEvidence,
  sha256,
  readLedger,
  writeLedger,
  ledgerPath,
  type EvidenceField,
} from "../src/store/evidence.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

test("evidence from attempt 1 and attempt 3 coexist with first-satisfier metadata", () => {
  const ledger = createLedger({
    taskId: "S111",
    specPath: "docs/.../S111.md",
    specSha256: sha256("spec-v1"),
    verificationMode: "legacy",
  });

  appendAttempt(ledger, { n: 1, outcome: "timeout", dispatched: ["implementer", "spec-reviewer"] });
  recordEvidence(ledger, "implementerCommits", ["3e5ea37", "b924593", "a9db7e9"]);
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "attempts/1/spec.md", attempt: 1 });

  appendAttempt(ledger, { n: 2, outcome: "timeout", dispatched: ["implementer", "spec-reviewer"] });

  appendAttempt(ledger, { n: 3, outcome: "exited_clean", dispatched: ["quality-reviewer"] });
  recordEvidence(ledger, "qualityReviewer", { verdict: "pass", report: "attempts/3/quality.md", attempt: 3 });
  recordEvidence(ledger, "integrationCommit", "1ef1acf");

  assert.equal((ledger.evidence.specReviewer as { attempt: number }).attempt, 1);
  assert.equal((ledger.evidence.qualityReviewer as { attempt: number }).attempt, 3);
  assert.equal((ledger.evidence.specReviewer as { report: string }).report, "attempts/1/spec.md");
  assert.equal((ledger.evidence.qualityReviewer as { report: string }).report, "attempts/3/quality.md");
  assert.deepEqual(ledger.evidence.implementerCommits, ["3e5ea37", "b924593", "a9db7e9"]);
  assert.equal(ledger.evidence.integrationCommit, "1ef1acf");
  assert.equal(ledger.attempts.length, 3);
});

test("first satisfier wins — a later attempt does not overwrite an earlier reviewer pass", () => {
  const ledger = createLedger({ taskId: "T", specPath: "s.md", specSha256: sha256("x") });
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "a/1", attempt: 1 });
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "a/2", attempt: 2 });
  assert.equal((ledger.evidence.specReviewer as { attempt: number }).attempt, 1);
  assert.equal((ledger.evidence.specReviewer as { report: string }).report, "a/1");
});

test("implementer commits accrete as a de-duplicated union across attempts", () => {
  const ledger = createLedger({ taskId: "T", specPath: "s.md", specSha256: sha256("x") });
  recordEvidence(ledger, "implementerCommits", ["aaa", "bbb"]);
  recordEvidence(ledger, "implementerCommits", ["bbb", "ccc"]);
  assert.deepEqual(ledger.evidence.implementerCommits, ["aaa", "bbb", "ccc"]);
});

test("recordEvidence rejects an unknown field", () => {
  const ledger = createLedger({ taskId: "T", specPath: "s.md", specSha256: sha256("x") });
  assert.throws(
    () => recordEvidence(ledger, "bogus" as EvidenceField, {}),
    /unknown evidence field/,
  );
});

test("applyInvalidationKeys clears accreted evidence when specSha256 changes", () => {
  const ledger = createLedger({
    taskId: "S111",
    specPath: "s.md",
    specSha256: sha256("spec-v1"),
    verificationMode: "legacy",
  });
  recordEvidence(ledger, "implementerCommits", ["3e5ea37"]);
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "a/1", attempt: 1 });
  recordEvidence(ledger, "qualityReviewer", { verdict: "pass", report: "a/3", attempt: 3 });
  recordEvidence(ledger, "integrationCommit", "1ef1acf");
  ledger.state = "accepted";

  const invalidated = applyInvalidationKeys(ledger, {
    specSha256: sha256("spec-v2-edited"),
    workflowVersion: null,
    reviewedCommit: null,
    contextSnapshot: null,
  });

  assert.equal(invalidated, true, "invalidation should fire on hash change");
  assert.deepEqual(ledger.evidence, emptyEvidence(), "all accreted evidence cleared");
  assert.equal(ledger.specSha256, sha256("spec-v2-edited"));
  assert.equal(ledger.state, "pending");
});

test("applyInvalidationKeys clears accreted evidence when workflowVersion changes", () => {
  const ledger = createLedger({
    taskId: "T",
    specPath: "s.md",
    specSha256: sha256("x"),
    workflowVersion: "1.0.0",
  });
  appendAttempt(ledger, { n: 1, outcome: "timeout" });
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "a/1", attempt: 1 });

  const invalidated = applyInvalidationKeys(ledger, {
    specSha256: sha256("x"),
    workflowVersion: "1.1.0",
    reviewedCommit: null,
    contextSnapshot: null,
  });

  assert.equal(invalidated, true);
  assert.deepEqual(ledger.evidence, emptyEvidence());
  assert.equal(ledger.state, "pending");
  assert.equal(ledger.workflowVersion, "1.1.0");
  assert.equal(ledger.attempts.length, 1, "attempts history is preserved");
});

test("applyInvalidationKeys clears accreted evidence when reviewedCommit changes", () => {
  const ledger = createLedger({
    taskId: "T",
    specPath: "s.md",
    specSha256: sha256("x"),
    reviewedCommit: "aaa111",
  });
  appendAttempt(ledger, { n: 1, outcome: "timeout" });
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "a/1", attempt: 1 });

  const invalidated = applyInvalidationKeys(ledger, {
    specSha256: sha256("x"),
    workflowVersion: null,
    reviewedCommit: "bbb222",
    contextSnapshot: null,
  });

  assert.equal(invalidated, true);
  assert.deepEqual(ledger.evidence, emptyEvidence());
  assert.equal(ledger.state, "pending");
  assert.equal(ledger.reviewedCommit, "bbb222");
  assert.equal(ledger.attempts.length, 1, "attempts history is preserved");
});

test("applyInvalidationKeys clears accreted evidence when contextSnapshot changes", () => {
  const ledger = createLedger({
    taskId: "T",
    specPath: "s.md",
    specSha256: sha256("x"),
    contextSnapshot: sha256("context-v1"),
  });
  appendAttempt(ledger, { n: 1, outcome: "timeout" });
  recordEvidence(ledger, "specReviewer", { verdict: "pass", report: "a/1", attempt: 1 });

  const invalidated = applyInvalidationKeys(ledger, {
    specSha256: sha256("x"),
    workflowVersion: null,
    reviewedCommit: null,
    contextSnapshot: sha256("context-v2"),
  });

  assert.equal(invalidated, true);
  assert.deepEqual(ledger.evidence, emptyEvidence());
  assert.equal(ledger.state, "pending");
  assert.equal(ledger.contextSnapshot, sha256("context-v2"));
  assert.equal(ledger.attempts.length, 1, "attempts history is preserved");
});

test("applyInvalidationKeys is a no-op when the key set is unchanged", () => {
  const sameSha = sha256("spec-v1");
  const ledger = createLedger({
    taskId: "T",
    specPath: "s.md",
    specSha256: sameSha,
    workflowVersion: "1.0.0",
    reviewedCommit: "aaa111",
    contextSnapshot: sha256("context-v1"),
  });
  recordEvidence(ledger, "implementerCommits", ["aaa"]);

  const invalidated = applyInvalidationKeys(ledger, {
    specSha256: sameSha,
    workflowVersion: "1.0.0",
    reviewedCommit: "aaa111",
    contextSnapshot: sha256("context-v1"),
  });

  assert.equal(invalidated, false);
  assert.deepEqual(ledger.evidence.implementerCommits, ["aaa"], "evidence preserved");
});

test("writeLedger / readLedger round-trips through disk", async () => {
  await withTempWorkspace(async (dir) => {
    const ledger = createLedger({ taskId: "T", specPath: "s.md", specSha256: sha256("x") });
    recordEvidence(ledger, "integrationCommit", "deadbee");
    const file = writeLedger(dir, ledger);
    assert.equal(file, ledgerPath(dir));
    assert.equal((readLedger(dir) as { evidence: { integrationCommit: unknown } }).evidence.integrationCommit, "deadbee");
  });
});

test("readLedger returns null when no ledger exists", async () => {
  await withTempWorkspace(async (dir) => {
    assert.equal(readLedger(dir), null);
  });
});

test("re-recording a captured commit across attempts does not duplicate it", () => {
  const ledger = createLedger({ taskId: "T", specPath: null, specSha256: null });
  const captured = ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"];
  recordEvidence(ledger, "implementerCommits", captured);
  recordEvidence(ledger, "implementerCommits", captured);
  assert.deepEqual(ledger.evidence.implementerCommits, captured, "union dedups by exact SHA");
});
