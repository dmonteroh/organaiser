// Maps each `task-board.v1` manifest predicate name to its `board-predicates.ts`
// function. `board-predicates.ts`'s `PREDICATE_RETURN_UNIONS` is the single
// source of truth for which predicate names exist; this module throws at load
// time if its own map and that set disagree in either direction, so a
// predicate the manifest declares can never go silently unimplemented, and a
// mapped name the manifest no longer declares can never go silently unused.

import {
  batchSlotAvailable,
  claimsAvailable,
  dependenciesSatisfied,
  entryArtifactsValid,
  implementationOutcome,
  integrationOutcome,
  integrationSlotAvailable,
  PREDICATE_RETURN_UNIONS,
  productSpecOutcome,
  refinementOutcome,
  terminalDisposition,
} from "./board-predicates.ts";

export class PredicateRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PredicateRegistryError";
  }
}

// Heterogeneous by design: each predicate has its own `Facts` and return-union
// type, and this table dispatches across all ten by manifest name at runtime.
export type AnyPredicateFn = (facts: any) => string;

export const PREDICATE_REGISTRY: Readonly<Record<string, AnyPredicateFn>> = {
  "entry-artifacts-valid": entryArtifactsValid,
  "dependencies-satisfied": dependenciesSatisfied,
  "claims-available": claimsAvailable,
  "batch-slot-available": batchSlotAvailable,
  "product-spec-outcome": productSpecOutcome,
  "refinement-outcome": refinementOutcome,
  "implementation-outcome": implementationOutcome,
  "integration-slot-available": integrationSlotAvailable,
  "integration-outcome": integrationOutcome,
  "terminal-disposition": terminalDisposition,
};

function assertRegistryMatchesDeclaredPredicates(): void {
  const declared = new Set(Object.keys(PREDICATE_RETURN_UNIONS));
  const registered = new Set(Object.keys(PREDICATE_REGISTRY));

  const missing = [...declared].filter((name) => !registered.has(name));
  const extra = [...registered].filter((name) => !declared.has(name));

  if (missing.length > 0 || extra.length > 0) {
    throw new PredicateRegistryError(
      `predicate registry mismatch: missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`,
    );
  }
}

assertRegistryMatchesDeclaredPredicates();

export function getPredicate(name: string): AnyPredicateFn {
  const fn = PREDICATE_REGISTRY[name];
  if (!fn) {
    throw new PredicateRegistryError(`no predicate registered for name: ${name}`);
  }
  return fn;
}
