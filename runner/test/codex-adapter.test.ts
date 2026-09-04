// Drives the production Codex adapter — `buildCodexAttemptCommand`, `lastMessagePathFor`,
// `createCodexAdapter`'s last-message `collect` override, `codexToEvents`, and
// `codexExtractSignals` — over the ten sanitized `evals/captures/codex/0.46.0/*.jsonl`
// captures, plus the shared substrate stream cases from
// `evals/fixtures/13-adapter-stream-cases.ts`. Every capture is replayed by spawning a
// tiny local stand-in script that writes the capture's own stored lines to stdout: the
// real `codex` binary is never spawned, and this file passes with no `codex` on `PATH`.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AttemptDescriptor, CapabilityReport, ExecutionSurface, ProbeConfiguration } from "../src/adapters/adapter.ts";
import {
  CODEX_VENDOR_PROBE_SPEC,
  buildCodexAttemptCommand,
  codexExtractSignals,
  codexToEvents,
  createCodexAdapter,
  createCodexVendorSpec,
  lastMessagePathFor,
} from "../src/adapters/codex-adapter.ts";
import { probeVendor } from "../src/adapters/probe.ts";
import { CAPTURE_CASES, loadCapture, type CaptureCase } from "../src/adapters/captures.ts";
import type { TerminateFn, VendorAdapterOptions } from "../src/adapters/vendor-adapter.ts";
import type { ResolvedVendorProfile } from "../src/cli/profiles.ts";
import { adapterStreamCases } from "../evals/fixtures/13-adapter-stream-cases.ts";

const CAPTURE_DIR = fileURLToPath(new URL("../evals/captures/codex/0.46.0/", import.meta.url));
const SUBSTRATE_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/adapter-substrate/", import.meta.url));

function readCapture(caseName: CaptureCase) {
  const raw = fs.readFileSync(path.join(CAPTURE_DIR, `${caseName}.jsonl`), "utf8");
  return loadCapture(raw);
}

// --- buildCodexAttemptCommand / lastMessagePathFor: pure, no process, no fs ---------

function profile(overrides: Partial<ResolvedVendorProfile> = {}): ResolvedVendorProfile {
  return {
    executable: "codex",
    model: "gpt-5-codex",
    effort: "medium",
    permissionMode: "default",
    sandboxMode: "workspace-write",
    toolPolicy: { allowedTools: [], disallowedTools: [] },
    environmentAllowlist: [],
    timeouts: { spawnMs: 30_000, idleMs: 120_000, wallMs: 1_800_000 },
    budgetUsd: null,
    maxConcurrentProcesses: 2,
    ...overrides,
  };
}

function surface(overrides: Partial<ExecutionSurface> = {}): ExecutionSurface {
  return {
    workingDirectory: "/repo/worktree",
    environment: {},
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
    ...overrides,
  };
}

test("buildCodexAttemptCommand: produces the exact goals-spec-14 argument array", () => {
  const args = buildCodexAttemptCommand(
    profile(),
    "packet body",
    surface(),
    "/schemas/stage-result.schema.json",
    "/tmp/orga-attempts/run_1/attempt_1/last-message.txt",
  );
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--output-schema",
    "/schemas/stage-result.schema.json",
    "--output-last-message",
    "/tmp/orga-attempts/run_1/attempt_1/last-message.txt",
    "--model",
    "gpt-5-codex",
    "--config",
    "model_reasoning_effort=medium",
    "--sandbox",
    "workspace-write",
    "--cd",
    "/repo/worktree",
    "-",
  ]);
});

test("buildCodexAttemptCommand: the reasoning-effort config value carries no shell quoting", () => {
  const args = buildCodexAttemptCommand(profile(), "p", surface(), "/schema.json", "/last.txt");
  const configIndex = args.indexOf("--config");
  const configValue = args[configIndex + 1]!;
  assert.equal(configValue, "model_reasoning_effort=medium");
  assert.ok(!configValue.includes('"'), "the config value must carry no literal double quote");
});

