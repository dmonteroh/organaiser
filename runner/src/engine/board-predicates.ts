// Pure `facts -> result` predicates for every `task-board.v1` stage (see
// `workflows/manifests/task-board.v1.yaml`). This module is I/O-free: no
// filesystem, git, database, or child-process call happens here. Every fact a
// predicate consumes is gathered and resolved by its caller and passed in
// already computed; a predicate never re-opens or re-derives a fact itself.
//
// Each function's return type is a literal union restricted to its stage's
// declared `transitions` keys in the manifest, and nothing outside that set.
// `*_RETURN_VALUES` arrays are that union's single source of truth: both the
// TS type (via `(typeof X)[number]`) and `PREDICATE_RETURN_UNIONS` below are
// derived from them, so the two can never drift apart from each other.

export const BOOLEAN_TRANSITION_VALUES = ["true", "false"] as const;
export type BooleanTransition = (typeof BOOLEAN_TRANSITION_VALUES)[number];

export interface EntryArtifactsValidFacts {
  briefArtifactExists: boolean;
  briefArtifactSchemaValid: boolean;
}

export function entryArtifactsValid(facts: EntryArtifactsValidFacts): BooleanTransition {
  return facts.briefArtifactExists && facts.briefArtifactSchemaValid ? "true" : "false";
}

export interface DependenciesSatisfiedFacts {
  dependencyDispositions: readonly string[];
}

const DEPENDENCY_SATISFYING_DISPOSITIONS = new Set(["integrated", "superseded", "shelved"]);

export function dependenciesSatisfied(facts: DependenciesSatisfiedFacts): BooleanTransition {
  return facts.dependencyDispositions.every((disposition) =>
    DEPENDENCY_SATISFYING_DISPOSITIONS.has(disposition),
  )
    ? "true"
    : "false";
}

export interface ClaimsAvailableFacts {
  hasRequiredClaims: boolean;
}

export function claimsAvailable(facts: ClaimsAvailableFacts): BooleanTransition {
  return facts.hasRequiredClaims ? "true" : "false";
}

export interface BatchSlotAvailableFacts {
  activeBatchCount: number;
  batchCapacity: number | null;
}

export function batchSlotAvailable(facts: BatchSlotAvailableFacts): BooleanTransition {
  if (facts.batchCapacity === null) return "true";
  return facts.activeBatchCount < facts.batchCapacity ? "true" : "false";
}

export const PRODUCT_SPEC_OUTCOME_VALUES = [
  "skipped",
  "specified",
  "shelved",
  "needs-research",
  "needs-decision",
  "needs-operator",
] as const;
export type ProductSpecOutcome = (typeof PRODUCT_SPEC_OUTCOME_VALUES)[number];

export interface ProductSpecOutcomeFacts {
  decision: ProductSpecOutcome;
}

export function productSpecOutcome(facts: ProductSpecOutcomeFacts): ProductSpecOutcome {
  return facts.decision;
}

export const REFINEMENT_OUTCOME_VALUES = ["skipped", "ready-to-implement", "superseded", "parked"] as const;
export type RefinementOutcome = (typeof REFINEMENT_OUTCOME_VALUES)[number];

export interface RefinementOutcomeFacts {
  decision: RefinementOutcome;
}

export function refinementOutcome(facts: RefinementOutcomeFacts): RefinementOutcome {
  return facts.decision;
}

export const IMPLEMENTATION_OUTCOME_VALUES = ["integrating", "waiting-operator", "parked"] as const;
export type ImplementationOutcome = (typeof IMPLEMENTATION_OUTCOME_VALUES)[number];

export interface ImplementationOutcomeFacts {
  attemptOk: boolean;
  hasBlockingOperatorQuestion: boolean;
}

export function implementationOutcome(facts: ImplementationOutcomeFacts): ImplementationOutcome {
  if (facts.hasBlockingOperatorQuestion) return "waiting-operator"; // P8: operator questions are not implemented.
  return facts.attemptOk ? "integrating" : "parked";
}

export type IntegrationSlotAvailableFacts = Record<string, never>;

export function integrationSlotAvailable(_facts: IntegrationSlotAvailableFacts): BooleanTransition {
  // P7: multi-lane integration concurrency is not implemented; P5 is
  // single-lane serial, so a slot is always available.
  return "true";
}

export const INTEGRATION_OUTCOME_VALUES = [
  "integrated",
  "ready-to-implement",
  "waiting-operator",
  "parked",
] as const;
export type IntegrationOutcome = (typeof INTEGRATION_OUTCOME_VALUES)[number];

export interface IntegrationOutcomeFacts {
  attemptOk: boolean;
  hasIntegrationRejection: boolean;
  hasBlockingOperatorQuestion: boolean;
}

export function integrationOutcome(facts: IntegrationOutcomeFacts): IntegrationOutcome {
  if (facts.hasBlockingOperatorQuestion) return "waiting-operator"; // P8: operator questions are not implemented.
  if (facts.hasIntegrationRejection) return "ready-to-implement"; // P7: real integration rejection handling is not implemented.
  return facts.attemptOk ? "integrated" : "parked";
}

export const TERMINAL_DISPOSITION_VALUES = [
  "integrated",
  "superseded",
  "shelved",
  "cancelled",
  "parked",
  "waiting-operator",
] as const;
export type TerminalDisposition = (typeof TERMINAL_DISPOSITION_VALUES)[number];

export interface TerminalDispositionFacts {
  cancellationRequested: boolean;
  priorOutcome: string;
}

// Per goals spec 10.3, `cancelled` is acceptable only when cancellation was
// explicitly requested for this task, so a requested cancellation always wins
// regardless of what the task's prior stage outcome was.
export function terminalDisposition(facts: TerminalDispositionFacts): TerminalDisposition {
  if (facts.cancellationRequested) return "cancelled";
  switch (facts.priorOutcome) {
    case "integrated":
      return "integrated";
    case "shelved":
      return "shelved";
    case "superseded":
      return "superseded";
    case "waiting-operator":
    case "needs-operator":
      return "waiting-operator";
    default:
      return "parked";
  }
}

export const PREDICATE_RETURN_UNIONS: Readonly<Record<string, readonly string[]>> = {
  "entry-artifacts-valid": BOOLEAN_TRANSITION_VALUES,
  "dependencies-satisfied": BOOLEAN_TRANSITION_VALUES,
  "claims-available": BOOLEAN_TRANSITION_VALUES,
  "batch-slot-available": BOOLEAN_TRANSITION_VALUES,
  "product-spec-outcome": PRODUCT_SPEC_OUTCOME_VALUES,
  "refinement-outcome": REFINEMENT_OUTCOME_VALUES,
  "implementation-outcome": IMPLEMENTATION_OUTCOME_VALUES,
  "integration-slot-available": BOOLEAN_TRANSITION_VALUES,
  "integration-outcome": INTEGRATION_OUTCOME_VALUES,
  "terminal-disposition": TERMINAL_DISPOSITION_VALUES,
};
