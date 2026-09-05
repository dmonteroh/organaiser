// The Claude Code vendor adapter: the argument array `claude` is spawned with, how its
// `stream-json` events and final `result` envelope become normalized events and vendor
// signals, and the readiness probe's Claude-specific version/auth commands. Everything
// vendor-neutral — process spawning, stdout framing, classification — lives in the
// shared substrate (`vendor-adapter.ts`, `jsonl.ts`, `classify.ts`); this module supplies only the
// four `VendorAdapterSpec` members and the `VendorProbeSpec` that close over them.

import type { NormalizedEvent } from "./adapter.ts";
import type { VendorSignals } from "./classify.ts";
import { extractClaudeResultMeta, type ClaudeResultMeta } from "./claude.ts";
import type { VendorProbeSpec, ProbeSpawnResult } from "./probe.ts";
import type {
  VendorAdapterSpec,
  VendorCommand,
  VendorCommandContext,
  VendorSignalInput,
  VendorStreamOutput,
} from "./vendor-adapter.ts";
import type { ExecutionSurface } from "./adapter.ts";
import type { ResolvedVendorProfile } from "../cli/profiles.ts";

/**
 * Builds the argument array `claude` is spawned with. The packet travels on `input`
 * (stdin), never in `args`. `env` carries exactly the `profile.environmentAllowlist`
 * names that are present in `surface.environment` — nothing inherited wholesale, and no
 * Claude-specific variable hardcoded here.
 */
export function buildClaudeAttemptCommand(
  profile: ResolvedVendorProfile,
  packet: string,
  surface: ExecutionSurface,
  schemaText: string,
): VendorCommand {
  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schemaText,
    "--model",
    profile.model,
    "--effort",
    profile.effort,
    "--permission-mode",
    profile.permissionMode,
  ];

  if (profile.toolPolicy.allowedTools.length > 0) {
    args.push("--allowedTools", ...profile.toolPolicy.allowedTools);
  }
  if (profile.toolPolicy.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...profile.toolPolicy.disallowedTools);
  }
  if (profile.budgetUsd !== null) {
    args.push("--max-budget-usd", String(profile.budgetUsd));
  }

  const env: NodeJS.ProcessEnv = {};
  for (const name of profile.environmentAllowlist) {
    const value = surface.environment[name];
    if (value !== undefined) env[name] = value;
  }

  return {
    command: profile.executable,
    args,
    input: packet,
    cwd: surface.workingDirectory,
    env,
  };
}

function extractAssistantTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") texts.push(text);
    }
  }
  return texts;
}

function extractToolFailureTexts(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_result" && entry.is_error === true) {
      const toolUseId = typeof entry.tool_use_id === "string" ? entry.tool_use_id : "unknown-id";
      const detail = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content);
      texts.push(`${toolUseId}: ${detail}`);
    }
  }
  return texts;
}

function permissionDenialLabels(resultEvent: Record<string, unknown> | null): string[] {
  if (!resultEvent) return [];
  const denials = resultEvent.permission_denials;
  if (!Array.isArray(denials)) return [];
  return denials.map((entry) => {
    if (!entry || typeof entry !== "object") return "unknown-tool:unknown-id";
    const record = entry as Record<string, unknown>;
    const toolName = typeof record.tool_name === "string" ? record.tool_name : "unknown-tool";
    const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : "unknown-id";
    return `${toolName}:${toolUseId}`;
  });
}

/**
 * Translates one framed `stream-json` value into normalized events plus, on the
 * terminal `result` value, the candidate report text. `--json-schema` forces a
 * successful run's `result` event to carry `structured_output`; that field, not the
 * free-text `result` string, is the candidate report.
 */
export function toEvents(value: unknown, timestamp: string): VendorStreamOutput {
  if (!value || typeof value !== "object") return { events: [], candidateReportText: null };
  const record = value as Record<string, unknown>;

  if (record.type === "assistant") {
    const message = record.message as { content?: unknown } | undefined;
    const events: NormalizedEvent[] = extractAssistantTexts(message?.content).map((text) => ({
      type: "output",
      text,
      timestamp,
    }));
    return { events, candidateReportText: null };
  }

  if (record.type === "system" && record.subtype === "permission_denied") {
    const toolName = typeof record.tool_name === "string" ? record.tool_name : "unknown-tool";
    const detail = typeof record.message === "string" ? record.message : toolName;
    return { events: [{ type: "permission-denial", detail, timestamp }], candidateReportText: null };
  }

  if (record.type === "user") {
    const message = record.message as { content?: unknown } | undefined;
    const events: NormalizedEvent[] = extractToolFailureTexts(message?.content).map((text) => ({
      type: "diagnostic",
      text,
      timestamp,
    }));
    return { events, candidateReportText: null };
  }

  if (record.type === "result") {
    const events: NormalizedEvent[] = permissionDenialLabels(record).map((detail) => ({
      type: "permission-denial",
      detail,
      timestamp,
    }));
    const candidateReportText = "structured_output" in record ? JSON.stringify(record.structured_output) : null;
    return { events, candidateReportText };
  }

  return { events: [], candidateReportText: null };
}

