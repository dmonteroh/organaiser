// The Codex CLI vendor adapter (goals spec section 14): the argument array `codex exec`
// is spawned with, where its schema-constrained final report actually lands, and the
// `--json` event vocabulary translated into the vendor-neutral substrate. Everything
// else — spawning, stdout framing, classification order — belongs to the shared
// `vendor-adapter.ts` substrate; this module only ever supplies the four-member
// `VendorAdapterSpec` seam plus the two things that seam cannot express: the
// last-message file and the readiness probe.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AttemptDescriptor, ExecutionSurface, ProcessAdapter, ProcessHandle } from "./adapter.ts";
import type { VendorSignals } from "./classify.ts";
import type {
  VendorAdapterOptions,
  VendorAdapterSpec,
  VendorCommand,
  VendorCommandContext,
  VendorSignalInput,
  VendorStreamOutput,
} from "./vendor-adapter.ts";
import { createVendorAdapter } from "./vendor-adapter.ts";
import type { ProbeSpawnResult, VendorProbeSpec } from "./probe.ts";
import type { ResolvedVendorProfile } from "../cli/profiles.ts";

/**
 * Where this attempt's `--output-last-message` file lives: keyed by run and attempt id,
 * under the OS temp directory rather than the assigned worktree, so a report file never
 * lands in the diff the runner later integrates and two concurrent attempts can never
 * collide. `buildCodexAttemptCommand`'s caller and `createCodexAdapter`'s `collect`
 * override both call this one helper, so the path the process was told to write and the
 * path this module reads back can never drift apart.
 */
export function lastMessagePathFor(attempt: Pick<AttemptDescriptor, "runId" | "attemptId">): string {
  return path.join(os.tmpdir(), "orga-attempts", attempt.runId, attempt.attemptId, "last-message.txt");
}

/**
 * The exact `codex exec` argument array (goals spec section 14): a fresh session every
 * call (no `resume`, no continuation flag), the packet handed to the caller separately
 * for standard input, and the reasoning-effort config value passed as one element with
 * no shell quoting added around it.
 */
export function buildCodexAttemptCommand(
  profile: ResolvedVendorProfile,
  packet: string,
  surface: ExecutionSurface,
  schemaPath: string,
  lastMessagePath: string,
): readonly string[] {
  return [
    "exec",
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    "--model",
    profile.model,
    "--config",
    `model_reasoning_effort=${profile.effort}`,
    "--sandbox",
    profile.sandboxMode,
    "--cd",
    surface.workingDirectory,
    "-",
  ];
}

/**
 * The environment MUST be an explicit allowlist plus documented vendor variables
 * (goals spec section 13.2): exactly the names `profile.environmentAllowlist` names
 * that are also present in `surface.environment`, nothing inherited wholesale, and no
 * Codex-specific variable hardcoded here.
 */
