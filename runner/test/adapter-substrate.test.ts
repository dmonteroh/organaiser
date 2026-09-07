import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJsonlFramer } from "../src/adapters/jsonl.ts";
import { classifyAttempt, type VendorSignals } from "../src/adapters/classify.ts";
import { CAPTURE_CASES, loadCapture, sanitizeCaptureLine } from "../src/adapters/captures.ts";
import {
  DEFAULT_SECRET_ENV_NAMES,
  DEFAULT_TOKEN_PATTERNS,
  redactorForRoot,
  resolveRedactionConfig,
} from "../src/store/redact.ts";
import {
  createVendorAdapter,
  type RecordedProcessInfo,
  type TerminateFn,
  type VendorAdapterSpec,
  type VendorCommand,
  type VendorCommandContext,
  type VendorSignalInput,
  type VendorStreamOutput,
} from "../src/adapters/vendor-adapter.ts";
import type { AttemptArtifacts, AttemptDescriptor, ExecutionSurface } from "../src/adapters/adapter.ts";
import { createReportValidator, ReportValidationError, type ReportValidator } from "../src/compile/report-validator.ts";
import { adapterStreamCases } from "../evals/fixtures/13-adapter-stream-cases.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/adapter-substrate/", import.meta.url));

// A trivially-permissive validator so the classify.ts unit tests below can control
// validity directly through report shape without depending on the real schema file.
function permissiveValidator(rejectMessage: string | null = null): ReportValidator {
  return {
    validateObject(obj: unknown): Record<string, unknown> {
      if (rejectMessage !== null) {
        throw new ReportValidationError(rejectMessage);
      }
      return obj as Record<string, unknown>;
    },
  };
}

function baseArtifacts(overrides: Partial<AttemptArtifacts> = {}): AttemptArtifacts {
  return {
    attemptId: "attempt_1",
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    candidateReportText: '{"ok":true}',
    events: [],
    ...overrides,
  };
}

function baseSignals(overrides: Partial<VendorSignals> = {}): VendorSignals {
  return {
    permissionDenials: [],
    toolFailures: [],
    vendorErrorClass: null,
    unknownEventTypes: [],
    streamTruncated: false,
    descendantsAlive: false,
    ...overrides,
  };
}

// --- jsonl.ts -------------------------------------------------------------

test("jsonl: push frames every complete line and skips blank and non-JSON lines", () => {
  const framer = createJsonlFramer();
  const values = framer.push('{"a":1}\n\n not json\n{"a":2}\n');
  assert.deepEqual(values, [{ a: 1 }, { a: 2 }]);
});

test("jsonl: a line split across two chunks frames once the newline arrives", () => {
  const framer = createJsonlFramer();
  assert.deepEqual(framer.push('{"a":'), []);
  assert.deepEqual(framer.push('1}\n'), [{ a: 1 }]);
});

test("jsonl: end() returns an unterminated final line as trailing and truncated", () => {
  const framer = createJsonlFramer();
  framer.push('{"a":1}\n{"b":2');
  const ended = framer.end();
  assert.equal(ended.trailing, '{"b":2');
  assert.equal(ended.truncated, true);
});

test("jsonl: end() on a cleanly terminated stream reports no truncation", () => {
  const framer = createJsonlFramer();
  framer.push('{"a":1}\n');
  const ended = framer.end();
  assert.equal(ended.trailing, "");
  assert.equal(ended.truncated, false);
});

test("jsonl: end() on an empty or whitespace-only trailing buffer is not truncated", () => {
  const framer = createJsonlFramer();
  framer.push('{"a":1}\n   ');
  const ended = framer.end();
  assert.equal(ended.truncated, false);
});

// --- classify.ts ------------------------------------------------------------

test("classify step 1: permission denials classify permission-denied whatever the exit code", () => {
  const outcome = classifyAttempt(
    baseArtifacts({ exitCode: 0 }),
    baseSignals({ permissionDenials: ["deny write"] }),
    permissiveValidator(),
  );
  assert.equal(outcome.failureClass, "permission-denied");
  assert.equal(outcome.reason, "permission-denials=1");
});