// Every top-level `type` this adapter models. Anything else is recorded in
// `unknownEventTypes` and otherwise ignored for control flow.
const KNOWN_EVENT_TYPES = new Set(["system", "assistant", "user", "result", "rate_limit_event"]);

function findResultEvent(values: readonly unknown[]): Record<string, unknown> | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value && typeof value === "object" && (value as { type?: unknown }).type === "result") {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function toolFailureLabels(values: readonly unknown[]): string[] {
  const labels: string[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.type !== "user") continue;
    const message = record.message as { content?: unknown } | undefined;
    labels.push(...extractToolFailureTexts(message?.content));
  }
  return labels;
}

function unknownEventTypeLabels(values: readonly unknown[]): string[] {
  const labels: string[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && !KNOWN_EVENT_TYPES.has(type)) labels.push(type);
  }
  return labels;
}

function vendorErrorClassFromResult(
  resultEvent: Record<string, unknown> | null,
): "authentication" | "rate-limit" | "provider-overload" | null {
  if (!resultEvent || resultEvent.is_error !== true) return null;
  const status = resultEvent.api_error_status;
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (status === 500 || status === 502 || status === 503 || status === 529) return "provider-overload";
  return null;
}

/**
 * `extractSignals`'s Claude-specific return shape. `costMeta` carries
 * `extractClaudeResultMeta`'s reading of the same stdout — attached for observability
 * only. `classifyAttempt` (`classify.ts`) reads only the five `VendorSignals` fields it
 * declares; nothing in this module ever routes `costMeta` into `AttemptOutcome`.
 */
export interface ClaudeVendorSignals extends VendorSignals {
  costMeta: ClaudeResultMeta | null;
}

/**
 * Reads only parsed `stream-json` event fields and the final `result` envelope — never
 * a substring of assistant text, prompt echo, or stdout. `permission_denials` on the
 * final envelope always populates `permissionDenials`, regardless of exit code, so a
 * process that exits zero with an embedded denial still classifies `permission-denied`:
 * exit code zero must never override a permission denial. `streamTruncated` is set
 * whenever no `result` event was ever framed; the substrate ORs this with its own
 * truncation measurement rather than replacing it.
 */
export function extractSignals(input: VendorSignalInput): ClaudeVendorSignals {
  const resultEvent = findResultEvent(input.values);
  return {
    permissionDenials: permissionDenialLabels(resultEvent),
    toolFailures: toolFailureLabels(input.values),
    vendorErrorClass: vendorErrorClassFromResult(resultEvent),
    unknownEventTypes: unknownEventTypeLabels(input.values),
    streamTruncated: resultEvent === null,
    descendantsAlive: input.descendantsAlive,
    costMeta: extractClaudeResultMeta(input.artifacts.stdout),
  };
}

/** Assembles the four-member `VendorAdapterSpec` this module implements, closed over one resolved profile. */
export function createClaudeVendorAdapterSpec(profile: ResolvedVendorProfile): VendorAdapterSpec {
  return {
    vendor: "claude",
    buildCommand: (context: VendorCommandContext): VendorCommand => {
      if (context.schemaText === undefined) {
        throw new Error("createClaudeVendorAdapterSpec: context.schemaText is required but was undefined");
      }
      return buildClaudeAttemptCommand(profile, context.packet, context.surface, context.schemaText);
    },
    toEvents,
    extractSignals,
  };
}

function parseClaudeVersion(result: ProbeSpawnResult): string | null {
  const match = result.stdout.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?/);
  return match ? match[0] : null;
}

/**
 * `claude auth status --json` is a bounded, real, credential-store-free invocation: it
 * reports whether the CLI's own session is signed in without spending a model turn or
 * reading a credential file itself — the CLI does that internally, so this probe never
 * has to parse or touch a credential file on its own.
 */
function parseClaudeAuthOutcome(result: ProbeSpawnResult): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return "unknown";
  }
  if (!parsed || typeof parsed !== "object") return "unknown";
  const loggedIn = (parsed as { loggedIn?: unknown }).loggedIn;
  if (loggedIn === true) return "authenticated";
  if (loggedIn === false) return "unauthenticated";
  return "unknown";
}

/** The Claude `VendorProbeSpec`, verified in this module's test file via a direct `probeVendor` call. */
export const claudeProbeSpec: VendorProbeSpec = {
  vendor: "claude",
  defaultExecutable: "claude",
  adapterVersion: "1",
  structuredOutputMode: "stream-json",
  workingDirectoryBehavior: "runs with cwd set to the attempt's assigned worktree",
  permissionAndSandboxConfiguration: "permission mode comes from the resolved vendor profile's permissionMode",
  versionArgs: ["--version"],
  parseVersion: parseClaudeVersion,
  authProbeArgs: ["auth", "status", "--json"],
  authProbeTimeoutMs: 8000,
  parseAuthOutcome: parseClaudeAuthOutcome,
};