function allowedEnvironment(profile: ResolvedVendorProfile, surface: ExecutionSurface): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of profile.environmentAllowlist) {
    const value = surface.environment[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Builds the Codex `VendorAdapterSpec`. Exported on its own, separate from
 * `createCodexAdapter`, so a test can inspect the full `VendorCommand` (arguments,
 * `env`, `input`, `cwd`) a given attempt would produce without spawning any process —
 * `buildCommand` here is pure aside from creating the last-message directory.
 * `onAttemptStarted` is an optional bookkeeping hook `createCodexAdapter` uses to learn
 * an attempt's `runId` for its own `collect` override; nothing else needs it.
 */
export function createCodexVendorSpec(
  profile: ResolvedVendorProfile,
  onAttemptStarted?: (attempt: AttemptDescriptor) => void,
): VendorAdapterSpec {
  return {
    vendor: "codex",
    buildCommand(context: VendorCommandContext): VendorCommand {
      onAttemptStarted?.(context.attempt);
      const lastMessagePath = lastMessagePathFor(context.attempt);
      mkdirSync(path.dirname(lastMessagePath), { recursive: true, mode: 0o700 });
      return {
        command: profile.executable,
        args: buildCodexAttemptCommand(profile, context.packet, context.surface, context.schemaPath, lastMessagePath),
        input: context.packet,
        cwd: context.surface.workingDirectory,
        env: allowedEnvironment(profile, context.surface),
      };
    },
    toEvents: codexToEvents,
    extractSignals: codexExtractSignals,
  };
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  aggregated_output?: string;
  error?: string;
}

interface CodexEventBase {
  type: string;
}

interface CodexItemEvent extends CodexEventBase {
  type: "item.started" | "item.updated" | "item.completed";
  item?: CodexItem;
}

interface CodexErrorEvent extends CodexEventBase {
  type: "error";
  message?: string;
}

interface CodexTurnFailedEvent extends CodexEventBase {
  type: "turn.failed";
  error?: { message?: string };
}

type CodexEvent = CodexItemEvent | CodexErrorEvent | CodexTurnFailedEvent | CodexEventBase;

function isCodexEvent(value: unknown): value is CodexEvent {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

const KNOWN_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);

/** A structured-field check on a control-plane message, never on assistant text or stdout. */
const SANDBOX_DENIAL_PATTERN = /sandbox|approval|not permitted|permission denied/i;
const AUTHENTICATION_PATTERN = /unauthor|401|forbidden|authenticat|not logged in|login required/i;
const RATE_LIMIT_PATTERN = /429|rate.?limit/i;
const OVERLOAD_PATTERN = /overloaded|503|529|capacity|unavailable/i;

function errorClassFor(message: string): VendorSignals["vendorErrorClass"] {
  if (AUTHENTICATION_PATTERN.test(message)) return "authentication";
  if (RATE_LIMIT_PATTERN.test(message)) return "rate-limit";
  if (OVERLOAD_PATTERN.test(message)) return "provider-overload";
  return null;
}

/**
 * Translates one framed Codex `--json` value into normalized events. Always returns a
 * null `candidateReportText`: the schema-constrained final message lives only in the
 * `--output-last-message` file, never in this stream, so `createCodexAdapter`'s
 * `collect` override is the only place a Codex candidate report is ever set.
 */
export function codexToEvents(value: unknown, timestamp: string): VendorStreamOutput {
  if (!isCodexEvent(value)) return { events: [], candidateReportText: null };

  switch (value.type) {
    case "item.completed": {
      const item = (value as CodexItemEvent).item;
      if (!item) return { events: [], candidateReportText: null };
      if (item.type === "agent_message") {
        return { events: [{ type: "output", text: item.text ?? "", timestamp }], candidateReportText: null };
      }
      if (item.status === "failed") {
        const detail = item.error ?? item.aggregated_output ?? item.command ?? item.id ?? "tool failure";
        if (SANDBOX_DENIAL_PATTERN.test(detail)) {
          return { events: [{ type: "permission-denial", detail, timestamp }], candidateReportText: null };
        }
        return { events: [{ type: "diagnostic", text: `tool failure: ${detail}`, timestamp }], candidateReportText: null };
      }
      return { events: [], candidateReportText: null };
    }
    case "error": {
      const message = (value as CodexErrorEvent).message ?? "codex error";
      return { events: [{ type: "diagnostic", text: message, timestamp }], candidateReportText: null };
    }
    case "turn.failed": {
      const message = (value as CodexTurnFailedEvent).error?.message ?? "turn failed";
      return { events: [{ type: "diagnostic", text: message, timestamp }], candidateReportText: null };
    }
    default:
      return { events: [], candidateReportText: null };
  }
}

/**
 * Reads only parsed fields of Codex's `--json` event stream (goals spec section 14):
 * a sandbox or approval failure item becomes a `permissionDenials` entry, a tool error
 * inside an otherwise successful process becomes a `toolFailures` entry, an
 * authentication, rate-limit, or overload error sets `vendorErrorClass`, and any event
 * whose `type` this adapter does not model above is recorded in `unknownEventTypes` and
 * otherwise ignored for control flow. No field here is derived from a substring search
 * of assistant text, prompt echo, or raw stdout — every value inspected below is a
 * parsed JSON field the framer already produced.
 */
export function codexExtractSignals(input: VendorSignalInput): VendorSignals {
  const permissionDenials: string[] = [];
  const toolFailures: string[] = [];
  const unknownEventTypes: string[] = [];
  let vendorErrorClass: VendorSignals["vendorErrorClass"] = null;

  for (const value of input.values) {
    if (!isCodexEvent(value)) continue;
    if (!KNOWN_EVENT_TYPES.has(value.type)) {
      unknownEventTypes.push(value.type);
      continue;
    }

    if (value.type === "item.completed") {
      const item = (value as CodexItemEvent).item;
      if (item && item.status === "failed") {
        const detail = item.error ?? item.aggregated_output ?? item.command ?? item.id ?? "tool failure";
        if (SANDBOX_DENIAL_PATTERN.test(detail)) {
          permissionDenials.push(detail);
        } else {
          toolFailures.push(detail);
        }
      }
      continue;
    }

    if (value.type === "error") {
      const message = (value as CodexErrorEvent).message ?? "";
      const errorClass = errorClassFor(message);
      if (errorClass !== null) vendorErrorClass ??= errorClass;
      continue;
    }

    if (value.type === "turn.failed") {
      const message = (value as CodexTurnFailedEvent).error?.message ?? "";
      const errorClass = errorClassFor(message);
      if (errorClass !== null) vendorErrorClass ??= errorClass;
    }
  }

  return {
    permissionDenials,
    toolFailures,
    vendorErrorClass,
    unknownEventTypes,
    streamTruncated: input.streamTruncated,
    descendantsAlive: input.descendantsAlive,
  };
}

function readLastMessage(lastMessagePath: string): string | null {
  if (!existsSync(lastMessagePath)) return null;
  const text = readFileSync(lastMessagePath, "utf8").trim();
  return text.length > 0 ? text : null;
}

/**
 * Builds the Codex `ProcessAdapter`. Delegates to `createVendorAdapter` for `probe`,
 * `start`, `observe`, `cancel`, and `classify` — those five are the delegate's own
 * methods, unwrapped — and overrides only `collect`: it awaits the delegate's `collect`,
 * reads the attempt's `--output-last-message` file through `lastMessagePathFor`, and
 * returns the artifacts with `candidateReportText` replaced by the file's trimmed text
 * (or `null` when the file is absent, empty, or whitespace-only). `classify` still
 * resolves its runtime attempt by `artifacts.attemptId`, which this spread never
 * changes.
 */
export function createCodexAdapter(profile: ResolvedVendorProfile, options: VendorAdapterOptions): ProcessAdapter {
  const runIdByAttemptId = new Map<string, string>();
  const spec = createCodexVendorSpec(profile, (attempt) => {
    runIdByAttemptId.set(attempt.attemptId, attempt.runId);
  });
  const base = createVendorAdapter(spec, options);

  return {
    ...base,
    async collect(handle: ProcessHandle) {
      const artifacts = await base.collect(handle);
      const runId = runIdByAttemptId.get(handle.attemptId);
      const candidateReportText =
        runId === undefined ? null : readLastMessage(lastMessagePathFor({ runId, attemptId: handle.attemptId }));
      return { ...artifacts, candidateReportText };
    },
  };
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?/;

function parseCodexVersion(result: ProbeSpawnResult): string | null {
  const match = result.stdout.match(VERSION_PATTERN);
  return match ? match[0] : null;
}

/**
 * `codex login status` is a bounded real invocation of the CLI's own login-status
 * subcommand, never a read of `~/.codex/auth.json`: it exits `0` and reports the active
 * auth method when authenticated, and a non-zero exit or a login-prompt message
 * otherwise.
 */
function parseCodexAuthOutcome(result: ProbeSpawnResult): string {
  if (result.exitCode === 0) return "authenticated";
  if (/not logged in|log in|login required/i.test(`${result.stdout}\n${result.stderr}`)) return "unauthenticated";
  return "unknown";
}

/**
 * The real Codex `VendorProbeSpec`: `codex --version` for the version check, and
 * `codex login status` — a real, bounded subcommand invocation — for the authentication
 * probe, replacing `probe.ts`'s `PLACEHOLDER_AUTH_PROBE_ARGS`. No credential file is
 * read by either command; `probeVendor` invokes the CLI itself for both facts.
 */
export const CODEX_VENDOR_PROBE_SPEC: VendorProbeSpec = {
  vendor: "codex",
  defaultExecutable: "codex",
  adapterVersion: "1",
  structuredOutputMode: "jsonl",
  permissionAndSandboxConfiguration: "sandbox mode comes from the resolved vendor profile",
  workingDirectoryBehavior: "runs with cwd set to the attempt's assigned worktree",
  versionArgs: ["--version"],
  parseVersion: parseCodexVersion,
  authProbeArgs: ["login", "status"],
  authProbeTimeoutMs: 8000,
  parseAuthOutcome: parseCodexAuthOutcome,
};