test("buildCodexAttemptCommand: never produces codex exec resume or any session-continuation flag", () => {
  const args = buildCodexAttemptCommand(profile(), "p", surface(), "/schema.json", "/last.txt");
  assert.ok(!args.includes("resume"), '"resume" must appear in no produced array');
  assert.ok(!args.some((a) => a.includes("--resume") || a.includes("--continue")));
});

test("buildCodexAttemptCommand: two consecutive attempts differ only in the last-message path", () => {
  const first = buildCodexAttemptCommand(profile(), "p", surface(), "/schema.json", "/tmp/a/last-message.txt");
  const second = buildCodexAttemptCommand(profile(), "p", surface(), "/schema.json", "/tmp/b/last-message.txt");
  const firstMinusPath = first.filter((_, i) => i !== first.indexOf("/tmp/a/last-message.txt"));
  const secondMinusPath = second.filter((_, i) => i !== second.indexOf("/tmp/b/last-message.txt"));
  assert.deepEqual(firstMinusPath, secondMinusPath, "byte-identical apart from the --output-last-message path");
  assert.notDeepEqual(first, second);
});

test("lastMessagePathFor: contains the attempt id and lives outside the working directory", () => {
  const attempt = { runId: "run_42", attemptId: "attempt_99" };
  const p = lastMessagePathFor(attempt);
  assert.ok(p.includes("attempt_99"), "path must contain attempt.attemptId");
  assert.ok(p.includes("run_42"), "path must contain attempt.runId");
  const relativeToWorktree = path.relative("/repo/worktree", p);
  assert.ok(
    relativeToWorktree.startsWith(".."),
    "the last-message path must not be a descendant of surface.workingDirectory",
  );
  assert.ok(p.startsWith(os.tmpdir()));
});

test("lastMessagePathFor: the same helper produces the same path for the same attempt", () => {
  const attempt = { runId: "run_a", attemptId: "attempt_b" };
  assert.equal(lastMessagePathFor(attempt), lastMessagePathFor({ ...attempt }));
});

// --- env: exactly the profile allowlist, filtered by what surface.environment carries ---

test("buildCodexAttemptCommand's caller (the adapter spec) never leaks an unallowlisted variable", () => {
  const spec = createCodexVendorSpec(profile({ environmentAllowlist: ["ORGA_ALLOWED"] }));
  const command = spec.buildCommand({
    attempt: attemptFor("env-check"),
    packet: "packet",
    surface: surface({ environment: { ORGA_ALLOWED: "yes", ORGA_SECRET: "no", PATH: "/usr/bin" } }),
    schemaPath: "/schema.json",
  });
  assert.deepEqual(command.env, { ORGA_ALLOWED: "yes" });
  assert.equal(command.input, "packet");
  assert.equal(command.cwd, "/repo/worktree");
});

// --- codex-adapter replay harness: a local stand-in script, never the real `codex` ----

const REPLAY_SCRIPT_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orga-codex-replay-")), "replay.cjs");
fs.writeFileSync(
  REPLAY_SCRIPT_PATH,
  `#!/usr/bin/env node
const fs = require('node:fs');
const fixturePath = process.env.CODEX_REPLAY_FIXTURE;
const exitCode = Number(process.env.CODEX_REPLAY_EXIT_CODE || '0');
const raw = fs.readFileSync(fixturePath, 'utf8');
process.stdout.write(raw);
process.exit(exitCode);
`,
  "utf8",
);
fs.chmodSync(REPLAY_SCRIPT_PATH, 0o755);

const FIXTURES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orga-codex-fixtures-"));

function writeFixture(caseName: string, lines: readonly string[]): string {
  const fixturePath = path.join(FIXTURES_DIR, `${caseName}.stdout.jsonl`);
  fs.writeFileSync(fixturePath, lines.map((line) => `${line}\n`).join(""), "utf8");
  return fixturePath;
}

