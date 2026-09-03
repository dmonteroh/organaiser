import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CANONICAL_CHECKS } from "../src/compile/report-validator.ts";
import {
  InvalidCheckError,
  computeClaimsParity,
  normalizeCheck,
  parseClaimsTsv,
  runCheck,
  runChecks,
  writeClaimsTsv,
  type VerificationCheck,
} from "../src/engine/verification.ts";

function declaredReport(statuses: Record<string, string>): Record<string, unknown> {
  const report: Record<string, unknown> = { VERIFICATION_MODE: "declared" };
  for (const id of CANONICAL_CHECKS) {
    const upper = id.toUpperCase();
    report[`TASK_VERIFY_${upper}_STATUS`] = statuses[id];
    report[`FINAL_VERIFY_${upper}_STATUS`] = statuses[id];
  }
  return report;
}

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ctx = { cwd: process.cwd(), env: process.env };

// ── legacy mode imposes no parity obligation ─────────────────────────────────
test("legacy mode imposes no parity obligation", () => {
  const result = computeClaimsParity(null, path.join(os.tmpdir(), "no-such-claims.tsv"), "legacy");
  assert.equal(result.parity, true);
  assert.equal(result.mode, "legacy");
  assert.deepEqual(result.mismatches, []);
});

// ── declared mode parity passes when report matches controller TSV ───────────
test("declared mode parity PASSES when the report matches controller TSV", () => {
  withTempDir("rv03-parity-pass-", (dir) => {
    const tsv = path.join(dir, "verify.claims.tsv");
    writeClaimsTsv(tsv, { build: "pass", typecheck: "pass", test: "pass", lint: "pass" });

    const report = declaredReport({ build: "pass", typecheck: "pass", test: "pass", lint: "pass" });
    const result = computeClaimsParity(report, tsv, "declared");
    assert.equal(result.parity, true, JSON.stringify(result.mismatches));
    assert.deepEqual(result.mismatches, []);
  });
});

// ── declared mode parity is rejected on a report/TSV divergence ──────────────
test("declared mode parity is REJECTED when a report field diverges from controller TSV", () => {
  withTempDir("rv03-parity-mismatch-", (dir) => {
    const tsv = path.join(dir, "verify.claims.tsv");
    writeClaimsTsv(tsv, { build: "pass", typecheck: "pass", test: "fail", lint: "pass" });

    const report = declaredReport({ build: "pass", typecheck: "pass", test: "pass", lint: "pass" });
    const result = computeClaimsParity(report, tsv, "declared");
    assert.equal(result.parity, false);
    assert.ok(
      result.mismatches.some((m) => /test/.test(m) && /controller evidence=fail/.test(m)),
      `expected a test mismatch reason, got: ${JSON.stringify(result.mismatches)}`,
    );
  });
});

// ── declared mode parity rejects a missing controller TSV ────────────────────
test("declared mode parity rejects a missing controller TSV", () => {
  const report = declaredReport({ build: "pass", typecheck: "pass", test: "pass", lint: "pass" });
  const result = computeClaimsParity(report, "/nonexistent/verify.claims.tsv", "declared");
  assert.equal(result.parity, false);
  assert.ok(result.mismatches.some((m) => /missing/.test(m)));
});

// ── invalid-mixed mode rejects parity ────────────────────────────────────────
test("invalid-mixed mode rejects parity", () => {
  const result = computeClaimsParity({}, "/whatever", "invalid-mixed");
  assert.equal(result.parity, false);
  assert.ok(result.mismatches.length > 0);
});

// ── writeClaimsTsv / parseClaimsTsv round-trip ───────────────────────────────
test("writeClaimsTsv / parseClaimsTsv round-trip", () => {
  withTempDir("rv03-tsv-", (dir) => {
    const tsv = path.join(dir, "verify.claims.tsv");
    writeClaimsTsv(tsv, { build: "pass", typecheck: "skipped", test: "fail", lint: "pass" });
    const parsed = parseClaimsTsv(tsv);
    assert.deepEqual(parsed, { build: "pass", typecheck: "skipped", test: "fail", lint: "pass" });
  });
});

