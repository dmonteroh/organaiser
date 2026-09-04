// Drives the production Claude vendor adapter — its argument builder, its readiness
// probe spec, and its stream/signal extraction — against real recorded Claude Code
// 2.1.245 captures. Every capture is replayed through the real `createVendorAdapter`
// pipeline via a spawned replay script (never by spawning `claude` itself), so this
// file passes in CI with no `claude` on `PATH` and no credentials. The one exception is
// the direct `probeVendor` call, which does invoke the locally installed CLI: it is a
// readiness check of this environment, not part of the deterministic replay suite.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AttemptDescriptor,
  CapabilityReport,
  ExecutionSurface,
  NormalizedEvent,
  ProbeConfiguration,
} from "../src/adapters/adapter.ts";
import {
  buildClaudeAttemptCommand,
  claudeProbeSpec,
  extractSignals,
  toEvents,
} from "../src/adapters/claude-adapter.ts";
import { extractClaudeResultMeta } from "../src/adapters/claude.ts";
import { probeVendor } from "../src/adapters/probe.ts";
import { CAPTURE_CASES, loadCapture, type CaptureCase } from "../src/adapters/captures.ts";
import {
  createVendorAdapter,
  type TerminateFn,
  type VendorAdapterSpec,
  type VendorCommand,
  type VendorCommandContext,
} from "../src/adapters/vendor-adapter.ts";
import type { ResolvedVendorProfile } from "../src/cli/profiles.ts";
import { adapterStreamCases } from "../evals/fixtures/13-adapter-stream-cases.ts";

const CAPTURE_DIR = fileURLToPath(new URL("../evals/captures/claude/2.1.245/", import.meta.url));
const SUBSTRATE_FIXTURE_DIR = fileURLToPath(new URL("./fixtures/adapter-substrate/", import.meta.url));

// ── shared fixtures ─────────────────────────────────────────────────────────

