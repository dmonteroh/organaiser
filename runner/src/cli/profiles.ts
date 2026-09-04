// The resolved vendor-profile model (goals spec section 24): a five-layer precedence —
// command-line flags, `ORGA_`-prefixed environment variables, the project `orga.yaml`,
// the user configuration file, built-in defaults — collapsed into one
// `ResolvedVendorProfile` per (vendor, capability class) pair, so every vendor adapter
// reads configuration through the same shape instead of inventing its own.
//
// Design note: tool-policy and environment-allowlist arrays are configured only through
// project/user profile files and the built-in defaults. Command-line flags and
// environment variables carry scalar overrides only — an array-valued override has no
// natural single-string encoding in this dialect, so this module does not invent one.

import type { TimeoutBudget } from "../adapters/adapter.ts";
import { positiveInt, stringVal, type Layer, type Read } from "./config.ts";
import { parseYamlText, formatDialectError, type YamlMapping, type YamlValue } from "./yaml.ts";

export type VendorId = "claude" | "codex";
const VENDOR_IDS: readonly VendorId[] = ["claude", "codex"];
const DEFAULT_CAPABILITY_CLASS = "default";
const ENV_PREFIX = "ORGA_";

export interface ToolPolicy {
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
}

/** Exactly the ten declarations goals spec section 24 requires of a vendor profile. */
export interface ResolvedVendorProfile {
  executable: string;
  model: string;
  effort: string;
  permissionMode: string;
  sandboxMode: string;
  toolPolicy: ToolPolicy;
  environmentAllowlist: readonly string[];
  timeouts: TimeoutBudget;
  budgetUsd: number | null;
  maxConcurrentProcesses: number;
}

export interface FileSource {
  path: string;
  text: string;
}

export interface VendorProfileSources {
  vendor: VendorId;
  flags?: Layer;
  env?: Layer;
  project?: FileSource;
  user?: FileSource;
}

function defaultsFor(vendor: VendorId): ResolvedVendorProfile {
  const shared = {
    permissionMode: "default",
    sandboxMode: "workspace-write",
    toolPolicy: { allowedTools: [] as readonly string[], disallowedTools: [] as readonly string[] },
    environmentAllowlist: [] as readonly string[],
    timeouts: { spawnMs: 30_000, idleMs: 120_000, wallMs: 1_800_000 } satisfies TimeoutBudget,
    budgetUsd: null as number | null,
    maxConcurrentProcesses: 2,
  };
  if (vendor === "claude") {
    return { executable: "claude", model: "sonnet", effort: "medium", ...shared };
  }
  return { executable: "codex", model: "gpt-5-codex", effort: "medium", ...shared };
}

const BUILT_IN_DEFAULTS: Readonly<Record<VendorId, ResolvedVendorProfile>> = {
  claude: defaultsFor("claude"),
  codex: defaultsFor("codex"),
};