function attemptFor(caseName: string): AttemptDescriptor {
  return {
    attemptId: `attempt_${caseName}`,
    runId: `run_${caseName}`,
    taskId: "task_codex_adapter",
    stageId: "implement",
    roleId: "implementer",
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
  };
}

function replaySurface(fixturePath: string, exitCode: number): ExecutionSurface {
  return surface({
    workingDirectory: FIXTURES_DIR,
    environment: {
      CODEX_REPLAY_FIXTURE: fixturePath,
      CODEX_REPLAY_EXIT_CODE: String(exitCode),
      PATH: process.env.PATH,
    },
  });
}

function replayProfile(): ResolvedVendorProfile {
  return profile({
    executable: REPLAY_SCRIPT_PATH,
    environmentAllowlist: ["CODEX_REPLAY_FIXTURE", "CODEX_REPLAY_EXIT_CODE", "PATH"],
  });
}

async function stubProbe(configuration: ProbeConfiguration): Promise<CapabilityReport> {
  return {
    executablePath: configuration.executablePath,
    cliVersion: "codex-replay/1",
    requestedModel: configuration.requestedModel,
    requestedEffort: configuration.requestedEffort,
    structuredOutputMode: "jsonl",
    authenticationOutcome: "not-applicable",
    workingDirectoryBehavior: "honored",
    permissionAndSandboxConfiguration: "none",
    adapterVersion: "codex-replay@1",
  };
}

const stubTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function adapterOptions(): VendorAdapterOptions {
  return { probe: stubProbe, terminate: stubTerminate };
}

async function drainAll(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // draining is enough; the substrate framer has already produced every value by the
    // time the process exits.
  }
}

function validReport(attempt: AttemptDescriptor, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: "1",
    workflowId: "organaiser-runner",
    workflowVersion: "1",
    runId: attempt.runId,
    taskId: attempt.taskId,
    attemptId: attempt.attemptId,
    stageId: attempt.stageId,
    roleId: attempt.roleId,
    status: "completed",
    summary: `${attempt.attemptId} ok`,
    ...overrides,
  });
}

interface CaseExpectation {
  exitCode: number;
  lastMessage: ((attempt: AttemptDescriptor) => string) | null;
  ok: boolean;
  failureClass: string | null;
  permissionDenials: number;
  toolFailures: number;
  unknownEventTypes: number;
  vendorErrorClass: string | null;
}

const CASE_EXPECTATIONS: Record<Exclude<CaptureCase, "version-output-change">, CaseExpectation> = {
  "normal-success": {
    exitCode: 0,
    lastMessage: (a) => validReport(a),
    ok: true,
    failureClass: null,
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: null,
  },
  "schema-constrained-result": {
    exitCode: 0,
    lastMessage: (a) => validReport(a, { evidence: [] }),
    ok: true,
    failureClass: null,
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: null,
  },
  "tool-failure-in-success": {
    exitCode: 0,
    lastMessage: (a) => validReport(a),
    ok: true,
    failureClass: null,
    permissionDenials: 0,
    toolFailures: 1,
    unknownEventTypes: 0,
    vendorErrorClass: null,
  },
  "permission-denial": {
    exitCode: 0,
    lastMessage: (a) => validReport(a),
    ok: false,
    failureClass: "permission-denied",
    permissionDenials: 1,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: null,
  },
  "authentication-failure": {
    exitCode: 1,
    lastMessage: null,
    ok: false,
    failureClass: "authentication",
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: "authentication",
  },
  "rate-limit": {
    exitCode: 1,
    lastMessage: null,
    ok: false,
    failureClass: "rate-limit",
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: "rate-limit",
  },
  "process-crash": {
    exitCode: 1,
    lastMessage: null,
    ok: false,
    failureClass: "worker-crash",
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: null,
  },
  "missing-final-event": {
    exitCode: 0,
    lastMessage: null,
    ok: false,
    failureClass: "runner-invariant",
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 0,
    vendorErrorClass: null,
  },
  "unknown-event-type": {
    exitCode: 0,
    lastMessage: (a) => validReport(a),
    ok: true,
    failureClass: null,
    permissionDenials: 0,
    toolFailures: 0,
    unknownEventTypes: 1,
    vendorErrorClass: null,
  },
};

