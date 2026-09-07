// The shared redaction primitives (goals spec sections 26 and 28): the built-in
// pattern set, the project-configurable overlay read from `orga.yaml`'s top-level
// `redaction:` block, and the pure text transform every write boundary under
// `.orga/runs/<runId>/` applies before a value reaches disk.
//
// Array-valued configuration is read from the project's own YAML file and the
// built-in defaults only, matching `cli/profiles.ts`'s own design note: no
// delimiter-separated environment encoding, no command-line flag.

import fs from "node:fs";
import path from "node:path";

import { parseYamlText, type YamlMapping, type YamlValue } from "../cli/yaml.ts";

export const DEFAULT_SECRET_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "OPENAI_ORGANIZATION",
];

export const DEFAULT_TOKEN_PATTERNS: readonly string[] = [
  "(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{10,}",
  "Bearer\\s+[A-Za-z0-9._-]+",
  "ghp_[A-Za-z0-9]+",
];

export interface RedactionConfig {
  secretPatterns: readonly string[];
  environmentVariableNames: readonly string[];
  homeDirectory: string;
  environment: NodeJS.ProcessEnv;
}

function redactHomePaths(text: string, homeDirectory: string): string {
  if (!homeDirectory) return text;
  return text.split(homeDirectory).join("~");
}

function redactEnvValues(text: string, names: readonly string[], environment: NodeJS.ProcessEnv): string {
  let redacted = text;
  for (const name of names) {
    const value = environment[name];
    if (value && value.length > 0) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }
  return redacted;
}

// Every pattern gets a freshly constructed `RegExp` on each call: a shared
// global-flagged `RegExp` carries `lastIndex` across `.replace` calls, which
// would corrupt a memoized redactor applied more than once.
function redactTokens(text: string, patterns: readonly string[]): string {
  let redacted = text;
  for (const pattern of patterns) {
    redacted = redacted.replace(new RegExp(pattern, "g"), "[REDACTED]");
  }
  return redacted;
}

/**
 * Builds a pure text transform from an already-resolved config: home-path
 * redaction, then environment-value redaction, then token-pattern redaction, in
 * that order, so a token pattern never partially matches text a coarser rule
 * would have removed whole.
 */
export function createRedactor(config: RedactionConfig): (text: string) => string {
  return (text: string): string => {
    let redacted = redactHomePaths(text, config.homeDirectory);
    redacted = redactEnvValues(redacted, config.environmentVariableNames, config.environment);
    redacted = redactTokens(redacted, config.secretPatterns);
    return redacted;
  };
}

function asMapping(value: YamlValue | undefined): YamlMapping {
  if (value !== undefined && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}

function arrayOfStrings(value: YamlValue | undefined): readonly string[] | undefined {
  if (value === undefined || !Array.isArray(value)) return undefined;
  return value.map((item) => (typeof item === "string" ? item : String(item)));
}

function unionOnDefaults(defaults: readonly string[], configured: readonly string[] | undefined): readonly string[] {
  if (configured === undefined) return defaults;
  return [...new Set([...defaults, ...configured])];
}

function defaultConfig(env: NodeJS.ProcessEnv): RedactionConfig {
  return {
    secretPatterns: DEFAULT_TOKEN_PATTERNS,
    environmentVariableNames: DEFAULT_SECRET_ENV_NAMES,
    homeDirectory: env.HOME ?? "",
    environment: env,
  };
}

/**
 * Resolves the project's redaction config: built-in defaults, overlaid with a
 * top-level `redaction:` block's `secretPatterns` and `environmentVariableNames`
 * arrays from `<root>/orga.yaml`, when present. A missing file, a missing block,
 * a malformed block, or any parse error yields the built-in defaults unchanged;
 * this never throws and never yields an empty pattern set.
 */
export function resolveRedactionConfig(root: string, env: NodeJS.ProcessEnv): RedactionConfig {
  const base = defaultConfig(env);
  const orgaYamlPath = path.join(path.resolve(root), "orga.yaml");
  if (!fs.existsSync(orgaYamlPath)) return base;

  try {
    const text = fs.readFileSync(orgaYamlPath, "utf8");
    const parsed = parseYamlText(text, orgaYamlPath);
    const block = asMapping(parsed.redaction);
    return {
      ...base,
      secretPatterns: unionOnDefaults(DEFAULT_TOKEN_PATTERNS, arrayOfStrings(block.secretPatterns)),
      environmentVariableNames: unionOnDefaults(
        DEFAULT_SECRET_ENV_NAMES,
        arrayOfStrings(block.environmentVariableNames),
      ),
    };
  } catch {
    return base;
  }
}

const redactorCache = new Map<string, (text: string) => string>();

/**
 * `resolveRedactionConfig` plus `createRedactor`, memoized by resolved `root` so
 * a hot write boundary does not re-read and re-parse `orga.yaml` on every call.
 * `root` is `undefined` for a caller with no project root to resolve against
 * (evidence.ts's `writeLedger`, when `taskDir` carries no `/.orga/` segment);
 * that case falls back to the built-in defaults, cached under one shared key.
 */
export function redactorForRoot(root: string | undefined, env: NodeJS.ProcessEnv): (text: string) => string {
  const cacheKey = root !== undefined ? path.resolve(root) : "";
  const cached = redactorCache.get(cacheKey);
  if (cached) return cached;

  const config = root !== undefined ? resolveRedactionConfig(root, env) : defaultConfig(env);
  const redactor = createRedactor(config);
  redactorCache.set(cacheKey, redactor);
  return redactor;
}