function asMapping(value: YamlValue | undefined): YamlMapping {
  if (value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function scalarToString(value: YamlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function arrayOfStrings(value: YamlValue | undefined): readonly string[] | undefined {
  if (value === undefined || !Array.isArray(value)) return undefined;
  return value.map((item) => (typeof item === "string" ? item : String(item)));
}

// Locates the 1-based source line of an immediate child key under a top-level
// "vendors:" block, for error messages only; parsing itself never needs line numbers
// once it has already succeeded.
function locateVendorLine(text: string, vendorName: string): number | string {
  const lines = text.split("\n");
  let inVendors = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const match = line.match(/^( *)(\S.*)$/);
    if (!match) continue;
    const indent = match[1]!.length;
    const content = match[2]!;
    if (indent === 0) {
      inVendors = content === "vendors:";
      continue;
    }
    if (inVendors && indent === 2) {
      const keyMatch = content.match(/^([^:]+):$/);
      if (keyMatch && keyMatch[1] === vendorName) return i + 1;
    }
  }
  return "?";
}

function validateVendorsBlock(root: YamlMapping, source: FileSource): void {
  if (!("vendors" in root)) return;
  const vendors = asMapping(root.vendors);
  for (const name of Object.keys(vendors)) {
    if (!(VENDOR_IDS as readonly string[]).includes(name)) {
      const line = locateVendorLine(source.text, name);
      throw formatDialectError(source.path, line, `unknown vendor "${name}" in vendors: block`);
    }
  }
}

function capabilityBlock(root: YamlMapping, vendor: VendorId, capabilityClass: string): YamlMapping {
  const vendors = asMapping(root.vendors);
  const vendorBlock = asMapping(vendors[vendor]);
  if (capabilityClass in vendorBlock) return asMapping(vendorBlock[capabilityClass]);
  return asMapping(vendorBlock[DEFAULT_CAPABILITY_CLASS]);
}

function flattenScalars(block: YamlMapping): Layer {
  const layer: Layer = {};
  for (const [key, value] of Object.entries(block)) {
    const asString = scalarToString(value);
    if (asString !== undefined) layer[key] = asString;
  }
  return layer;
}

// Field names are camelCase everywhere a profile field is read from (flags, project
// and user YAML blocks) except the environment layer, whose variable names follow this
// codebase's SCREAMING_SNAKE convention (`config.ts`'s own layers): "spawnMs" reads
// project/user/flags under "spawnMs" but the environment under "ORGA_SPAWN_MS".
function envSuffixFor(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => `_${ch}`).toUpperCase();
}

function makeRead(flags: Layer, env: Layer, project: Layer, user: Layer): Read {
  return (name: string): string | undefined => {
    const envKey = `${ENV_PREFIX}${envSuffixFor(name)}`;
    for (const raw of [flags[name], env[envKey], project[name], user[name]]) {
      if (raw !== undefined && raw !== "") return raw;
    }
    return undefined;
  };
}

function firstDefined<T>(candidates: readonly (T | undefined)[], fallback: T): T {
  for (const candidate of candidates) {
    if (candidate !== undefined) return candidate;
  }
  return fallback;
}

function numberOrNullVal(read: Read, name: string, fallback: number | null): number | null {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid ${name}: ${raw} (must be a non-negative number)`);
  }
  return n;
}

/**
 * Resolves the profile for one (vendor, capability class) pair through the five-layer
 * precedence. `sources.vendor` names which vendor's built-in defaults and `vendors:`
 * sub-block apply; an unknown capability class silently falls back to the `default`
 * class at each layer, and a `vendors:` block naming an unknown vendor is a
 * configuration error naming the file and line, never a silent default.
 */
export function resolveVendorProfile(capabilityClass: string, sources: VendorProfileSources): ResolvedVendorProfile {
  const { vendor, flags = {}, env = {} } = sources;
  const defaults = BUILT_IN_DEFAULTS[vendor];

  const projectRoot = sources.project ? parseYamlText(sources.project.text, sources.project.path) : {};
  const userRoot = sources.user ? parseYamlText(sources.user.text, sources.user.path) : {};
  if (sources.project) validateVendorsBlock(projectRoot, sources.project);
  if (sources.user) validateVendorsBlock(userRoot, sources.user);

  const projectBlock = capabilityBlock(projectRoot, vendor, capabilityClass);
  const userBlock = capabilityBlock(userRoot, vendor, capabilityClass);
  const projectLayer = flattenScalars(projectBlock);
  const userLayer = flattenScalars(userBlock);
  const read = makeRead(flags, env, projectLayer, userLayer);

  const errors: string[] = [];
  function attempt<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return fallback;
    }
  }

  const executable = attempt(() => stringVal(read, "executable", defaults.executable)!, defaults.executable);
  const model = attempt(() => stringVal(read, "model", defaults.model)!, defaults.model);
  const effort = attempt(() => stringVal(read, "effort", defaults.effort)!, defaults.effort);
  const permissionMode = attempt(
    () => stringVal(read, "permissionMode", defaults.permissionMode)!,
    defaults.permissionMode,
  );
  const sandboxMode = attempt(() => stringVal(read, "sandboxMode", defaults.sandboxMode)!, defaults.sandboxMode);
  const spawnMs = attempt(() => positiveInt(read, "spawnMs", defaults.timeouts.spawnMs), defaults.timeouts.spawnMs);
  const idleMs = attempt(() => positiveInt(read, "idleMs", defaults.timeouts.idleMs), defaults.timeouts.idleMs);
  const wallMs = attempt(() => positiveInt(read, "wallMs", defaults.timeouts.wallMs), defaults.timeouts.wallMs);
  const budgetUsd = attempt(() => numberOrNullVal(read, "budgetUsd", defaults.budgetUsd), defaults.budgetUsd);
  const maxConcurrentProcesses = attempt(
    () => positiveInt(read, "maxConcurrentProcesses", defaults.maxConcurrentProcesses),
    defaults.maxConcurrentProcesses,
  );

  const allowedTools = firstDefined(
    [arrayOfStrings(projectBlock.allowedTools), arrayOfStrings(userBlock.allowedTools)],
    defaults.toolPolicy.allowedTools,
  );
  const disallowedTools = firstDefined(
    [arrayOfStrings(projectBlock.disallowedTools), arrayOfStrings(userBlock.disallowedTools)],
    defaults.toolPolicy.disallowedTools,
  );
  const environmentAllowlist = firstDefined(
    [arrayOfStrings(projectBlock.environmentAllowlist), arrayOfStrings(userBlock.environmentAllowlist)],
    defaults.environmentAllowlist,
  );

  if (errors.length > 0) {
    throw new Error(`invalid vendor profile (${vendor}/${capabilityClass}):\n  - ${errors.join("\n  - ")}`);
  }

  return {
    executable,
    model,
    effort,
    permissionMode,
    sandboxMode,
    toolPolicy: { allowedTools, disallowedTools },
    environmentAllowlist,
    timeouts: { spawnMs, idleMs, wallMs },
    budgetUsd,
    maxConcurrentProcesses,
  };
}

/**
 * Deterministic JSON suitable for `attempts.config_json`: keys in a fixed declared
 * order, no host paths outside `executable`, and no environment *values* — only the
 * allowlisted variable names.
 */
export function serializeResolvedProfile(profile: ResolvedVendorProfile): string {
  const ordered = {
    executable: profile.executable,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
    sandboxMode: profile.sandboxMode,
    toolPolicy: {
      allowedTools: [...profile.toolPolicy.allowedTools],
      disallowedTools: [...profile.toolPolicy.disallowedTools],
    },
    environmentAllowlist: [...profile.environmentAllowlist],
    timeouts: {
      spawnMs: profile.timeouts.spawnMs,
      idleMs: profile.timeouts.idleMs,
      wallMs: profile.timeouts.wallMs,
    },
    budgetUsd: profile.budgetUsd,
    maxConcurrentProcesses: profile.maxConcurrentProcesses,
  };
  return JSON.stringify(ordered);
}
