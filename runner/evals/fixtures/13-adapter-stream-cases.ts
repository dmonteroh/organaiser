// Runs the four required deterministic stream cases (goals spec section 29.4:
// `exit-zero-permission-denial`, `partial-jsonl`, `partial-stream-survives-kill`,
// `structured-error-source`) against a vendor's captures, through the real
// `createVendorAdapter` pipeline end to end: a real spawned process, real stdout
// framing, real classification. The spec each case runs against is a minimal stand-in
// that speaks a fixed four-event wire format (`output`, `permission-denial`,
// `tool-failure`, `report`); a real vendor spec differs only in `buildCommand` and
// `toEvents`, never in what this proves about the substrate underneath it.

import assert from "node:assert/strict";
import path from "node:path";

import type {
  AttemptDescriptor,
  CapabilityReport,
  ExecutionSurface,
  NormalizedEvent,
  ProbeConfiguration,
} from "../../src/adapters/adapter.ts";
import {
  createVendorAdapter,
  type RecordedProcessInfo,
  type TerminateFn,
  type VendorAdapterSpec,
  type VendorCommand,
  type VendorCommandContext,
  type VendorSignalInput,
  type VendorStreamOutput,
} from "../../src/adapters/vendor-adapter.ts";
import type { VendorSignals } from "../../src/adapters/classify.ts";

export interface AdapterStreamCase {
  name: string;
  run: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// A minimal SIGTERM-then-SIGKILL terminator, scoped to what these cases need to prove
// `cancel` actually ends a real spawned process group. Production wiring of a
// `TerminateFn` over the runner's own termination sequence is a separate concern.
const terminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && groupAlive(pgid)) {
    await sleep(10);
  }
  if (groupAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // already gone
    }
    for (let i = 0; i < 30 && groupAlive(pgid); i++) await sleep(10);
  }
  return {
    signalSent: "SIGTERM",
    exitCode: null,
    killedProcessTree: !groupAlive(pgid),
    timedOutWaitingForExit: groupAlive(pgid),
  };
};

async function probe(configuration: ProbeConfiguration): Promise<CapabilityReport> {
  return {
    executablePath: configuration.executablePath,
    cliVersion: "adapter-substrate-fixture/1",
    requestedModel: configuration.requestedModel,
    requestedEffort: configuration.requestedEffort,
    structuredOutputMode: "jsonl",
    authenticationOutcome: "not-applicable",
    workingDirectoryBehavior: "honored",
    permissionAndSandboxConfiguration: "none",
    adapterVersion: "adapter-substrate-fixture@1",
  };
}

function attempt(attemptId: string): AttemptDescriptor {
  return {
    attemptId,
    runId: "run_adapter_substrate",
    taskId: "task_adapter_substrate",
    stageId: "implement",
    roleId: "implementer",
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
  };
}

function surface(): ExecutionSurface {
  return {
    workingDirectory: process.cwd(),
    environment: process.env,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };
}

// The inline replay script every case's `buildCommand` spawns: `mode: "cat"` writes the
// fixture file's raw bytes verbatim (preserving a deliberately unterminated final line),
// `mode: "slow"` writes one complete line at a time with a delay, so a case can kill the
// process mid-stream and prove partial output survives. No vendor binary is invoked.
const REPLAY_SCRIPT = `
const fs = require('node:fs');
const mode = process.argv[1];
const filePath = process.argv[2];
const exitCode = Number(process.argv[3]);
const raw = fs.readFileSync(filePath, 'utf8');
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function main() {
  if (mode === 'slow') {
    const lines = raw.split('\\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      process.stdout.write(line + '\\n');
      await sleep(80);
    }
    process.exit(exitCode);
  }
  process.stdout.write(raw);
  process.exit(exitCode);
}
main();
`;

interface WireOutput {
  type: "output";
  text: string;
}
interface WirePermissionDenial {
  type: "permission-denial";
  detail: string;
}
interface WireToolFailure {
  type: "tool-failure";
  tool: string;
}
interface WireReport {
  type: "report";
  report: unknown;
}
type WireLine = WireOutput | WirePermissionDenial | WireToolFailure | WireReport;

function isWireLine(value: unknown): value is WireLine {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function buildCommand(vendor: string, fixturePath: string, mode: "cat" | "slow", exitCode: number) {
  return (context: VendorCommandContext): VendorCommand => ({
    command: process.execPath,
    args: ["-e", REPLAY_SCRIPT, mode, fixturePath, String(exitCode)],
    input: context.packet,
    cwd: context.surface.workingDirectory,
    env: context.surface.environment,
  });
}

function toEvents(value: unknown, timestamp: string): VendorStreamOutput {
  if (!isWireLine(value)) return { events: [], candidateReportText: null };
  switch (value.type) {
    case "output":
      return { events: [{ type: "output", text: value.text, timestamp }], candidateReportText: null };
    case "permission-denial":
      return { events: [{ type: "permission-denial", detail: value.detail, timestamp }], candidateReportText: null };
    case "tool-failure":
      return {
        events: [{ type: "diagnostic", text: `tool failure: ${value.tool}`, timestamp }],
        candidateReportText: null,
      };
    case "report":
      return { events: [], candidateReportText: JSON.stringify(value.report) };
    default:
      return { events: [], candidateReportText: null };
  }
}

const KNOWN_WIRE_TYPES = new Set(["output", "permission-denial", "tool-failure", "report"]);

function extractSignals(input: VendorSignalInput): VendorSignals {
  const permissionDenials: string[] = [];
  const toolFailures: string[] = [];
  const unknownEventTypes: string[] = [];
  for (const value of input.values) {
    if (!isWireLine(value)) continue;
    if (value.type === "permission-denial") permissionDenials.push(value.detail);
    else if (value.type === "tool-failure") toolFailures.push(value.tool);
    else if (!KNOWN_WIRE_TYPES.has(value.type)) unknownEventTypes.push(value.type);
  }
  return {
    permissionDenials,
    toolFailures,
    vendorErrorClass: null,
    unknownEventTypes,
    streamTruncated: input.streamTruncated,
    descendantsAlive: input.descendantsAlive,
  };
}

function buildSpec(vendor: string, fixturePath: string, mode: "cat" | "slow", exitCode: number): VendorAdapterSpec {
  return {
    vendor,
    buildCommand: buildCommand(vendor, fixturePath, mode, exitCode),
    toEvents,
    extractSignals,
  };
}

async function drainAtLeast(events: AsyncIterable<NormalizedEvent>, count: number): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (collected.length >= count) return collected;
  }
  return collected;
}

