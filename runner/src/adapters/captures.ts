// The sanitized capture format goals spec section 29.5 requires: one directory per
// vendor and CLI version, one file per required case, redacted before it ever reaches
// the repository. This module defines the format and its loader; it records no capture
// itself.

import { DEFAULT_SECRET_ENV_NAMES, DEFAULT_TOKEN_PATTERNS, createRedactor } from "../store/redact.ts";

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

/**
 * Redacts one raw vendor stream line before it is written to a capture file: absolute
 * home paths, the values of the built-in allowlisted environment variable names, and
 * any built-in `sk-`, `Bearer `, or `ghp_` token, via the shared `store/redact.ts`
 * primitives and their built-in pattern set.
 */
export function sanitizeCaptureLine(
  line: string,
  options: { homeDirectory: string; environment: NodeJS.ProcessEnv },
): string {
  return createRedactor({
    secretPatterns: DEFAULT_TOKEN_PATTERNS,
    environmentVariableNames: DEFAULT_SECRET_ENV_NAMES,
    homeDirectory: options.homeDirectory,
    environment: options.environment,
  })(line);
}