test("classify step 2: descendants alive classifies runner-invariant", () => {
  const outcome = classifyAttempt(baseArtifacts(), baseSignals({ descendantsAlive: true }), permissiveValidator());
  assert.equal(outcome.failureClass, "runner-invariant");
  assert.equal(outcome.reason, "descendants-alive");
});

test("classify step 3: a non-null vendor error class classifies as that class", () => {
  const outcome = classifyAttempt(
    baseArtifacts(),
    baseSignals({ vendorErrorClass: "rate-limit" }),
    permissiveValidator(),
  );
  assert.equal(outcome.failureClass, "rate-limit");
  assert.equal(outcome.reason, "vendor-error-class=rate-limit");
});

test("classify step 4: no candidate report and a non-zero exit classifies worker-crash", () => {
  const outcome = classifyAttempt(
    baseArtifacts({ candidateReportText: null, exitCode: 1 }),
    baseSignals(),
    permissiveValidator(),
  );
  assert.equal(outcome.failureClass, "worker-crash");
  // Step 6's `exit=<code>` token is conditioned on an otherwise-valid report (its own
  // step text: "with an otherwise valid report"); with no candidate report at all, only
  // step 4's token fires.
  assert.equal(outcome.reason, "no-candidate-report");
});

test("classify step 4: no candidate report with a clean exit classifies runner-invariant", () => {
  const outcome = classifyAttempt(
    baseArtifacts({ candidateReportText: null, exitCode: 0 }),
    baseSignals(),
    permissiveValidator(),
  );
  assert.equal(outcome.failureClass, "runner-invariant");
  assert.equal(outcome.reason, "no-candidate-report");
});

test("classify step 5: a candidate report rejected by the validator classifies schema-invalid", () => {
  const outcome = classifyAttempt(baseArtifacts(), baseSignals(), permissiveValidator("missing field: summary"));
  assert.equal(outcome.failureClass, "schema-invalid");
  assert.equal(outcome.reason, "schema-invalid: missing field: summary");
});

test("classify step 6: a non-zero exit with an otherwise valid report classifies worker-crash", () => {
  const outcome = classifyAttempt(baseArtifacts({ exitCode: 1 }), baseSignals(), permissiveValidator());
  assert.equal(outcome.failureClass, "worker-crash");
  assert.equal(outcome.reason, "exit=1");
});

test("classify step 6: a signal with an otherwise valid report classifies worker-crash", () => {
  const outcome = classifyAttempt(
    baseArtifacts({ exitCode: null, signal: "SIGKILL" }),
    baseSignals(),
    permissiveValidator(),
  );
  assert.equal(outcome.failureClass, "worker-crash");
  assert.equal(outcome.reason, "signal=SIGKILL");
});

test("classify step 7: a valid report with a clean exit and no signals classifies ok", () => {
  const outcome = classifyAttempt(baseArtifacts(), baseSignals(), permissiveValidator());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.failureClass, null);
  assert.equal(outcome.reason, null);
  assert.deepEqual(outcome.report, { ok: true });
});

test("classify: every tripped condition is named in reason, not only the one that wins", () => {
  const outcome = classifyAttempt(
    baseArtifacts({ exitCode: 1 }),
    baseSignals({
      permissionDenials: ["deny write"],
      toolFailures: ["bash"],
      unknownEventTypes: ["mystery"],
    }),
    permissiveValidator(),
  );
  assert.equal(outcome.failureClass, "permission-denied");
  assert.equal(outcome.reason, "permission-denials=1; exit=1; tool-failures=1; unknown-event-types=1");
});

test("classify: a tool failure inside an otherwise successful process still leaves ok true", () => {
  const outcome = classifyAttempt(baseArtifacts(), baseSignals({ toolFailures: ["bash"] }), permissiveValidator());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "tool-failures=1");
});

test("classify: a truncated stream that still produced a valid report leaves ok true", () => {
  const outcome = classifyAttempt(baseArtifacts(), baseSignals({ streamTruncated: true }), permissiveValidator());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reason, "stream-truncated");
});