// ── runChecks / runCheck pass, fail, and skipped classification ──────────────
test("runChecks classifies pass/fail from exit codes, and runCheck reports skipped for an absent or declared-skipped check", async () => {
  const checks: VerificationCheck[] = [
    normalizeCheck({ id: "build", argv: [process.execPath, "-e", "process.exit(0)"] }),
    normalizeCheck({ id: "test", argv: [process.execPath, "-e", "process.exit(1)"] }),
    normalizeCheck({ id: "lint", argv: [process.execPath, "-e", "process.exit(0)"] }),
  ];
  const result = await runChecks(checks, ctx);
  assert.equal(result.checks.build, "pass");
  assert.equal(result.checks.test, "fail");
  assert.equal(result.checks.lint, "pass");
  assert.equal(result.overall, "fail");

  const skippedAbsent = await runCheck("typecheck", undefined, ctx);
  assert.deepEqual(skippedAbsent, { id: "typecheck", status: "skipped", exitCode: null });

  const skippedDeclared = await runCheck("typecheck", "skipped", ctx);
  assert.deepEqual(skippedDeclared, { id: "typecheck", status: "skipped", exitCode: null });
});

// ── parseClaimsTsv last-wins semantics ───────────────────────────────────────
test("parseClaimsTsv last-wins: a later row for the same check_id overwrites an earlier one", () => {
  withTempDir("rv03-last-wins-", (dir) => {
    const tsv = path.join(dir, "verify.claims.tsv");
    fs.writeFileSync(
      tsv,
      "scope\tcheck_id\tstatus\tsource\ntask\tbuild\tfail\tctrl\ntask\tbuild\tpass\tctrl\n",
      "utf8",
    );
    const parsed = parseClaimsTsv(tsv);
    assert.equal(parsed?.build, "pass", "last row for the same check_id must win");
  });
});

// ── normalizeCheck rejections ──────────────────────────────────────────────
test("normalizeCheck rejects an empty argv", () => {
  assert.throws(
    () => normalizeCheck({ id: "build", argv: [] }),
    (err: unknown) => err instanceof InvalidCheckError,
  );
});

test("normalizeCheck rejects a missing id", () => {
  assert.throws(
    () => normalizeCheck({ argv: ["true"] }),
    (err: unknown) => err instanceof InvalidCheckError && /missing a required id/.test(err.message),
  );
});

test("normalizeCheck rejects an id that does not match the required pattern", () => {
  assert.throws(
    () => normalizeCheck({ id: "Build_1", argv: ["true"] }),
    (err: unknown) => err instanceof InvalidCheckError && /does not match/.test(err.message),
  );
});

test("normalizeCheck rejects the combination of shell: true with argv", () => {
  assert.throws(
    () => normalizeCheck({ id: "build", shell: true, command: "npm run build", argv: ["npm"] }),
    (err: unknown) => err instanceof InvalidCheckError && /cannot combine/.test(err.message),
  );
});

test("normalizeCheck rejects a bare string carrying a shell metacharacter, naming the character and the shell: true form", () => {
  assert.throws(
    () => normalizeCheck("npm run build && rm -rf /", "build"),
    (err: unknown) =>
      err instanceof InvalidCheckError && /&/.test(err.message) && /shell: true/.test(err.message),
  );
});

// ── metacharacter-bearing argv element runs with no shell interpreting it ────
test("an echo check with a metacharacter-bearing argument runs with no shell interpreting it", async () => {
  const check = normalizeCheck({ id: "echo-check", argv: ["echo", "hello; exit 7"] });
  const result = await runCheck(check.id, check, ctx);
  assert.equal(result.status, "pass");
  assert.equal(result.exitCode, 0);
});