async function drainAll(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function fixturePathFor(captureDir: string, caseName: string): string {
  return path.join(captureDir, `${caseName}.jsonl`);
}

async function exitZeroPermissionDenial(vendor: string, captureDir: string): Promise<void> {
  const spec = buildSpec(vendor, fixturePathFor(captureDir, "exit-zero-permission-denial"), "cat", 0);
  const adapter = createVendorAdapter(spec, { probe, terminate });
  const handle = await adapter.start(attempt("exit-zero-permission-denial"), "packet body", surface());
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);
  assert.equal(artifacts.exitCode, 0);
  const outcome = await adapter.classify(artifacts);
  assert.equal(outcome.ok, false, "an embedded permission denial must override a clean exit");
  assert.equal(outcome.failureClass, "permission-denied");
  assert.match(outcome.reason ?? "", /permission-denials=1/);
}

async function partialJsonl(vendor: string, captureDir: string): Promise<void> {
  const spec = buildSpec(vendor, fixturePathFor(captureDir, "partial-jsonl"), "cat", 1);
  const adapter = createVendorAdapter(spec, { probe, terminate });
  const handle = await adapter.start(attempt("partial-jsonl"), "packet body", surface());
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);
  assert.equal(artifacts.candidateReportText, null, "a truncated stream must never yield a candidate report");
  assert.match(artifacts.stdout, /cut off mid/, "the partial stdout must be retained on the artifacts");
  const outcome = await adapter.classify(artifacts);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failureClass, "worker-crash");
  assert.match(outcome.reason ?? "", /stream-truncated/);
}

async function partialStreamSurvivesKill(vendor: string, captureDir: string): Promise<void> {
  const spec = buildSpec(vendor, fixturePathFor(captureDir, "partial-stream-survives-kill"), "slow", 0);
  const adapter = createVendorAdapter(spec, { probe, terminate });
  const handle = await adapter.start(attempt("partial-stream-survives-kill"), "packet body", surface());

  const observed = await drainAtLeast(adapter.observe(handle), 1);
  assert.ok(observed.length >= 1, "at least one event must be observed before termination");

  await adapter.cancel(handle, 200);
  const artifacts = await adapter.collect(handle);

  const observedOutputTexts = observed.filter((event) => event.type === "output").map((event) => event.text);
  const artifactOutputTexts = artifacts.events.filter((event) => event.type === "output").map((event) => event.text);
  for (const text of observedOutputTexts) {
    assert.ok(
      artifactOutputTexts.includes(text),
      `every event observed before termination must remain present on collect's artifacts: missing ${text}`,
    );
  }
  assert.equal(
    artifacts.candidateReportText,
    null,
    "the process is killed before its report line is ever written",
  );
}

async function structuredErrorSource(vendor: string, captureDir: string): Promise<void> {
  const spec = buildSpec(vendor, fixturePathFor(captureDir, "structured-error-source"), "cat", 0);
  const adapter = createVendorAdapter(spec, { probe, terminate });
  const handle = await adapter.start(attempt("structured-error-source"), "packet body", surface());
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);
  const outcome = await adapter.classify(artifacts);
  assert.equal(
    outcome.ok,
    true,
    "assistant text that merely quotes error phrases must never trigger classification by itself",
  );
}

/**
 * Builds the four required deterministic stream cases against `captureDir`, a
 * directory holding one `<case>.jsonl` fixture file per case name. `vendor` labels the
 * cases and is threaded through to the stub spec's `vendor` field; it does not select
 * a different wire protocol — this proves the substrate, not any one vendor's shape.
 */
export function adapterStreamCases(vendor: string, captureDir: string): AdapterStreamCase[] {
  return [
    { name: `${vendor}: exit-zero-permission-denial`, run: () => exitZeroPermissionDenial(vendor, captureDir) },
    { name: `${vendor}: partial-jsonl`, run: () => partialJsonl(vendor, captureDir) },
    {
      name: `${vendor}: partial-stream-survives-kill`,
      run: () => partialStreamSurvivesKill(vendor, captureDir),
    },
    { name: `${vendor}: structured-error-source`, run: () => structuredErrorSource(vendor, captureDir) },
  ];
}
