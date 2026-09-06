// The vendor-neutral readiness probe (goals spec section 13.1): resolves the requested
// executable, then actually executes it — `command -v` alone is not a probe — under a
// bounded timeout, in order: resolve path, run the version command, run the bounded
// authentication probe. `probeVendor` never rejects; every `CapabilityReport` fact it
// could not establish carries the sentinel "unknown", and a bounded authentication
// invocation that exceeds its timeout carries the sentinel "probe-timeout" instead,
// leaving every fact an earlier step already established untouched.
//
// Two deliberate deviations from the reference probe pattern this module's ordering is
// modeled on, stated here as design facts: the version check is blocking, not merely a
// warning, because a run must not dispatch work to a known-bad vendor version; and the
// authentication probe is a bounded real invocation of the vendor binary, never a check
// for the presence of a credential file, because credential stores must never be
// inspected. Every filesystem and process access this module makes goes through the
// injected `ProbeIo` seam below — this file imports no filesystem or process-spawning
// module at all, under any spelling; the concrete wiring to the real `fs`/`fs/promises`/
// `child_process` modules lives in the sibling `probe-io.ts` module instead, so the
// credential-non-access guarantee holds by construction (this file has nothing to
// import) rather than by convention.

import path from "node:path";

import type { CapabilityReport, ProbeConfiguration } from "./adapter.ts";
import knownBadData from "./known-bad.json" with { type: "json" };
import { processProbeIo } from "./probe-io.ts";

export type VendorId = "claude" | "codex";

const UNKNOWN = "unknown";
const PROBE_TIMEOUT_SENTINEL = "probe-timeout";
const VERSION_PROBE_TIMEOUT_MS = 5000;

export interface ProbeSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ProbeSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Every filesystem and process access `probeVendor` makes goes through this seam —
 * nothing beyond what the probe actually uses is declared here.
 */
export interface ProbeIo {
  exists(targetPath: string): Promise<boolean>;
  readFile(targetPath: string): Promise<string>;
  spawn(command: string, args: readonly string[], options: ProbeSpawnOptions): Promise<ProbeSpawnResult>;
}

export interface VendorProbeSpec {
  vendor: VendorId;
  /** The bare executable name resolved against `PATH` when no path override is given. */
  defaultExecutable: string;
  adapterVersion: string;
  structuredOutputMode: string;
  workingDirectoryBehavior: string;
  permissionAndSandboxConfiguration: string;
  versionArgs: readonly string[];
  parseVersion(result: ProbeSpawnResult): string | null;
  authProbeArgs: readonly string[];
  authProbeTimeoutMs: number;
  parseAuthOutcome(result: ProbeSpawnResult): string;
}

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?/;

function parseVersionFromStdout(result: ProbeSpawnResult): string | null {
  const match = result.stdout.match(VERSION_PATTERN);
  return match ? match[0] : null;
}

function parseAuthOutcomeFromExit(result: ProbeSpawnResult): string {
  if (result.exitCode === 0) return "authenticated";
  if (/auth|login|unauthorized|credential/i.test(`${result.stdout}\n${result.stderr}`)) return "unauthenticated";
  return UNKNOWN;
}

/**
 * A vendor-neutral placeholder auth-probe subcommand. No real vendor CLI is known to
 * implement it; it stands in only until the vendor that owns each `VendorProbeSpec`
 * (the Claude and Codex adapter work) supplies the real bounded-auth-check argument
 * array and outcome parser for its own binary. A registry entry still using this
 * placeholder will classify every real, authenticated install as unusable.
 */
const PLACEHOLDER_AUTH_PROBE_ARGS: readonly string[] = ["doctor-auth-probe"];

export const CLAUDE_PROBE_SPEC: VendorProbeSpec = {
  vendor: "claude",
  defaultExecutable: "claude",
  adapterVersion: "1",
  structuredOutputMode: "stream-json",
  permissionAndSandboxConfiguration: "permission mode and sandbox mode come from the resolved vendor profile",
  workingDirectoryBehavior: "runs with cwd set to the attempt's assigned worktree",
  versionArgs: ["--version"],
  parseVersion: parseVersionFromStdout,
  authProbeArgs: PLACEHOLDER_AUTH_PROBE_ARGS,
  authProbeTimeoutMs: 8000,
  parseAuthOutcome: parseAuthOutcomeFromExit,
};

export const CODEX_PROBE_SPEC: VendorProbeSpec = {
  vendor: "codex",
  defaultExecutable: "codex",
  adapterVersion: "1",
  structuredOutputMode: "jsonl",
  permissionAndSandboxConfiguration: "sandbox mode comes from the resolved vendor profile",
  workingDirectoryBehavior: "runs with cwd set to the attempt's assigned worktree",
  versionArgs: ["--version"],
  parseVersion: parseVersionFromStdout,
  authProbeArgs: PLACEHOLDER_AUTH_PROBE_ARGS,
  authProbeTimeoutMs: 8000,
  parseAuthOutcome: parseAuthOutcomeFromExit,
};