// --- the capture directory holds exactly CAPTURE_CASES, no more, no fewer -----------

test("captures/codex/0.46.0: the directory's case set equals CAPTURE_CASES exactly", () => {
  const files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.endsWith(".jsonl"));
  const caseNames = files.map((f) => f.replace(/\.jsonl$/, "")).sort();
  assert.deepEqual(caseNames, [...CAPTURE_CASES].sort());
  for (const caseName of CAPTURE_CASES) {
    const capture = readCapture(caseName);
    assert.equal(capture.metadata.case, caseName);
    assert.equal(capture.metadata.vendor, "codex");
  }
});

test("captures/codex/0.46.0: no capture line carries a JWT segment or an OAuth token field", () => {
  const jwtPattern = /eyJ[A-Za-z0-9_-]{10,}\./;
  const bannedFields = ["access_token", "refresh_token", "id_token", "account_id"];
  for (const caseName of CAPTURE_CASES) {
    const raw = fs.readFileSync(path.join(CAPTURE_DIR, `${caseName}.jsonl`), "utf8");
    for (const line of raw.split("\n")) {
      assert.ok(!jwtPattern.test(line), `${caseName}.jsonl carries a JWT-shaped segment`);
      for (const field of bannedFields) {
        assert.ok(!line.includes(field), `${caseName}.jsonl carries the field "${field}"`);
      }
    }
  }
});

// --- toEvents / extractSignals / last-message collect, replayed per capture ----------

for (const caseName of CAPTURE_CASES) {
  if (caseName === "version-output-change") continue;
  const expectation = CASE_EXPECTATIONS[caseName];

  test(`codex-adapter replay: ${caseName}`, async () => {
    const capture = readCapture(caseName);
    const attempt = attemptFor(caseName);
    const fixturePath = writeFixture(caseName, capture.lines);

    const adapter = createCodexAdapter(replayProfile(), adapterOptions());
    const handle = await adapter.start(attempt, "packet body", replaySurface(fixturePath, expectation.exitCode));
    await drainAll(adapter.observe(handle));

    if (expectation.lastMessage) {
      const lastMessagePath = lastMessagePathFor(attempt);
      fs.mkdirSync(path.dirname(lastMessagePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(lastMessagePath, expectation.lastMessage(attempt), "utf8");
    }

    const artifacts = await adapter.collect(handle);
    if (expectation.lastMessage) {
      assert.equal(artifacts.candidateReportText, expectation.lastMessage(attempt));
    } else {
      assert.equal(artifacts.candidateReportText, null);
    }

    const signals = codexExtractSignals({
      artifacts,
      values: capture.lines.map((line) => JSON.parse(line) as unknown),
      trailing: "",
      streamTruncated: false,
      descendantsAlive: false,
    });
    assert.equal(signals.permissionDenials.length, expectation.permissionDenials, `${caseName}: permissionDenials`);
    assert.equal(signals.toolFailures.length, expectation.toolFailures, `${caseName}: toolFailures`);
    assert.equal(signals.unknownEventTypes.length, expectation.unknownEventTypes, `${caseName}: unknownEventTypes`);
    assert.equal(signals.vendorErrorClass, expectation.vendorErrorClass, `${caseName}: vendorErrorClass`);

    const outcome = await adapter.classify(artifacts);
    assert.equal(outcome.ok, expectation.ok, `${caseName}: outcome.ok (${outcome.reason})`);
    assert.equal(outcome.failureClass, expectation.failureClass, `${caseName}: failureClass`);
  });
}

test("codexToEvents: always returns a null candidateReportText, even for an agent_message item", () => {
  const output = codexToEvents(
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: '{"status":"completed"}' } },
    "2026-01-01T00:00:00.000Z",
  );
  assert.equal(output.candidateReportText, null);
  assert.deepEqual(output.events, [{ type: "output", text: '{"status":"completed"}', timestamp: "2026-01-01T00:00:00.000Z" }]);
});

