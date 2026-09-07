// The durable, vendor-neutral process adapter contract (goals spec section 13). Every
// vendor adapter (the fake one here, and vendor-specific adapters for real CLI tools,
// implemented separately) is a concrete `ProcessAdapter`. This module declares types
// only: no vendor logic, no process spawning, no I/O.

/** Input to `probe`: what to probe and where (goals spec section 13.1). */
export interface ProbeConfiguration {
  /** The binary to resolve and execute; `command -v` alone is not a valid probe. */
  executablePath: string;
  requestedModel: string;
  requestedEffort: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
}

/**
 * The readiness probe's report. Carries exactly the nine facts goals spec section 13.1
 * requires: its eight bullets, with "requested model and effort" split into two fields.
 * The probe MUST NOT inspect credential files (section 13.1); `authenticationOutcome`
 * comes from a bounded real invocation, never from reading a credential store.
 */
export interface CapabilityReport {
  executablePath: string;
  cliVersion: string;
  requestedModel: string;
  requestedEffort: string;
  structuredOutputMode: string;
  authenticationOutcome: string;
  workingDirectoryBehavior: string;
  permissionAndSandboxConfiguration: string;
  adapterVersion: string;
}

/** The three independent timeouts goals spec section 13.3 requires for every attempt. */
export interface TimeoutBudget {
  /** The process fails to start or initialize. */
  spawnMs: number;
  /** No `NormalizedEvent` arrives from `adapter.observe()` within this bound; the stream's events are its only signal. */
  idleMs: number;
  /**
   * Total attempt duration exceeds its configured limit. A wall timeout MUST terminate
   * the owned process tree; the termination sequence itself belongs to the scheduler
   * that owns `cancel`, not to this contract.
   */
  wallMs: number;
}

/** Identifies the attempt `start` is asked to run, independent of any vendor shape. */
export interface AttemptDescriptor {
  attemptId: string;
  runId: string;
  taskId: string;
  stageId: string;
  roleId: string;
  timeoutBudget: TimeoutBudget;
}

/**
 * The permission, sandbox, and environment surface a started process runs under
 * (goals spec section 13.2 and section 15.1). `allowedTools`/`disallowedTools` are
 * general enough to cover both a Claude-style tool allowlist and a Codex-style
 * sandbox mode string; a vendor adapter maps whichever subset it understands.
 */
export interface ExecutionSurface {
  workingDirectory: string;
  /** An explicit allowlist plus documented vendor variables (section 13.2); never inherited wholesale. */
  environment: NodeJS.ProcessEnv;
  sandboxMode: string | null;
  permissionMode: string | null;
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
}

/**
 * A live attempt's handle. `pgid` is what lets a caller signal the whole owned process
 * tree (section 13.2: "The process MUST belong to a runner-owned process group").
 */
export interface ProcessHandle {
  attemptId: string;
  pid: number;
  pgid: number;
  worktree: string;
  startedAt: string;
}

/** A single normalized signal observed from a running attempt. */
export type NormalizedEvent =
  | { type: "output"; text: string; timestamp: string }
  | { type: "diagnostic"; text: string; timestamp: string }
  | { type: "permission-denial"; detail: string; timestamp: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; timestamp: string };

/** What `cancel` reports back about how termination went. */
export interface TerminationReport {
  attemptId: string;
  signalSent: NodeJS.Signals | null;
  exitCode: number | null;
  killedProcessTree: boolean;
  timedOutWaitingForExit: boolean;
}

/** The raw facts `collect` gathers once an attempt has ended, before classification. */
export interface AttemptArtifacts {
  attemptId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /**
   * The vendor's schema-constrained last message (section 14) or final JSON envelope
   * (section 15), unvalidated. Null when the process produced no candidate report.
   */
  candidateReportText: string | null;
  events: readonly NormalizedEvent[];
}

/**
 * The fourteen-value failure-class enum goals spec section 27 requires the runner to
 * distinguish. Retry policy is keyed by this value elsewhere; this module only names it.
 */
export type FailureClass =
  | "configuration"
  | "binary-missing"
  | "authentication"
  | "rate-limit"
  | "provider-overload"
  | "permission-denied"
  | "schema-invalid"
  | "worker-timeout"
  | "worker-crash"
  | "verification-failure"
  | "review-failure"
  | "integration-conflict"
  | "destination-moved"
  | "runner-invariant";

/**
 * `classify`'s verdict on one attempt's artifacts. Classification MUST read structured
 * events and process metadata, never substrings of prompt or stdout text
 * (target architecture section 15, "structured-error-source").
 */
export interface AttemptOutcome {
  ok: boolean;
  report: Record<string, unknown> | null;
  failureClass: FailureClass | null;
  reason: string | null;
}

/**
 * The six-method contract every vendor adapter implements identically (goals spec
 * section 13). This interface is the durable surface a real Claude or Codex adapter
 * must satisfy; nothing here is shaped by what the fake adapter happens to need.
 */
export interface ProcessAdapter {
  probe(configuration: ProbeConfiguration): Promise<CapabilityReport>;
  start(attempt: AttemptDescriptor, packet: string, surface: ExecutionSurface): Promise<ProcessHandle>;
  observe(handle: ProcessHandle): AsyncIterable<NormalizedEvent>;
  cancel(handle: ProcessHandle, gracePeriodMs: number): Promise<TerminationReport>;
  collect(handle: ProcessHandle): Promise<AttemptArtifacts>;
  classify(artifacts: AttemptArtifacts): Promise<AttemptOutcome>;
}
