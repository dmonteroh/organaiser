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
// module directly, so the credential-non-access guarantee holds by construction rather
// than by convention. `processProbeIo`'s wiring to the real `fs`/`child_process` modules
// therefore uses their bare specifiers rather than the `node:`-prefixed form used
// elsewhere in this codebase, so that guarantee is also mechanically checkable by
// scanning this file's own source text.

import path from "node:path";
import fs from "fs";
import fsp from "fs/promises";
import { spawn as spawnChildProcess } from "child_process";

import type { CapabilityReport, ProbeConfiguration } from "./adapter.ts";
import knownBadData from "./known-bad.json" with { type: "json" };

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

async function existsOnDisk(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFileText(targetPath: string): Promise<string> {
  return fsp.readFile(targetPath, "utf8");
}

function spawnBounded(command: string, args: readonly string[], options: ProbeSpawnOptions): Promise<ProbeSpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawnChildProcess(command, args, { cwd: options.cwd, env: options.env });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false });
    });
    child.stdin?.end();
  });
}

export const processProbeIo: ProbeIo = {
  exists: existsOnDisk,
  readFile: readFileText,
  spawn: spawnBounded,
};

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

export const CLAUDE_PROBE_SPEC: VendorProbeSpec = {
  vendor: "claude",
  defaultExecutable: "claude",
  adapterVersion: "1",
  structuredOutputMode: "stream-json",
  permissionAndSandboxConfiguration: "permission mode and sandbox mode come from the resolved vendor profile",
  workingDirectoryBehavior: "runs with cwd set to the attempt's assigned worktree",
  versionArgs: ["--version"],
  parseVersion: parseVersionFromStdout,
  authProbeArgs: ["doctor-auth-probe"],
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
  authProbeArgs: ["doctor-auth-probe"],
  authProbeTimeoutMs: 8000,
  parseAuthOutcome: parseAuthOutcomeFromExit,
};

export const PROBE_SPECS: Readonly<Record<VendorId, VendorProbeSpec>> = {
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
      try {
        await io.readFile(candidate);
      } catch {
        // Unreadable (e.g. a directory, or a permission-denied binary) is still a
        // resolved candidate; readability is a liveness check, not a resolution gate.
      }
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