function baseProfile(overrides: Partial<ResolvedVendorProfile> = {}): ResolvedVendorProfile {
  return {
    executable: "claude",
    model: "sonnet",
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

function baseSurface(overrides: Partial<ExecutionSurface> = {}): ExecutionSurface {
  return {
    workingDirectory: "/tmp/worktree",
    environment: {},
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
    ...overrides,
  };
}

// ── buildClaudeAttemptCommand: the argument array ───────────────────────────

test("buildClaudeAttemptCommand: base array begins with the goals spec section 15 shape", () => {
  const profile = baseProfile({ model: "sonnet", effort: "medium", permissionMode: "default" });
  const command = buildClaudeAttemptCommand(profile, "packet body", baseSurface(), "/schema/path.json");
  assert.deepEqual(command.args.slice(0, 12), [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    "/schema/path.json",
    "--model",
    "sonnet",
    "--effort",
    "medium",
    "--permission-mode",
    "default",
  ]);
});

test("buildClaudeAttemptCommand: the packet is stdin input, cwd is the assigned worktree", () => {
  const profile = baseProfile();
  const surface = baseSurface({ workingDirectory: "/worktrees/attempt-1" });
  const command = buildClaudeAttemptCommand(profile, "the packet body", surface, "/schema/path.json");
  assert.equal(command.input, "the packet body");
  assert.equal(command.cwd, "/worktrees/attempt-1");
  assert.equal(command.command, profile.executable);
});

test("buildClaudeAttemptCommand: omits --allowedTools/--disallowedTools/--max-budget-usd when the profile carries none of them", () => {
  const profile = baseProfile();
  const command = buildClaudeAttemptCommand(profile, "packet", baseSurface(), "/schema/path.json");
  assert.equal(command.args.includes("--allowedTools"), false);
  assert.equal(command.args.includes("--disallowedTools"), false);
  assert.equal(command.args.includes("--max-budget-usd"), false);
});

test("buildClaudeAttemptCommand: pushes --allowedTools and --disallowedTools once each, followed by every tool name", () => {
  const profile = baseProfile({
    toolPolicy: { allowedTools: ["Read", "Edit"], disallowedTools: ["Bash"] },
  });
  const command = buildClaudeAttemptCommand(profile, "packet", baseSurface(), "/schema/path.json");
  const allowedIndex = command.args.indexOf("--allowedTools");
  const disallowedIndex = command.args.indexOf("--disallowedTools");
  assert.ok(allowedIndex >= 0 && disallowedIndex >= 0);
  assert.deepEqual(command.args.slice(allowedIndex, allowedIndex + 3), ["--allowedTools", "Read", "Edit"]);
  assert.deepEqual(command.args.slice(disallowedIndex, disallowedIndex + 2), ["--disallowedTools", "Bash"]);
  assert.equal(command.args.filter((arg) => arg === "--allowedTools").length, 1);
  assert.equal(command.args.filter((arg) => arg === "--disallowedTools").length, 1);
});

test("buildClaudeAttemptCommand: pushes --max-budget-usd once when profile.budgetUsd is non-null", () => {
  const profile = baseProfile({ budgetUsd: 12.5 });
  const command = buildClaudeAttemptCommand(profile, "packet", baseSurface(), "/schema/path.json");
  const index = command.args.indexOf("--max-budget-usd");
  assert.ok(index >= 0);
  assert.equal(command.args[index + 1], "12.5");
  assert.equal(command.args.filter((arg) => arg === "--max-budget-usd").length, 1);
});

test("buildClaudeAttemptCommand: env contains exactly the allowlisted names present in surface.environment", () => {
  const profile = baseProfile({ environmentAllowlist: ["ORGA_ALLOWED"] });
  const surface = baseSurface({
    environment: { ORGA_ALLOWED: "yes", ORGA_NOT_ALLOWED: "should not appear", PATH: "/usr/bin" },
  });
  const command = buildClaudeAttemptCommand(profile, "packet", surface, "/schema/path.json");
  assert.deepEqual(command.env, { ORGA_ALLOWED: "yes" });
  assert.equal("ORGA_NOT_ALLOWED" in command.env, false);
  assert.equal("PATH" in command.env, false);
});

test("buildClaudeAttemptCommand: an allowlisted name absent from surface.environment is not fabricated into env", () => {
  const profile = baseProfile({ environmentAllowlist: ["ORGA_MISSING"] });
  const command = buildClaudeAttemptCommand(profile, "packet", baseSurface({ environment: {} }), "/schema/path.json");
  assert.deepEqual(command.env, {});
});

test("buildClaudeAttemptCommand: never emits --background, --resume, or --continue for a fully populated profile, and always emits --json-schema", () => {
  const profile = baseProfile({
    model: "opus",
    effort: "high",
    permissionMode: "acceptEdits",
    toolPolicy: { allowedTools: ["Read"], disallowedTools: ["Bash"] },
    environmentAllowlist: ["ORGA_ALLOWED"],
    budgetUsd: 5,
  });
  const surface = baseSurface({ environment: { ORGA_ALLOWED: "1" } });
  const command = buildClaudeAttemptCommand(profile, "packet", surface, "/schema/path.json");
  assert.equal(command.args.includes("--background"), false);
  assert.equal(command.args.includes("--resume"), false);
  assert.equal(command.args.includes("--continue"), false);
  assert.ok(command.args.includes("--json-schema"));
});

// ── the Claude VendorProbeSpec, verified directly through probeVendor ──────

test("claudeProbeSpec: probeVendor reports all nine CapabilityReport fields against the local install", async () => {
  const configuration: ProbeConfiguration = {
    executablePath: claudeProbeSpec.defaultExecutable,
    requestedModel: "sonnet",
    requestedEffort: "low",
    workingDirectory: process.cwd(),
    environment: process.env,
  };
  const report: CapabilityReport = await probeVendor(claudeProbeSpec, configuration);

  assert.notEqual(report.executablePath, "unknown", "the local claude binary must resolve on PATH");
  assert.match(report.cliVersion, /^\d+\.\d+\.\d+/);
  assert.equal(report.requestedModel, "sonnet");
  assert.equal(report.requestedEffort, "low");
  assert.equal(report.structuredOutputMode, "stream-json");
  assert.ok(
    ["authenticated", "unauthenticated", "unknown", "probe-timeout"].includes(report.authenticationOutcome),
  );
  assert.equal(typeof report.workingDirectoryBehavior, "string");
  assert.equal(typeof report.permissionAndSandboxConfiguration, "string");
  assert.equal(report.adapterVersion, "1");
});

// ── the ten captures, replayed through the production adapter ──────────────

test("captures directory: holds exactly the ten CAPTURE_CASES names, no eleventh, none missing", () => {
  const files = fs.readdirSync(CAPTURE_DIR).filter((name) => name.endsWith(".jsonl"));
  const names = files.map((name) => name.replace(/\.jsonl$/, "")).sort();
  assert.deepEqual(names, [...CAPTURE_CASES].sort());
});

test("every capture passes loadCapture without a refusal", () => {
  for (const captureCase of CAPTURE_CASES) {
    const raw = fs.readFileSync(path.join(CAPTURE_DIR, `${captureCase}.jsonl`), "utf8");
    const capture = loadCapture(raw);
    assert.equal(capture.metadata.case, captureCase);
    assert.equal(capture.metadata.vendor, "claude");
  }
});

// The same inline replay indirection `13-adapter-stream-cases.ts` uses (its
// `REPLAY_SCRIPT`/`buildCommand`, lines ~119-139 and ~167-175): a spawned
// `process.execPath` writes a capture's stored lines to stdout verbatim, so no test
// here ever spawns `claude`. "crash" additionally self-signals SIGKILL once its bytes
// are flushed, reproducing a process that never reaches its own exit path — the shape
// `missing-final-event` needs to prove `streamTruncated` without a fabricated exit code.
const REPLAY_SCRIPT = `
const fs = require('node:fs');
const mode = process.argv[1];
const filePath = process.argv[2];
const exitCode = Number(process.argv[3]);
const raw = fs.readFileSync(filePath, 'utf8');
process.stdout.write(raw, () => {
  if (mode === 'crash') {
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  process.exit(exitCode);
});
`;

function writeReplayLinesFile(lines: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-capture-replay-"));
  const filePath = path.join(dir, "lines.jsonl");
  fs.writeFileSync(filePath, lines.map((line) => `${line}\n`).join(""), "utf8");
  return filePath;
}

function buildReplayCommand(lines: readonly string[], mode: "cat" | "crash", exitCode: number) {
  return (context: VendorCommandContext): VendorCommand => ({
    command: process.execPath,
    args: ["-e", REPLAY_SCRIPT, mode, writeReplayLinesFile(lines), String(exitCode)],
    input: context.packet,
    cwd: context.surface.workingDirectory,
    env: context.surface.environment,
  });
}

function replaySpec(lines: readonly string[], mode: "cat" | "crash", exitCode: number): VendorAdapterSpec {
  return {
    vendor: "claude",
    buildCommand: buildReplayCommand(lines, mode, exitCode),
    toEvents,
    extractSignals,
  };
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

const terminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && groupAlive(pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    signalSent: "SIGTERM",
    exitCode: null,
    killedProcessTree: !groupAlive(pgid),
    timedOutWaitingForExit: groupAlive(pgid),
  };
};

async function fixtureProbe(configuration: ProbeConfiguration): Promise<CapabilityReport> {
  return {
    executablePath: configuration.executablePath,
    cliVersion: "capture-replay/1",
    requestedModel: configuration.requestedModel,
    requestedEffort: configuration.requestedEffort,
    structuredOutputMode: "stream-json",
    authenticationOutcome: "not-applicable",
    workingDirectoryBehavior: "honored",
    permissionAndSandboxConfiguration: "none",
    adapterVersion: "capture-replay@1",
  };
}

function replayAttempt(attemptId: string): AttemptDescriptor {
  return {
    attemptId,
    runId: "run_claude_capture_replay",
    taskId: "task_claude_capture_replay",
    stageId: "implement",
    roleId: "implementer",
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
  };
}

function replaySurface(): ExecutionSurface {
  return {
    workingDirectory: process.cwd(),
    environment: process.env,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };
}

async function drainAll(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

interface ReplayOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  candidateReportText: string | null;
  ok: boolean;
  failureClass: string | null;
  reason: string | null;
}

// The exit shape each case reproduces at replay time. The seven genuine cases carry the
// exit code (or, for `missing-final-event`, the "crash" self-signal) actually observed
// when the case was recorded; `authentication-failure` and `rate-limit` mirror the
// non-zero exit the one genuinely provoked API-error capture (`process-crash`) showed.
const REPLAY_EXIT: Readonly<Record<CaptureCase, { mode: "cat" | "crash"; exitCode: number }>> = {
  "normal-success": { mode: "cat", exitCode: 0 },
  "schema-constrained-result": { mode: "cat", exitCode: 0 },
  "tool-failure-in-success": { mode: "cat", exitCode: 0 },
  "permission-denial": { mode: "cat", exitCode: 0 },
  "authentication-failure": { mode: "cat", exitCode: 1 },
  "rate-limit": { mode: "cat", exitCode: 1 },
  "process-crash": { mode: "cat", exitCode: 1 },
  "missing-final-event": { mode: "crash", exitCode: 0 },
  "unknown-event-type": { mode: "cat", exitCode: 0 },
  "version-output-change": { mode: "cat", exitCode: 0 },
};

async function replayCapture(captureCase: CaptureCase): Promise<ReplayOutcome> {
  const raw = fs.readFileSync(path.join(CAPTURE_DIR, `${captureCase}.jsonl`), "utf8");
  const capture = loadCapture(raw);
  const { mode, exitCode } = REPLAY_EXIT[captureCase];
  const spec = replaySpec(capture.lines, mode, exitCode);
  const adapter = createVendorAdapter(spec, { probe: fixtureProbe, terminate });
  const handle = await adapter.start(replayAttempt(captureCase), "packet body", replaySurface());
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);
  const outcome = await adapter.classify(artifacts);
  return {
    exitCode: artifacts.exitCode,
    signal: artifacts.signal,
    candidateReportText: artifacts.candidateReportText,
    ok: outcome.ok,
    failureClass: outcome.failureClass,
    reason: outcome.reason,
  };
}

test("normal-success: a clean run with a schema-valid report classifies ok with no failure class", async () => {
  const result = await replayCapture("normal-success");
  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.failureClass, null);
});

