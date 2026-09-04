// The fake `ProcessAdapter`: spawns the real `evals/fake-bin/replay.ts` script as a
// standalone process (a real pid, a real process group, a real SIGTERM trap when the
// scripted stream asks for one) and replays its output as `NormalizedEvent`s. No vendor
// binary is ever invoked.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

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
import { ReportValidationError, createReportValidator, type ReportValidator } from "../compile/report-validator.ts";

const DEFAULT_STREAMS_DIR = fileURLToPath(new URL("../../evals/fake-bin/streams/", import.meta.url));
const DEFAULT_REPLAY_SCRIPT = fileURLToPath(new URL("../../evals/fake-bin/replay.ts", import.meta.url));
const SCHEMAS_DIR = fileURLToPath(new URL("../../../workflows/schemas/", import.meta.url));

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

function loadBundledStageResultSchema(): object {
  const stageResult = JSON.parse(readFileSync(path.join(SCHEMAS_DIR, "stage-result.schema.json"), "utf8")) as Record<
    string,
    unknown
  >;
  delete stageResult.$schema;
  const defs = (stageResult.$defs ?? {}) as Record<string, unknown>;
  stageResult.$defs = defs;

  for (const { local, file } of SCHEMA_REF_BUNDLE.values()) {
    const sub = JSON.parse(readFileSync(path.join(SCHEMAS_DIR, file), "utf8")) as Record<string, unknown>;
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

export interface RecordedProcessInfo {
  pid: number;
  pgid: number;
}

/**
 * Actually ends a process group. The fake adapter never writes this itself: goals spec
 * section 13.3's termination sequence belongs to whichever scheduler owns cancellation;
 * the fake only guarantees `cancel` reaches whatever the caller supplies.
 */
export type TerminateFn = (
  info: RecordedProcessInfo,
  gracePeriodMs: number,
) => Promise<Omit<TerminationReport, "attemptId">>;

export interface FakeAdapterOptions {
  /** Selects the scenario name for an attempt; defaults to the attempt's own id. */
  scenarioFor?: (attempt: AttemptDescriptor) => string;
  streamsDir?: string;
  replayScript?: string;
  terminate: TerminateFn;
}

interface RuntimeAttempt {
  child: ChildProcessByStdio<null, Readable, Readable>;
  pid: number;
  pgid: number;
  events: NormalizedEvent[];
  stdoutBuffer: string;
  stdout: string;
  stderr: string;
  candidateReportText: string | null;
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

function pushEvent(attempt: RuntimeAttempt, event: NormalizedEvent): void {
  attempt.events.push(event);
  notifyWaiters(attempt.waiters);
}

function consumeStdoutLine(attempt: RuntimeAttempt, rawLine: string): void {
  const line = rawLine.trim();
  if (line === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const wire = parsed as { type?: unknown; text?: unknown; report?: unknown };
  if (wire.type === "output" && typeof wire.text === "string") {
    pushEvent(attempt, { type: "output", text: wire.text, timestamp: nowIso() });
  } else if (wire.type === "report") {
    attempt.candidateReportText = JSON.stringify(wire.report);
    pushEvent(attempt, { type: "output", text: attempt.candidateReportText, timestamp: nowIso() });
  }
}

export class FakeAdapter implements ProcessAdapter {
  private readonly streamsDir: string;
  private readonly replayScript: string;
  private readonly scenarioFor: (attempt: AttemptDescriptor) => string;
  private readonly terminate: TerminateFn;
  private readonly reportValidator: ReportValidator;
  private readonly attempts = new Map<string, RuntimeAttempt>();

  constructor(options: FakeAdapterOptions) {
    this.streamsDir = options.streamsDir ?? DEFAULT_STREAMS_DIR;
    this.replayScript = options.replayScript ?? DEFAULT_REPLAY_SCRIPT;
    this.scenarioFor = options.scenarioFor ?? ((attempt) => attempt.attemptId);
    this.terminate = options.terminate;
    this.reportValidator = createReportValidator(loadBundledStageResultSchema());
  }

  async probe(configuration: ProbeConfiguration): Promise<CapabilityReport> {
    return {
      executablePath: configuration.executablePath,
      cliVersion: "fake-adapter-stream/1",
      requestedModel: configuration.requestedModel,
      requestedEffort: configuration.requestedEffort,
      structuredOutputMode: "jsonl",
      authenticationOutcome: "not-applicable",
      workingDirectoryBehavior: "honored",
      permissionAndSandboxConfiguration: "none",
      adapterVersion: "fake-adapter@1",
    };
  }

  async start(attempt: AttemptDescriptor, _packet: string, surface: ExecutionSurface): Promise<ProcessHandle> {
    const scenario = this.scenarioFor(attempt);
    const streamFile = path.join(this.streamsDir, `${attempt.stageId}--${scenario}.jsonl`);

    const child = spawn(process.execPath, [this.replayScript, streamFile], {
      cwd: surface.workingDirectory,
      env: surface.environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const runtimeAttempt: RuntimeAttempt = {
      child,
      pid: child.pid ?? -1,
      pgid: child.pid ?? -1,
      events: [],
      stdoutBuffer: "",
      stdout: "",
      stderr: "",
      candidateReportText: null,
      exitCode: null,
      signal: null,
      finished: false,
      waiters: [],
      finishedWaiters: [],
    };
    this.attempts.set(attempt.attemptId, runtimeAttempt);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      runtimeAttempt.stdout += text;
      runtimeAttempt.stdoutBuffer += text;
      let newlineIndex = runtimeAttempt.stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        consumeStdoutLine(runtimeAttempt, runtimeAttempt.stdoutBuffer.slice(0, newlineIndex));
        runtimeAttempt.stdoutBuffer = runtimeAttempt.stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = runtimeAttempt.stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      runtimeAttempt.stderr += text;
      pushEvent(runtimeAttempt, { type: "diagnostic", text, timestamp: nowIso() });
    });

    child.on("exit", (code, signal) => {
      if (runtimeAttempt.stdoutBuffer.length > 0) {
        consumeStdoutLine(runtimeAttempt, runtimeAttempt.stdoutBuffer);
        runtimeAttempt.stdoutBuffer = "";
      }
      runtimeAttempt.exitCode = code;
      runtimeAttempt.signal = signal;
      runtimeAttempt.finished = true;
      pushEvent(runtimeAttempt, { type: "exit", code, signal, timestamp: nowIso() });
      notifyWaiters(runtimeAttempt.finishedWaiters);
    });

    return {
      attemptId: attempt.attemptId,
      pid: runtimeAttempt.pid,
      pgid: runtimeAttempt.pgid,
      worktree: surface.workingDirectory,
      startedAt: nowIso(),
    };
  }

  observe(handle: ProcessHandle): AsyncIterable<NormalizedEvent> {
    const attempt = this.requireAttempt(handle.attemptId);
    return observeAttempt(attempt);
  }

  async cancel(handle: ProcessHandle, gracePeriodMs: number): Promise<TerminationReport> {
    this.requireAttempt(handle.attemptId);
    const report = await this.terminate({ pid: handle.pid, pgid: handle.pgid }, gracePeriodMs);
    return { ...report, attemptId: handle.attemptId };
  }

  async collect(handle: ProcessHandle): Promise<AttemptArtifacts> {
    const attempt = this.requireAttempt(handle.attemptId);
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
  }

  async classify(artifacts: AttemptArtifacts): Promise<AttemptOutcome> {
    if (artifacts.candidateReportText === null) {
      const exitedClean = artifacts.exitCode === 0;
      return {
        ok: false,
        report: null,
        failureClass: exitedClean ? "runner-invariant" : "worker-crash",
        reason: exitedClean
          ? "process exited cleanly without producing a candidate report"
          : `process exited with code ${String(artifacts.exitCode)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(artifacts.candidateReportText);
    } catch (error) {
      return {
        ok: false,
        report: null,
        failureClass: "schema-invalid",
        reason: `candidate report is not valid JSON: ${(error as Error).message}`,
      };
    }

    try {
      const report = this.reportValidator.validateObject(parsed);
      return { ok: true, report, failureClass: null, reason: null };
    } catch (error) {
      if (error instanceof ReportValidationError) {
        return { ok: false, report: null, failureClass: "schema-invalid", reason: error.message };
      }
      throw error;
    }
  }

  private requireAttempt(attemptId: string): RuntimeAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new Error(`unknown attempt: ${attemptId}`);
    }
    return attempt;
  }
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