test("classify: reuses createReportValidator against the real stage-result schema", () => {
  const validator = createReportValidator({
    type: "object",
    required: ["summary"],
    properties: { summary: { type: "string" } },
  });
  const outcome = classifyAttempt(
    baseArtifacts({ candidateReportText: "{}" }),
    baseSignals(),
    validator,
  );
  assert.equal(outcome.failureClass, "schema-invalid");
});

// --- captures.ts ------------------------------------------------------------

test("captures: CAPTURE_CASES lists the ten goals-spec-section-29.5 cases in order", () => {
  assert.deepEqual(CAPTURE_CASES, [
    "normal-success",
    "schema-constrained-result",
    "tool-failure-in-success",
    "permission-denial",
    "authentication-failure",
    "rate-limit",
    "process-crash",
    "missing-final-event",
    "unknown-event-type",
    "version-output-change",
  ]);
});

test("captures: loadCapture parses metadata and stream lines", () => {
  const raw = [
    JSON.stringify({
      vendor: "acme",
      cliVersion: "1.2.3",
      commandShape: ["acme", "--print", "<schema-path>"],
      captureDate: "2026-01-01",
      case: "normal-success",
    }),
    '{"type":"output","text":"hi"}',
    "",
  ].join("\n");
  const capture = loadCapture(raw);
  assert.equal(capture.metadata.vendor, "acme");
  assert.equal(capture.metadata.case, "normal-success");
  assert.deepEqual(capture.lines, ['{"type":"output","text":"hi"}']);
});

test("captures: loadCapture refuses metadata missing a required field", () => {
  const raw = JSON.stringify({ vendor: "acme", cliVersion: "1.2.3", captureDate: "2026-01-01", case: "normal-success" });
  assert.throws(() => loadCapture(raw), /missing required field/);
});

test("captures: loadCapture refuses a case not in CAPTURE_CASES", () => {
  const raw = JSON.stringify({
    vendor: "acme",
    cliVersion: "1.2.3",
    commandShape: [],
    captureDate: "2026-01-01",
    case: "not-a-real-case",
  });
  assert.throws(() => loadCapture(raw), /unknown case/);
});

test("captures: sanitizeCaptureLine leaves nothing recoverable from a line carrying all four secrets", () => {
  const homeDirectory = "/Users/example-operator";
  const environment = { ANTHROPIC_API_KEY: "super-secret-value-123" };
  const line =
    `${homeDirectory}/worktrees/run-1 key=sk-abcdefgh123 auth="Bearer abc.def.ghi" ` +
    `env=${environment.ANTHROPIC_API_KEY} gh=ghp_1234567890abcdef`;
  const sanitized = sanitizeCaptureLine(line, { homeDirectory, environment });
  assert.ok(!sanitized.includes(homeDirectory), "home path must be redacted");
  assert.ok(!sanitized.includes(environment.ANTHROPIC_API_KEY), "env var value must be redacted");
  assert.ok(!sanitized.includes("sk-abcdefgh123"), "sk- token must be redacted");
  assert.ok(!sanitized.includes("Bearer abc.def.ghi"), "Bearer token must be redacted");
  assert.ok(!sanitized.includes("ghp_1234567890abcdef"), "ghp_ token must be redacted");
});

// --- store/redact.ts --------------------------------------------------------

test("redact: resolveRedactionConfig unions an orga.yaml redaction: block onto the built-in defaults", async () => {
  await withTempWorkspace(async (dir) => {
    fs.writeFileSync(
      path.join(dir, "orga.yaml"),
      [
        "redaction:",
        "  secretPatterns:",
        "    - custom-token-[a-f0-9]+",
        "  environmentVariableNames:",
        "    - CUSTOM_SECRET_NAME",
        "",
      ].join("\n"),
    );
    const config = resolveRedactionConfig(dir, {});
    for (const pattern of DEFAULT_TOKEN_PATTERNS) {
      assert.ok(config.secretPatterns.includes(pattern), `default pattern retained: ${pattern}`);
    }
    for (const name of DEFAULT_SECRET_ENV_NAMES) {
      assert.ok(config.environmentVariableNames.includes(name), `default env name retained: ${name}`);
    }
    assert.ok(config.secretPatterns.includes("custom-token-[a-f0-9]+"));
    assert.ok(config.environmentVariableNames.includes("CUSTOM_SECRET_NAME"));
  });
});

