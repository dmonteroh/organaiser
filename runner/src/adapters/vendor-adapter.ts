// Turns a vendor-specific `VendorAdapterSpec` (an argument-array builder, a stream-event
// translator, and a signal extractor) into a full `ProcessAdapter`. Everything else —
// spawning the process group, framing stdout, keeping stderr as a separate artifact,
// classifying the outcome — lives here once, so the Claude and Codex adapters embed it
// identically. This module names no vendor and imports nothing from a vendor's own
// module: a vendor closes over its own resolved profile when it builds its spec.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  AttemptArtifacts,
  AttemptDescriptor,
  AttemptOutcome,
  CapabilityReport,
  ExecutionSurface,
  NormalizedEvent,
  ProbeConfiguration,
  ProcessAdapter,
  ProcessHandle,
  TerminationReport,
} from "./adapter.ts";
import { classifyAttempt, type VendorSignals } from "./classify.ts";
import { createJsonlFramer } from "./jsonl.ts";
import { groupAlive } from "./process-group.ts";
import { createReportValidator, type ReportValidator } from "../compile/report-validator.ts";

/** What `buildCommand` returns: the exact argument array to spawn, never a shell string. */
export interface VendorCommand {
  command: string;
  args: readonly string[];
  input: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** What `buildCommand` is given. No resolved vendor profile crosses this seam. */
export interface VendorCommandContext {
  attempt: AttemptDescriptor;
  packet: string;
  surface: ExecutionSurface;
  schemaPath: string;
}

/** What `toEvents` returns for one framed stdout value. */
export interface VendorStreamOutput {
  events: readonly NormalizedEvent[];
  candidateReportText: string | null;
}

/** What `extractSignals` is given, once the attempt has finished. */
export interface VendorSignalInput {
  /** Exit code, signal, stdout, stderr, candidate report text, and normalized events. */
  artifacts: AttemptArtifacts;
  /** Every JSON value `jsonl.ts` framed from stdout, in stream order. */
  values: readonly unknown[];
  /** `end().trailing`: whatever bytes never formed a complete final line. */
  trailing: string;
  /** `end().truncated`: whether `trailing` held an unterminated line. */
  streamTruncated: boolean;
  /** `groupAlive(handle.pgid)`, sampled after the process exited. */
  descendantsAlive: boolean;
}

/**
 * The four-member seam a vendor module implements verbatim. `toEvents` folds report
 * extraction into event translation rather than adding a fifth member: it is called
 * once per framed stdout value and returns zero or more events plus a
 * `candidateReportText` that is non-null only on the value that is the vendor's final
 * report envelope.
 */
export interface VendorAdapterSpec {
  vendor: string;
  buildCommand(context: VendorCommandContext): VendorCommand;
  toEvents(value: unknown, timestamp: string): VendorStreamOutput;
  extractSignals(input: VendorSignalInput): VendorSignals;
}

/** A live attempt's process identity, the minimum a terminator needs to signal it. */
export interface RecordedProcessInfo {
  pid: number;
  pgid: number;
}

/**
 * Actually ends a process group. Declared here rather than imported from `fake.ts`
 * because `fake.ts` is test-support and production code must not depend on it; the two
 * declarations are structurally identical by design. This module supplies no default
 * terminator and reimplements no grace-window logic — the caller injects one.
 */
export type TerminateFn = (
  info: RecordedProcessInfo,
  gracePeriodMs: number,
) => Promise<Omit<TerminationReport, "attemptId">>;

/**
 * Every seam `createVendorAdapter` needs from its caller: the readiness probe, the
 * terminator, and (optionally) which report schema to validate candidate reports
 * against. Injected here, not on `VendorAdapterSpec`, so a vendor module never needs to
 * know how probing or termination are wired.
 */
export interface VendorAdapterOptions {
  probe: (configuration: ProbeConfiguration) => Promise<CapabilityReport>;
  terminate: TerminateFn;
  schemaPath?: string;
}

const DEFAULT_SCHEMA_PATH = fileURLToPath(
  new URL("../../../workflows/schemas/stage-result.schema.json", import.meta.url),
);

// `stage-result.schema.json` $refs four sibling schema files by absolute $id, which in
// turn $ref two more; Ajv only resolves a $ref against a schema already registered on
// the same instance, and `createReportValidator` compiles exactly one schema object
// with no hook to register siblings first. Bundling every referenced file into the
// report schema's own `$defs` (rewriting each $ref to a local pointer) makes the whole
// closure resolvable from that one object, so `createReportValidator` itself stays
// untouched and does exactly what it always does: pure structural validation.
const SCHEMA_REF_BUNDLE: ReadonlyMap<string, { local: string; file: string }> = new Map([
  ["https://ai-workflows.dev/schemas/open-question.schema.json", { local: "openQuestion", file: "open-question.schema.json" }],
  ["https://ai-workflows.dev/schemas/review-finding.schema.json", { local: "reviewFinding", file: "review-finding.schema.json" }],
  ["https://ai-workflows.dev/schemas/task-proposal.schema.json", { local: "taskProposal", file: "task-proposal.schema.json" }],
  ["https://ai-workflows.dev/schemas/board.schema.json", { local: "board", file: "board.schema.json" }],
  ["https://ai-workflows.dev/schemas/task-brief.schema.json", { local: "taskBrief", file: "task-brief.schema.json" }],
]);

function walkRefs(node: unknown, rewrite: (ref: string) => string): void {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, rewrite);
    return;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (key === "$ref" && typeof value === "string") {
        record[key] = rewrite(value);
      } else {
        walkRefs(value, rewrite);
      }
    }
  }
}