// --- version-output-change: captures the version-probe output shape, not an attempt stream ---

test("captures/codex/0.46.0: version-output-change captures a real `codex --version` line", () => {
  const capture = readCapture("version-output-change");
  assert.equal(capture.lines.length, 1);
  const parsed = CODEX_VENDOR_PROBE_SPEC.parseVersion({
    stdout: capture.lines[0]!,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
  assert.equal(parsed, "0.46.0");
});

// --- absent-file and empty-file both leave candidateReportText null -----------------

test("createCodexAdapter.collect: an absent last-message file leaves candidateReportText null", async () => {
  const capture = readCapture("normal-success");
  const attempt = attemptFor("absent-file-case");
  const fixturePath = writeFixture("absent-file-case", capture.lines);

  const adapter = createCodexAdapter(replayProfile(), adapterOptions());
  const handle = await adapter.start(attempt, "packet", replaySurface(fixturePath, 0));
  await drainAll(adapter.observe(handle));
  // Deliberately never write the last-message file.
  const artifacts = await adapter.collect(handle);
  assert.equal(artifacts.candidateReportText, null);
});

test("createCodexAdapter.collect: an empty or whitespace-only last-message file leaves candidateReportText null", async () => {
  const capture = readCapture("normal-success");
  const attempt = attemptFor("empty-file-case");
  const fixturePath = writeFixture("empty-file-case", capture.lines);

  const adapter = createCodexAdapter(replayProfile(), adapterOptions());
  const handle = await adapter.start(attempt, "packet", replaySurface(fixturePath, 0));
  await drainAll(adapter.observe(handle));

  const lastMessagePath = lastMessagePathFor(attempt);
  fs.mkdirSync(path.dirname(lastMessagePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lastMessagePath, "   \n\t  ", "utf8");

  const artifacts = await adapter.collect(handle);
  assert.equal(artifacts.candidateReportText, null);
});

// --- the real Codex VendorProbeSpec, verified directly through probeVendor -----------

test("CODEX_VENDOR_PROBE_SPEC: probeVendor returns all nine CapabilityReport fields", async () => {
  const configuration: ProbeConfiguration = {
    executablePath: CODEX_VENDOR_PROBE_SPEC.defaultExecutable,
    requestedModel: "gpt-5-codex",
    requestedEffort: "medium",
    workingDirectory: process.cwd(),
    environment: process.env,
  };
  const report = await probeVendor(CODEX_VENDOR_PROBE_SPEC, configuration);

  for (const field of [
    "executablePath",
    "cliVersion",
    "requestedModel",
    "requestedEffort",
    "structuredOutputMode",
    "authenticationOutcome",
    "workingDirectoryBehavior",
    "permissionAndSandboxConfiguration",
    "adapterVersion",
  ] as const) {
    assert.equal(typeof report[field], "string", `CapabilityReport.${field} must be a string`);
  }
  assert.equal(report.requestedModel, "gpt-5-codex");
  assert.equal(report.requestedEffort, "medium");
  assert.equal(report.structuredOutputMode, "jsonl");
  assert.equal(report.adapterVersion, "1");
  // When codex is genuinely resolvable on PATH (this authoring environment; not
  // guaranteed in CI) the probe reports real facts rather than the "unknown" sentinel.
  if (report.executablePath !== "unknown") {
    assert.ok(/^\d+\.\d+\.\d+/.test(report.cliVersion), "a resolved codex reports a real semver");
    assert.ok(
      ["authenticated", "unauthenticated", "unknown", "probe-timeout"].includes(report.authenticationOutcome),
    );
  }
});

// --- the shared four-case substrate proof, read-only against the existing fixtures ---

for (const streamCase of adapterStreamCases("codex", SUBSTRATE_FIXTURE_DIR)) {
  test(streamCase.name, streamCase.run);
}