test("schema-constrained-result: a --json-schema-constrained report validates and classifies ok", async () => {
  const result = await replayCapture("schema-constrained-result");
  assert.equal(result.ok, true);
  assert.equal(result.failureClass, null);
  assert.notEqual(result.candidateReportText, null);
});

test("tool-failure-in-success: a tool error inside an otherwise clean run stays ok, with the failure recorded", async () => {
  const result = await replayCapture("tool-failure-in-success");
  assert.equal(result.ok, true);
  assert.equal(result.failureClass, null);
  assert.match(result.reason ?? "", /tool-failures=1/);
});

test("permission-denial: a permission_denials entry classifies permission-denied even at exit code zero", async () => {
  const result = await replayCapture("permission-denial");
  assert.equal(result.exitCode, 0, "the capture's own recorded process exited zero");
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "permission-denied");
  assert.match(result.reason ?? "", /permission-denials=1/);
});

test("authentication-failure: an authentication API error classifies the authentication failure class", async () => {
  const result = await replayCapture("authentication-failure");
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "authentication");
});

test("rate-limit: a rate-limit API error classifies the rate-limit failure class", async () => {
  const result = await replayCapture("rate-limit");
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "rate-limit");
});

test("process-crash: a non-zero exit with no candidate report classifies worker-crash", async () => {
  const result = await replayCapture("process-crash");
  assert.equal(result.exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, "worker-crash");
});