test("redact: resolveRedactionConfig falls back to the defaults for a missing orga.yaml", async () => {
  await withTempWorkspace(async (dir) => {
    const config = resolveRedactionConfig(path.join(dir, "does-not-exist"), {});
    assert.deepEqual(config.secretPatterns, DEFAULT_TOKEN_PATTERNS);
    assert.deepEqual(config.environmentVariableNames, DEFAULT_SECRET_ENV_NAMES);
  });
});

test("redact: resolveRedactionConfig falls back to the defaults for an orga.yaml with no redaction: block", async () => {
  await withTempWorkspace(async (dir) => {
    fs.writeFileSync(path.join(dir, "orga.yaml"), "runner:\n  version: \"0.0.0\"\n");
    const config = resolveRedactionConfig(dir, {});
    assert.deepEqual(config.secretPatterns, DEFAULT_TOKEN_PATTERNS);
    assert.deepEqual(config.environmentVariableNames, DEFAULT_SECRET_ENV_NAMES);
  });
});

test("redact: resolveRedactionConfig falls back to the defaults for a malformed redaction: block and never throws", async () => {
  await withTempWorkspace(async (dir) => {
    fs.writeFileSync(
      path.join(dir, "orga.yaml"),
      ["redaction:", "  secretPatterns: not-an-array", "  environmentVariableNames: also-not-an-array", ""].join("\n"),
    );
    const config = resolveRedactionConfig(dir, {});
    assert.deepEqual(config.secretPatterns, DEFAULT_TOKEN_PATTERNS);
    assert.deepEqual(config.environmentVariableNames, DEFAULT_SECRET_ENV_NAMES);
  });
});

test("redact: a memoized redactor applied twice to the same input produces the same output", async () => {
  await withTempWorkspace(async (dir) => {
    const redactor = redactorForRoot(dir, {});
    const input = "first sk-aaaaaaaa123456 then sk-bbbbbbbb654321 in the same line";
    const first = redactor(input);
    const second = redactor(input);
    assert.equal(first, second);
    assert.ok(!first.includes("sk-aaaaaaaa123456"));
    assert.ok(!first.includes("sk-bbbbbbbb654321"));
    const secondCallResult = redactorForRoot(dir, {})(input);
    assert.equal(secondCallResult, first);
  });
});

// --- vendor-adapter.ts: type-level seam ------------------------------------

// A stub spec instantiated purely to prove `VendorAdapterSpec`'s four members compile
// against their declared signatures; a real vendor module implements this the same way.
const stubSpec: VendorAdapterSpec = {
  vendor: "stub",
  buildCommand(context: VendorCommandContext): VendorCommand {
    return {
      command: "true",
      args: [],
      input: context.packet,
      cwd: context.surface.workingDirectory,
      env: context.surface.environment,
    };
  },
  toEvents(_value: unknown, timestamp: string): VendorStreamOutput {
    return { events: [{ type: "output", text: "stub", timestamp }], candidateReportText: null };
  },
  extractSignals(input: VendorSignalInput): VendorSignals {
    return {
      permissionDenials: [],
      toolFailures: [],
      vendorErrorClass: null,
      unknownEventTypes: [],
      streamTruncated: input.streamTruncated,
      descendantsAlive: input.descendantsAlive,
    };
  },
};

test("vendor-adapter: VendorAdapterSpec's four members compile against a stub", () => {
  assert.equal(stubSpec.vendor, "stub");
  assert.equal(typeof stubSpec.buildCommand, "function");
  assert.equal(typeof stubSpec.toEvents, "function");
  assert.equal(typeof stubSpec.extractSignals, "function");
});

function attemptDescriptor(attemptId: string): AttemptDescriptor {
  return {
    attemptId,
    runId: "run_1",
    taskId: "task_1",
    stageId: "implement",
    roleId: "implementer",
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
  };
}

