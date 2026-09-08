// Duplicated from `STAGE_DEFINITIONS` (runner/src/engine/scheduler.ts:78-157) rather
// than imported, per this package's import rule: scheduler.ts pulls in
// ../store/db.ts, ../store/events.ts, and (via ../adapters/fake.ts) node:child_process,
// none of which belong in a pure grader library. The `predicateName` field is dropped;
// everything else is copied verbatim. Kept honest by the parity test in
// runner/test/graders.test.ts, which asserts this table against scheduler.ts's own
// table, id-for-id and target-for-target.

export interface LegalStageTransitions {
  id: string;
  transitions: Readonly<Record<string, string>>;
}

export const LEGAL_TRANSITIONS: readonly LegalStageTransitions[] = [
  {
    id: "admit-task",
    transitions: { true: "release-dependencies", false: "reconcile-outcome" },
  },
  {
    id: "release-dependencies",
    transitions: { true: "acquire-claims", false: "release-dependencies" },
  },
  {
    id: "acquire-claims",
    transitions: { true: "admit-to-batch", false: "acquire-claims" },
  },
  {
    id: "admit-to-batch",
    transitions: { true: "product-specification", false: "admit-to-batch" },
  },
  {
    id: "product-specification",
    transitions: {
      skipped: "task-refinement",
      specified: "task-refinement",
      shelved: "reconcile-outcome",
      "needs-research": "reconcile-outcome",
      "needs-decision": "reconcile-outcome",
      "needs-operator": "reconcile-outcome",
    },
  },
  {
    id: "task-refinement",
    transitions: {
      skipped: "implementation",
      "ready-to-implement": "implementation",
      superseded: "reconcile-outcome",
      parked: "reconcile-outcome",
    },
  },
  {
    id: "implementation",
    transitions: {
      integrating: "integration-candidate",
      "waiting-operator": "reconcile-outcome",
      parked: "reconcile-outcome",
    },
  },
  {
    id: "integration-candidate",
    transitions: { true: "integration", false: "integration-candidate" },
  },
  {
    id: "integration",
    transitions: {
      integrated: "reconcile-outcome",
      "ready-to-implement": "implementation",
      "waiting-operator": "reconcile-outcome",
      parked: "reconcile-outcome",
    },
  },
  {
    id: "reconcile-outcome",
    transitions: {
      integrated: "integrated",
      superseded: "superseded",
      shelved: "shelved",
      cancelled: "cancelled",
      parked: "parked",
      "waiting-operator": "waiting-operator",
    },
  },
];

export const LEGAL_TRANSITIONS_BY_ID: ReadonlyMap<string, LegalStageTransitions> = new Map(
  LEGAL_TRANSITIONS.map((stage) => [stage.id, stage]),
);