test("missing-final-event: a stream with no result event sets streamTruncated and fails closed", async () => {
  const result = await replayCapture("missing-final-event");
  assert.equal(result.candidateReportText, null);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /stream-truncated/);
});

test("unknown-event-type: an unmodeled event type is preserved and ignored for control flow", async () => {
  const result = await replayCapture("unknown-event-type");
  assert.equal(result.ok, true);
  assert.equal(result.failureClass, null);
  assert.match(result.reason ?? "", /unknown-event-types=1/);
});

test("version-output-change: the version-probe capture carries no result event when driven through the attempt pipeline", async () => {
  const result = await replayCapture("version-output-change");
  assert.equal(result.candidateReportText, null);
  assert.equal(result.ok, false);
});

// ── cost/model metadata is observability only ───────────────────────────────

test("extractSignals: costMeta mirrors extractClaudeResultMeta and never reaches ok/failureClass", async () => {
  const raw = fs.readFileSync(path.join(CAPTURE_DIR, "schema-constrained-result.jsonl"), "utf8");
  const capture = loadCapture(raw);
  const { mode, exitCode } = REPLAY_EXIT["schema-constrained-result"];
  const spec = replaySpec(capture.lines, mode, exitCode);
  const adapter = createVendorAdapter(spec, { probe: fixtureProbe, terminate });
  const handle = await adapter.start(replayAttempt("schema-constrained-result-cost"), "packet body", replaySurface());
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);

  const signals = extractSignals({
    artifacts,
    values: [],
    trailing: "",
    streamTruncated: false,
    descendantsAlive: false,
  });
  const expectedMeta = extractClaudeResultMeta(artifacts.stdout);
  assert.deepEqual(signals.costMeta, expectedMeta);
  assert.notEqual(signals.costMeta, null);
  assert.ok((signals.costMeta?.costUsd ?? 0) > 0, "the recorded capture reported a non-zero cost");

  // AttemptOutcome (adapter.ts) has no cost-shaped field at all: ok/report/failureClass/
  // reason. No value from costMeta can reach it because nothing here ever routes it
  // there — classify.ts reads only the five VendorSignals fields it declares.
  const outcome = await adapter.classify(artifacts);
  assert.deepEqual(Object.keys(outcome).sort(), ["failureClass", "ok", "report", "reason"].sort());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.failureClass, null);
});

// ── the four substrate stream cases, against the existing fixture directory ─

test("adapterStreamCases(claude, adapter-substrate fixtures)", async (t) => {
  for (const streamCase of adapterStreamCases("claude", SUBSTRATE_FIXTURE_DIR)) {
    await t.test(streamCase.name, streamCase.run);
  }
});