/**
 * The shape `doctor.ts` probes against: one `VendorProbeSpec` per known vendor. Each
 * vendor's real spec belongs in that vendor's own adapter file, not here — this module
 * owns only the vendor-neutral probe engine, the known-bad list, and this registry
 * shape. `doctor.ts` takes a registry as an injectable, defaulted parameter (mirroring
 * the `Io`/`processIo` injection pattern used for CLI I/O elsewhere in this codebase),
 * so a caller can supply a registry whose entries carry each vendor's real
 * `authProbeArgs`/`parseAuthOutcome` (and any other spec-owning field) without editing
 * this file. `DEFAULT_PROBE_REGISTRY` below is only a placeholder default: both of its
 * entries use `PLACEHOLDER_AUTH_PROBE_ARGS`, which is not a real subcommand on either
 * vendor CLI.
 */
export type VendorProbeRegistry = Readonly<Record<VendorId, VendorProbeSpec>>;

export const DEFAULT_PROBE_REGISTRY: VendorProbeRegistry = {
  claude: CLAUDE_PROBE_SPEC,
  codex: CODEX_PROBE_SPEC,
};

interface KnownBadEntry {
  version: string;
  reason: string;
}

const KNOWN_BAD: Readonly<Record<string, readonly KnownBadEntry[]>> = knownBadData as Record<
  string,
  readonly KnownBadEntry[]
>;

function findKnownBadEntry(vendor: VendorId, version: string): KnownBadEntry | null {
  const entries = KNOWN_BAD[vendor] ?? [];
  const base = version.split(/[-+]/)[0] ?? version;
  for (const entry of entries) {
    if (entry.version === base) return entry;
  }
  return null;
}

/**
 * Whole-version-token matching only: "0.120.2" and "0.120.2-beta" match a "0.120.2"
 * entry; "0.120.20" does not, since its base token differs from the listed one.
 */
export function isKnownBadVersion(vendor: VendorId, version: string): boolean {
  return findKnownBadEntry(vendor, version) !== null;
}

/** The reason string recorded against a known-bad version, or null when it isn't one. */
export function knownBadReason(vendor: VendorId, version: string): string | null {
  return findKnownBadEntry(vendor, version)?.reason ?? null;
}

/**
 * The two-check readiness verdict a caller needs before dispatching to a vendor: not on
 * the known-bad version list, and authenticated. Does not check `executablePath` — a
 * missing binary is `doctor.ts`'s own `binary-missing` branch, evaluated before this.
 */
export function isProbeReady(vendor: VendorId, report: CapabilityReport): boolean {
  return !isKnownBadVersion(vendor, report.cliVersion) && report.authenticationOutcome === "authenticated";
}

async function resolveExecutablePath(
  configuration: ProbeConfiguration,
  io: ProbeIo,
): Promise<string | null> {
  const requested = configuration.executablePath;
  const candidates: string[] = [];
  if (requested.includes("/") || requested.includes("\\")) {
    candidates.push(requested);
  } else {
    const pathVar = configuration.environment.PATH ?? "";
    for (const dir of pathVar.split(path.delimiter)) {
      if (dir === "") continue;
      candidates.push(path.join(dir, requested));
    }
  }
  for (const candidate of candidates) {
    if (await io.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Runs the readiness probe against `spec` and returns the nine-field `CapabilityReport`.
 * Never rejects: every fact the probe could not establish carries the "unknown"
 * sentinel, and a bounded authentication probe that exceeds its timeout carries the
 * "probe-timeout" sentinel while leaving every already-established fact untouched.
 */
export async function probeVendor(
  spec: VendorProbeSpec,
  configuration: ProbeConfiguration,
  io: ProbeIo = processProbeIo,
): Promise<CapabilityReport> {
  const base: CapabilityReport = {
    executablePath: UNKNOWN,
    cliVersion: UNKNOWN,
    requestedModel: configuration.requestedModel,
    requestedEffort: configuration.requestedEffort,
    structuredOutputMode: spec.structuredOutputMode,
    authenticationOutcome: UNKNOWN,
    workingDirectoryBehavior: spec.workingDirectoryBehavior,
    permissionAndSandboxConfiguration: spec.permissionAndSandboxConfiguration,
    adapterVersion: spec.adapterVersion,
  };

  const resolvedPath = await resolveExecutablePath(configuration, io);
  if (resolvedPath === null) {
    return base;
  }

  const versionResult = await io.spawn(resolvedPath, spec.versionArgs, {
    cwd: configuration.workingDirectory,
    env: configuration.environment,
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  const withPath: CapabilityReport = { ...base, executablePath: resolvedPath };
  if (versionResult.timedOut) {
    return withPath;
  }
  const cliVersion = spec.parseVersion(versionResult) ?? UNKNOWN;
  const withVersion: CapabilityReport = { ...withPath, cliVersion };

  // The known-bad list is consulted by callers that decide usability (e.g. `orga
  // doctor`); it never gates whether the authentication probe below still runs, so the
  // report always reflects the real authentication outcome regardless of version.

  const authResult = await io.spawn(resolvedPath, spec.authProbeArgs, {
    cwd: configuration.workingDirectory,
    env: configuration.environment,
    timeoutMs: spec.authProbeTimeoutMs,
  });
  if (authResult.timedOut) {
    return { ...withVersion, authenticationOutcome: PROBE_TIMEOUT_SENTINEL };
  }
  return { ...withVersion, authenticationOutcome: spec.parseAuthOutcome(authResult) };
}
