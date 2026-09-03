import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANONICAL_CHECKS,
  ReportValidationError,
  createReportValidator,
} from "../src/compile/report-validator.ts";

const schema: object = JSON.parse(
  readFileSync(
    new URL("./fixtures/schemas/ralph-contract.schema.json", import.meta.url),
    "utf8",
  ),
);

const validator = createReportValidator(schema);

function legacyContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RESULT: "done",
    WORKER_DISPATCH_COUNT: 4,
    DISPATCH_LOG_FILE: "/run/dispatch-log.tsv",
    VERIFICATION_MODE: "legacy",
    SPEC_REVIEWER_VERDICT: "pass",
    QUALITY_REVIEWER_VERDICT: "pass",
    IMPLEMENTER_PACKET_FILE: "/run/implementer.packet.txt",
    IMPLEMENTER_REPORT_FILE: "/run/implementer.report.txt",
    IMPLEMENTER_TRANSCRIPT_FILE: "/run/implementer.transcript.txt",
    SPEC_REVIEWER_PACKET_FILE: "/run/spec-reviewer.packet.txt",
    SPEC_REVIEWER_REPORT_FILE: "/run/spec-reviewer.report.txt",
    SPEC_REVIEWER_TRANSCRIPT_FILE: "/run/spec-reviewer.transcript.txt",
    QUALITY_REVIEWER_PACKET_FILE: "/run/quality-reviewer.packet.txt",
    QUALITY_REVIEWER_REPORT_FILE: "/run/quality-reviewer.report.txt",
    QUALITY_REVIEWER_TRANSCRIPT_FILE: "/run/quality-reviewer.transcript.txt",
    INTEGRATION_COMMIT: "1ef1acf",
    SUMMARY: "gated reference + org-settings writes",
    TASK_VERIFY_STATUS: "pass",
    FINAL_VERIFY_STATUS: "pass",
    ...overrides,
  };
}

function declaredContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = legacyContract();
  delete base.TASK_VERIFY_STATUS;
  delete base.FINAL_VERIFY_STATUS;
  base.VERIFICATION_MODE = "declared";
  for (const id of CANONICAL_CHECKS) {
    const upper = id.toUpperCase();
    base[`TASK_VERIFY_${upper}_STATUS`] = "pass";
    base[`FINAL_VERIFY_${upper}_STATUS`] = "pass";
  }
  return { ...base, ...overrides };
}

test("valid legacy contract schema-validates", () => {
  const contract = validator.validateObject(legacyContract());
  assert.equal(contract.RESULT, "done");
  assert.equal(contract.VERIFICATION_MODE, "legacy");
  assert.equal(contract.TASK_VERIFY_STATUS, "pass");
});

test("valid declared contract schema-validates", () => {
  const contract = validator.validateObject(declaredContract());
  assert.equal(contract.VERIFICATION_MODE, "declared");
  assert.equal(contract.TASK_VERIFY_BUILD_STATUS, "pass");
  assert.equal(contract.FINAL_VERIFY_LINT_STATUS, "pass");
  assert.equal(contract.TASK_VERIFY_STATUS, undefined);
});

test("a non-object primitive is rejected with a single / path entry", () => {
  assert.throws(
    () => validator.validateObject("not an object"),
    (err: unknown) =>
      err instanceof ReportValidationError &&
      err.errors.length === 1 &&
      err.errors[0]?.path === "/",
  );
});

test("non-object JSON (array) is rejected with a single / path entry", () => {
  assert.throws(
    () => validator.validateObject([1, 2, 3]),
    (err: unknown) =>
      err instanceof ReportValidationError &&
      err.errors.length === 1 &&
      err.errors[0]?.path === "/",
  );
});

test("null is rejected with a single / path entry", () => {
  assert.throws(
    () => validator.validateObject(null),
    (err: unknown) =>
      err instanceof ReportValidationError &&
      err.errors.length === 1 &&
      err.errors[0]?.path === "/",
  );
});

test("missing required field is rejected with schema errors", () => {
  const bad = legacyContract();
  delete bad.RESULT;
  assert.throws(
    () => validator.validateObject(bad),
    (err: unknown) =>
      err instanceof ReportValidationError &&
      err.errors.length > 0 &&
      /schema validation/.test(err.message),
  );
});

test("wrong-typed field is rejected (WORKER_DISPATCH_COUNT must be integer)", () => {
  assert.throws(
    () => validator.validateObject(legacyContract({ WORKER_DISPATCH_COUNT: "four" })),
    (err: unknown) => err instanceof ReportValidationError && err.errors.length > 0,
  );
});

test("invalid enum value (RESULT) is rejected", () => {
  assert.throws(
    () => validator.validateObject(legacyContract({ RESULT: "maybe" })),
    (err: unknown) => err instanceof ReportValidationError,
  );
});

test("legacy contract carrying a per-check field is rejected (invalid-mixed)", () => {
  assert.throws(
    () => validator.validateObject(legacyContract({ TASK_VERIFY_BUILD_STATUS: "pass" })),
    (err: unknown) => err instanceof ReportValidationError,
  );
});

test("declared contract carrying a coarse field is rejected (invalid-mixed)", () => {
  assert.throws(
    () => validator.validateObject(declaredContract({ TASK_VERIFY_STATUS: "pass" })),
    (err: unknown) => err instanceof ReportValidationError,
  );
});

test("declared contract missing a per-check field is rejected", () => {
  const bad = declaredContract();
  delete bad.TASK_VERIFY_TEST_STATUS;
  assert.throws(
    () => validator.validateObject(bad),
    (err: unknown) => err instanceof ReportValidationError,
  );
});

test("contract with empty SUMMARY is rejected (minLength:1 enforced)", () => {
  assert.throws(
    () => validator.validateObject(legacyContract({ SUMMARY: "" })),
    (err: unknown) =>
      err instanceof ReportValidationError &&
      err.errors.length > 0 &&
      /schema validation/.test(err.message),
  );
});

test("contract with non-empty SUMMARY still passes (minLength:1 satisfied)", () => {
  const contract = validator.validateObject(legacyContract({ SUMMARY: "minimal" }));
  assert.equal(contract.SUMMARY, "minimal");
});

test("validateObject ACCEPT: valid object passes and returns the validated contract", () => {
  const obj = legacyContract();
  const result = validator.validateObject(obj);
  assert.equal(result.RESULT, "done");
  assert.equal(result.VERIFICATION_MODE, "legacy");
  assert.equal(result.WORKER_DISPATCH_COUNT, 4);
});

test("validateObject REJECT: schema-invalid object throws ReportValidationError carrying errors summary", () => {
  const bad = legacyContract({ RESULT: "maybe" });
  assert.throws(
    () => validator.validateObject(bad),
    (err: unknown) =>
      err instanceof ReportValidationError &&
      err.errors.length > 0 &&
      /schema validation/.test(err.message),
  );
});