function surfaceHere(): ExecutionSurface {
  return {
    workingDirectory: process.cwd(),
    environment: process.env,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };
}

test("vendor-adapter: cancel reaches the injected terminator with the handle's pgid and grace", async () => {
  let received: { info: RecordedProcessInfo; gracePeriodMs: number } | null = null;
  const terminate: TerminateFn = async (info, gracePeriodMs) => {
    received = { info, gracePeriodMs };
    return { signalSent: "SIGTERM", exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  };

  const spec: VendorAdapterSpec = {
    vendor: "stub",
    buildCommand: () => ({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], input: "", cwd: process.cwd(), env: process.env }),
    toEvents: () => ({ events: [], candidateReportText: null }),
    extractSignals: (input) => ({
      permissionDenials: [],
      toolFailures: [],
      vendorErrorClass: null,
      unknownEventTypes: [],
      streamTruncated: input.streamTruncated,
      descendantsAlive: input.descendantsAlive,
    }),
  };

  const adapter = createVendorAdapter(spec, {
    probe: async (configuration) => ({
      executablePath: configuration.executablePath,
      cliVersion: "1",
      requestedModel: configuration.requestedModel,
      requestedEffort: configuration.requestedEffort,
      structuredOutputMode: "jsonl",
      authenticationOutcome: "not-applicable",
      workingDirectoryBehavior: "honored",
      permissionAndSandboxConfiguration: "none",
      adapterVersion: "1",
    }),
    terminate,
  });

  const handle = await adapter.start(attemptDescriptor("cancel-test"), "packet", surfaceHere());
  const report = await adapter.cancel(handle, 150);
  assert.equal(report.attemptId, "cancel-test");
  assert.ok(received !== null);
  assert.equal((received as unknown as { info: RecordedProcessInfo }).info.pgid, handle.pgid);
  assert.equal((received as unknown as { gracePeriodMs: number }).gracePeriodMs, 150);

  try {
    process.kill(-handle.pgid, "SIGKILL");
  } catch {
    // already gone
  }
});

test("vendor-adapter: a spawn error (binary missing from PATH) resolves gracefully instead of crashing", async () => {
  const spec: VendorAdapterSpec = {
    vendor: "stub",
    buildCommand: () => ({
      command: "definitely-not-a-real-binary-xyz",
      args: [],
      input: "",
      cwd: process.cwd(),
      env: process.env,
    }),
    toEvents: () => ({ events: [], candidateReportText: null }),
    extractSignals: (input) => ({
      permissionDenials: [],
      toolFailures: [],
      vendorErrorClass: null,
      unknownEventTypes: [],
      streamTruncated: input.streamTruncated,
      descendantsAlive: input.descendantsAlive,
    }),
  };

  const terminate: TerminateFn = async () => ({
    signalSent: null,
    exitCode: null,
    killedProcessTree: false,
    timedOutWaitingForExit: false,
  });

  const adapter = createVendorAdapter(spec, {
    probe: async (configuration) => ({
      executablePath: configuration.executablePath,
      cliVersion: "1",
      requestedModel: configuration.requestedModel,
      requestedEffort: configuration.requestedEffort,
      structuredOutputMode: "jsonl",
      authenticationOutcome: "not-applicable",
      workingDirectoryBehavior: "honored",
      permissionAndSandboxConfiguration: "none",
      adapterVersion: "1",
    }),
    terminate,
  });

  const handle = await adapter.start(attemptDescriptor("spawn-error-test"), "packet", surfaceHere());

  for await (const _event of adapter.observe(handle)) {
    // Draining is enough to prove observe() terminates rather than hanging.
  }

  const artifacts = await adapter.collect(handle);
  assert.equal(artifacts.candidateReportText, null);

  const outcome = await adapter.classify(artifacts);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureClass, "worker-crash");
});

// --- the four required deterministic stream cases, run through the real pipeline ---

for (const streamCase of adapterStreamCases("test-vendor", FIXTURE_DIR)) {
  test(streamCase.name, streamCase.run);
}
