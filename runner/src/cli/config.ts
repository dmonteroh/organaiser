import { DEFAULT_BUDGETS, type Budgets } from "../adapters/process-supervisor.ts";

// The default no-progress budget consumers fall back to when a caller omits
// it entirely (RV-02 watchdog convention: all budgets are seconds).
export const NO_PROGRESS_SECS_DEFAULT = DEFAULT_BUDGETS.NO_PROGRESS_SECS;

const ENV_PREFIX = "ORGA_";

export type Layer = Record<string, string | undefined>;

export type Read = (name: string) => string | undefined;

// Checks the environment layer, then the user layer, then the project layer,
// and returns the first value that is neither undefined nor the empty
// string. The environment key is prefixed per D16; the file layers are keyed
// by the bare field name.
function layeredRead(project: Layer, user: Layer, env: Layer): Read {
  return (name: string): string | undefined => {
    for (const raw of [env[`${ENV_PREFIX}${name}`], user[name], project[name]]) {
      if (raw !== undefined && raw !== "") return raw;
    }
    return undefined;
  };
}

export function positiveInt(read: Read, name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`invalid ${name}: ${raw} (must be an integer > 0)`);
  }
  return Number(raw);
}

export function nonNegativeInt(read: Read, name: string, fallback: number): number {
  const raw = read(name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`invalid ${name}: ${raw} (must be an integer >= 0)`);
  }
  return Number(raw);
}

const TRUTHY = ["1", "true", "yes", "y", "on"];
const FALSY = ["0", "false", "no", "n", "off"];

export function boolFlag(read: Read, name: string, fallback: boolean): boolean {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const lowered = raw.trim().toLowerCase();
  if (TRUTHY.includes(lowered)) return true;
  if (FALSY.includes(lowered)) return false;
  throw new Error(`invalid ${name}: ${raw} (must be a boolean flag)`);
}

export function stringVal(read: Read, name: string, fallback: string | null): string | null {
  const raw = read(name);
  if (raw === undefined) return fallback;
  return raw;
}

export function enumVal<T extends string>(
  read: Read,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = read(name);
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw as T)) {
    throw new Error(`invalid ${name}: ${raw} (must be one of ${allowed.join("|")})`);
  }
  return raw as T;
}

export type RunnerId = "codex" | "claude";
const RUNNER_IDS: readonly RunnerId[] = ["codex", "claude"];

export interface ConfigSources {
  project?: Layer;
  user?: Layer;
  env?: Layer;
}

export interface ResolvedConfig {
  runner: RunnerId;
  budgets: Budgets;
}

// Parses and validates the configuration surface. Collects every invalid
// value across all three layers and throws one aggregated error so an
// operator sees every problem at once instead of fixing them one at a time.
export function loadConfig(sources: ConfigSources = {}): Readonly<ResolvedConfig> {
  const { project = {}, user = {}, env = {} } = sources;
  const read = layeredRead(project, user, env);

  const errors: string[] = [];
  function attempt<T>(run: () => T, fallback: T): T {
    try {
      return run();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return fallback;
    }
  }

  const config: ResolvedConfig = {
    runner: attempt(() => enumVal(read, "RUNNER", RUNNER_IDS, "codex"), "codex"),
    budgets: {
      POLL_SECS: attempt(
        () => positiveInt(read, "POLL_SECS", DEFAULT_BUDGETS.POLL_SECS),
        DEFAULT_BUDGETS.POLL_SECS,
      ),
      NO_PROGRESS_SECS: attempt(
        () => positiveInt(read, "NO_PROGRESS_SECS", NO_PROGRESS_SECS_DEFAULT),
        NO_PROGRESS_SECS_DEFAULT,
      ),
      GRACE_SECS: attempt(
        () => positiveInt(read, "GRACE_SECS", DEFAULT_BUDGETS.GRACE_SECS),
        DEFAULT_BUDGETS.GRACE_SECS,
      ),
      HARD_CEILING_SECS: attempt(
        () => positiveInt(read, "HARD_CEILING_SECS", DEFAULT_BUDGETS.HARD_CEILING_SECS),
        DEFAULT_BUDGETS.HARD_CEILING_SECS,
      ),
    },
  };

  if (errors.length > 0) {
    throw new Error(`invalid organaiser config:\n  - ${errors.join("\n  - ")}`);
  }

  return Object.freeze(config);
}

export default loadConfig;