function loadBundledStageResultSchema(schemaPath: string): object {
  const schemasDir = fileURLToPath(new URL(".", `file://${schemaPath}`));
  const stageResult = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  delete stageResult.$schema;
  const defs = (stageResult.$defs ?? {}) as Record<string, unknown>;
  stageResult.$defs = defs;

  for (const { local, file } of SCHEMA_REF_BUNDLE.values()) {
    const sub = JSON.parse(readFileSync(`${schemasDir}${file}`, "utf8")) as Record<string, unknown>;
    delete sub.$schema;
    delete sub.$id;
    walkRefs(sub, (ref) => (ref.startsWith("#/") ? `#/$defs/${local}${ref.slice(1)}` : ref));
    defs[local] = sub;
  }

  walkRefs(stageResult, (ref) => {
    const [url, fragment] = ref.split("#");
    const entry = SCHEMA_REF_BUNDLE.get(url);
    if (!entry) return ref;
    return `#/$defs/${entry.local}${fragment ? `/${fragment.replace(/^\//, "")}` : ""}`;
  });

  return stageResult;
}

interface RuntimeAttempt {
  pid: number;
  pgid: number;
  events: NormalizedEvent[];
  stdout: string;
  stderr: string;
  values: unknown[];
  candidateReportText: string | null;
  streamTruncated: boolean;
  trailing: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finished: boolean;
  waiters: Array<() => void>;
  finishedWaiters: Array<() => void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function notifyWaiters(waiters: Array<() => void>): void {
  const toResolve = waiters.splice(0, waiters.length);
  for (const resolve of toResolve) resolve();
}

/**
 * Builds a full `ProcessAdapter` from a vendor's `VendorAdapterSpec` plus the seams in
 * `options`. No vendor knowledge lives here: the child's argument array, event shape,
 * and signal extraction all come from `spec`.
 */
export function createVendorAdapter(spec: VendorAdapterSpec, options: VendorAdapterOptions): ProcessAdapter {
  const schemaPath = options.schemaPath ?? DEFAULT_SCHEMA_PATH;
  const reportValidator: ReportValidator = createReportValidator(loadBundledStageResultSchema(schemaPath));
  const attempts = new Map<string, RuntimeAttempt>();

  function requireAttempt(attemptId: string): RuntimeAttempt {
    const attempt = attempts.get(attemptId);
    if (!attempt) throw new Error(`unknown attempt: ${attemptId}`);
    return attempt;
  }

  return {
    async probe(configuration: ProbeConfiguration): Promise<CapabilityReport> {
      return options.probe(configuration);
    },

    async start(attempt: AttemptDescriptor, packet: string, surface: ExecutionSurface): Promise<ProcessHandle> {
      const command = spec.buildCommand({ attempt, packet, surface, schemaPath });
      const child = spawn(command.command, [...command.args], {
        cwd: command.cwd,
        env: command.env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const pid = child.pid ?? -1;
      const runtimeAttempt: RuntimeAttempt = {
        pid,
        pgid: pid,
        events: [],
        stdout: "",
        stderr: "",
        values: [],
        candidateReportText: null,
        streamTruncated: false,
        trailing: "",
        exitCode: null,
        signal: null,
        finished: false,
        waiters: [],
        finishedWaiters: [],
      };
      attempts.set(attempt.attemptId, runtimeAttempt);

      const framer = createJsonlFramer();

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        runtimeAttempt.stdout += text;
        const values = framer.push(text);
        for (const value of values) {
          runtimeAttempt.values.push(value);
          const output = spec.toEvents(value, nowIso());
          for (const event of output.events) {
            runtimeAttempt.events.push(event);
          }
          if (output.candidateReportText !== null) {
            runtimeAttempt.candidateReportText = output.candidateReportText;
          }
        }
        notifyWaiters(runtimeAttempt.waiters);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        runtimeAttempt.stderr += chunk.toString("utf8");
      });

      child.on("exit", (code, signal) => {
        const ended = framer.end();
        runtimeAttempt.trailing = ended.trailing;
        runtimeAttempt.streamTruncated = ended.truncated;
        runtimeAttempt.exitCode = code;
        runtimeAttempt.signal = signal;
        runtimeAttempt.finished = true;
        runtimeAttempt.events.push({ type: "exit", code, signal, timestamp: nowIso() });
        notifyWaiters(runtimeAttempt.waiters);
        notifyWaiters(runtimeAttempt.finishedWaiters);
      });

      child.on("error", () => {
        if (runtimeAttempt.finished) return;
        const ended = framer.end();
        runtimeAttempt.trailing = ended.trailing;
        runtimeAttempt.streamTruncated = ended.truncated;
        runtimeAttempt.exitCode = 1;
        runtimeAttempt.signal = null;
        runtimeAttempt.finished = true;
        runtimeAttempt.events.push({ type: "exit", code: 1, signal: null, timestamp: nowIso() });
        notifyWaiters(runtimeAttempt.waiters);
        notifyWaiters(runtimeAttempt.finishedWaiters);
      });

      // A child that exits before it ever reads stdin (or never reads it at all) turns
      // the write into an EPIPE; that is a normal race with a fast-exiting process, not
      // an adapter fault, so it is swallowed here rather than left to crash as an
      // unhandled stream error.
      child.stdin.on("error", () => {});
      child.stdin.write(command.input, () => {
        child.stdin.end();
      });

      return {
        attemptId: attempt.attemptId,
        pid: runtimeAttempt.pid,
        pgid: runtimeAttempt.pgid,
        worktree: surface.workingDirectory,
        startedAt: nowIso(),
      };
    },

    observe(handle: ProcessHandle): AsyncIterable<NormalizedEvent> {
      const attempt = requireAttempt(handle.attemptId);
      return observeAttempt(attempt);
    },

    async cancel(handle: ProcessHandle, gracePeriodMs: number): Promise<TerminationReport> {
      requireAttempt(handle.attemptId);
      const report = await options.terminate({ pid: handle.pid, pgid: handle.pgid }, gracePeriodMs);
      return { ...report, attemptId: handle.attemptId };
    },

    async collect(handle: ProcessHandle): Promise<AttemptArtifacts> {
      const attempt = requireAttempt(handle.attemptId);
      await waitFinished(attempt);
      return {
        attemptId: handle.attemptId,
        exitCode: attempt.exitCode,
        signal: attempt.signal,
        stdout: attempt.stdout,
        stderr: attempt.stderr,
        candidateReportText: attempt.candidateReportText,
        events: attempt.events,
      };
    },

    async classify(artifacts: AttemptArtifacts): Promise<AttemptOutcome> {
      const attempt = requireAttempt(artifacts.attemptId);
      const descendantsAlive = groupAlive(attempt.pgid);
      const vendorSignals = spec.extractSignals({
        artifacts,
        values: attempt.values,
        trailing: attempt.trailing,
        streamTruncated: attempt.streamTruncated,
        descendantsAlive,
      });
      // The substrate measures liveness and stream truncation itself: neither is the
      // vendor's to judge, so both are overwritten here regardless of what the vendor
      // spec reported.
      const signals: VendorSignals = {
        ...vendorSignals,
        descendantsAlive,
        streamTruncated: attempt.streamTruncated || vendorSignals.streamTruncated,
      };
      return classifyAttempt(artifacts, signals, reportValidator);
    },
  };
}

async function* observeAttempt(attempt: RuntimeAttempt): AsyncGenerator<NormalizedEvent> {
  let index = 0;
  for (;;) {
    while (index < attempt.events.length) {
      yield attempt.events[index];
      index++;
    }
    if (attempt.finished) return;
    await new Promise<void>((resolve) => attempt.waiters.push(resolve));
  }
}

function waitFinished(attempt: RuntimeAttempt): Promise<void> {
  if (attempt.finished) return Promise.resolve();
  return new Promise<void>((resolve) => attempt.finishedWaiters.push(resolve));
}
