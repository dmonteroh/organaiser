// The sanitized capture format goals spec section 29.5 requires: one directory per
// vendor and CLI version, one file per required case, redacted before it ever reaches
// the repository. This module defines the format and its loader; it records no capture
// itself.

/** The ten goals spec section 29.5 case names, in the spec's own order. */
export const CAPTURE_CASES = [
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
] as const;

export type CaptureCase = (typeof CAPTURE_CASES)[number];

/** The first line of every capture file: what produced the stream and when. */
export interface CaptureMetadata {
  vendor: string;
  cliVersion: string;
  /** The argument array actually used, with every path replaced by a placeholder. */
  commandShape: readonly string[];
  captureDate: string;
  case: CaptureCase;
}

export interface Capture {
  metadata: CaptureMetadata;
  /** The sanitized vendor stream, one raw line per array entry, in stream order. */
  lines: readonly string[];
}

const REQUIRED_METADATA_FIELDS: readonly (keyof CaptureMetadata)[] = [
  "vendor",
  "cliVersion",
  "commandShape",
  "captureDate",
  "case",
];

function isCaptureCase(value: unknown): value is CaptureCase {
  return typeof value === "string" && (CAPTURE_CASES as readonly string[]).includes(value);
}

/**
 * Parses and validates a capture file's raw text. Refuses a capture whose metadata is
 * missing a required field or whose `case` is not one of `CAPTURE_CASES`.
 */
export function loadCapture(raw: string): Capture {
  const lines = raw.split("\n");
  const metadataLine = lines[0] ?? "";
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(metadataLine);
  } catch (error) {
    throw new Error(`capture metadata line is not valid JSON: ${(error as Error).message}`);
  }
  if (!metadataValue || typeof metadataValue !== "object" || Array.isArray(metadataValue)) {
    throw new Error("capture metadata line must be a JSON object");
  }
  const metadata = metadataValue as Record<string, unknown>;
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!(field in metadata)) {
      throw new Error(`capture metadata is missing required field: ${field}`);
    }
  }
  if (!isCaptureCase(metadata.case)) {
    throw new Error(`capture metadata names an unknown case: ${String(metadata.case)}`);
  }

  const streamLines = lines.slice(1).filter((line) => line.trim() !== "");

  return {
    metadata: metadata as unknown as CaptureMetadata,
    lines: streamLines,
  };
}

/** Environment variable names whose values are redacted wherever they appear in a line. */
const REDACTED_ENV_VAR_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_ORGANIZATION",
];

const TOKEN_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  /ghp_[A-Za-z0-9]+/g,
];

function redactEnvValues(line: string, environment: NodeJS.ProcessEnv): string {
  let redacted = line;
  for (const name of REDACTED_ENV_VAR_NAMES) {
    const value = environment[name];
    if (value && value.length > 0) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }
  return redacted;
}

function redactHomePaths(line: string, homeDirectory: string): string {
  if (!homeDirectory) return line;
  return line.split(homeDirectory).join("~");
}

function redactTokens(line: string): string {
  let redacted = line;
  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

/**
 * Redacts one raw vendor stream line before it is written to a capture file: absolute
 * home paths, the values of `environment`'s allowlisted names, and any `sk-`, `Bearer `,
 * or `ghp_` token. Order matters: home-path and env-value redaction run first so a token
 * pattern does not partially match text a coarser rule would have removed whole.
 */
export function sanitizeCaptureLine(
  line: string,
  options: { homeDirectory: string; environment: NodeJS.ProcessEnv },
): string {
  let sanitized = redactHomePaths(line, options.homeDirectory);
  sanitized = redactEnvValues(sanitized, options.environment);
  sanitized = redactTokens(sanitized);
  return sanitized;
}
