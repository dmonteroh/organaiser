// The eval subsystem's "suite" and "profile" vocabulary (goals spec section
// 25.1). A **suite** is one of `registry.json`'s `units` keys — re-exported
// here from `registry-check.ts`'s `RUNNER_UNITS` rather than re-derived by
// hand, so this module and the registry's own build gate can never diverge.
// A **profile** is one of a fixed three-id set independent of the registry:
// `fake` (deterministic tier, no credentials) or `claude`/`codex` (live
// tier). `PROFILE_IDS` is declared locally rather than imported from
// `cli/profiles.ts`, whose own `VENDOR_IDS` constant is module-private —
// mirroring `compatibility-schema.ts`'s identical `VENDOR_IDS`/`VendorId`
// precedent for the same problem.
//
// This module never calls `cli/profiles.ts`'s `resolveVendorProfile`: it
// only enumerates which registry id list (`deterministic`/`live`) each
// profile would run for a suite, never a resolved executable/model/timeout
// shape. `eval list` (the sole consumer of `buildEvalCatalog` today) is
// therefore a pure, credential-free read of the code-shipped `registry.json`.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { RUNNER_UNITS } from "./registry-check.ts";

/** The registry-declared suite names, in `registry-check.ts`'s canonical order. */
export const SUITE_NAMES: readonly string[] = RUNNER_UNITS;

export const PROFILE_IDS = ["fake", "claude", "codex"] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export class UnknownSuiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownSuiteError";
  }
}

export class UnknownProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownProfileError";
  }
}

export function assertKnownSuite(suite: string): void {
  if (!SUITE_NAMES.includes(suite)) {
    throw new UnknownSuiteError(
      `unknown suite "${suite}" (known suites: ${SUITE_NAMES.join(", ")})`,
    );
  }
}

export function assertKnownProfile(profile: string): asserts profile is ProfileId {
  if (!(PROFILE_IDS as readonly string[]).includes(profile)) {
    throw new UnknownProfileError(
      `unknown profile "${profile}" (known profiles: ${PROFILE_IDS.join(", ")})`,
    );
  }
}

/** Mirrors `registry-check.ts`'s internal `RegistryUnitEntry` shape, made public for this module's own use. */
export interface RegistryUnitEntry {
  deterministic: readonly string[];
  live?: readonly string[];
  liveExemptReason?: string;
}

export interface EvalRegistry {
  units: Record<string, RegistryUnitEntry>;
}

const REGISTRY_PATH = fileURLToPath(new URL("./registry.json", import.meta.url));

/** Reads and parses the sibling `registry.json` — a fixed, code-shipped asset, not user-supplied input. */
export function loadRegistry(): EvalRegistry {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8")) as EvalRegistry;
}

/** Which registry id list a given (suite, profile) pair runs. */
export type EvalTier = "deterministic" | "live" | "live-exempt";

export interface SuiteProfileEntry {
  tier: EvalTier;
  ids: readonly string[];
  /** Present only when `tier` is `"live-exempt"`, carrying the registry's own reason string verbatim. */
  liveExemptReason?: string;
}

/**
 * Resolves the single `(suite, profile)` pair `P9f-b`/`P9f-d` consume:
 * validates both names (throwing the named errors above on an unknown one),
 * then returns which id list that pair runs. `fake` always resolves to the
 * unit's `deterministic` tier; `claude`/`codex` resolve to the unit's `live`
 * tier when present, or to a `"live-exempt"` tier carrying the unit's
 * `liveExemptReason` verbatim when it is not — never an empty `live` array
 * and never a silently dropped pair.
 */
export function resolveSuiteProfile(
  registry: EvalRegistry,
  suite: string,
  profile: string,
): SuiteProfileEntry {
  assertKnownSuite(suite);
  assertKnownProfile(profile);

  const unit = registry.units[suite];
  if (!unit) {
    throw new UnknownSuiteError(`registry has no entry for suite "${suite}"`);
  }

  if (profile === "fake") {
    return { tier: "deterministic", ids: unit.deterministic };
  }

  if (unit.liveExemptReason !== undefined) {
    return { tier: "live-exempt", ids: [], liveExemptReason: unit.liveExemptReason };
  }

  return { tier: "live", ids: unit.live ?? [] };
}

export interface SuiteCatalogEntry {
  suite: string;
  profiles: Record<ProfileId, SuiteProfileEntry>;
}

export type EvalCatalog = readonly SuiteCatalogEntry[];

/** Whole-catalog builder `eval list` uses: every suite crossed with every profile. */
export function buildEvalCatalog(registry: EvalRegistry): EvalCatalog {
  return SUITE_NAMES.map((suite) => ({
    suite,
    profiles: {
      fake: resolveSuiteProfile(registry, suite, "fake"),
      claude: resolveSuiteProfile(registry, suite, "claude"),
      codex: resolveSuiteProfile(registry, suite, "codex"),
    },
  }));
}

function idsCell(entry: SuiteProfileEntry): string {
  if (entry.tier === "live-exempt") return `(exempt: ${entry.liveExemptReason})`;
  return entry.ids.length > 0 ? entry.ids.join(", ") : "(none)";
}

/** padEnd-based human table, mirroring `commands.ts`'s `formatQuestionTable`: one row per (suite, profile) pair. */
export function formatEvalCatalogTable(catalog: EvalCatalog): string[] {
  interface TableRow {
    suite: string;
    profile: string;
    tier: string;
    ids: string;
  }

  const header: TableRow = { suite: "suite", profile: "profile", tier: "tier", ids: "ids" };
  const dataRows: TableRow[] = catalog.flatMap((entry) =>
    PROFILE_IDS.map((profile) => {
      const result = entry.profiles[profile];
      return {
        suite: entry.suite,
        profile,
        tier: result.tier,
        ids: idsCell(result),
      };
    }),
  );
  const allRows = [header, ...dataRows];

  const suiteWidth = Math.max(...allRows.map((row) => row.suite.length));
  const profileWidth = Math.max(...allRows.map((row) => row.profile.length));
  const tierWidth = Math.max(...allRows.map((row) => row.tier.length));

  return allRows.map((row) =>
    [row.suite.padEnd(suiteWidth), row.profile.padEnd(profileWidth), row.tier.padEnd(tierWidth), row.ids].join(
      "  ",
    ),
  );
}
