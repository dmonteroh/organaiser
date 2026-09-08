import type { GradingCheck, GradingOutcome } from "./graders/types.ts";

export interface GradingArtifact {
  cellId: string;
  evalRunId: string;
  gradingSchemaVersion: 1;
  checks: readonly GradingCheck[];
  outcome: GradingOutcome;
}

export interface MetricsArtifact {
  cellId: string;
  evalRunId: string;
  metricsSchemaVersion: 1;
  wallTimeMs: number | null;
  exitCode: number | null;
  recordedPgidCount: number | null;
  eventCount: number | null;
  vendorStdoutBytes: number | null;
}

export const OUTCOME_SEVERITY: Readonly<Record<GradingOutcome, number>> = {
  "not-applicable": 0,
  pass: 1,
  "operational-failure": 2,
  fail: 3,
};

export function worstOutcome(outcomes: readonly GradingOutcome[]): GradingOutcome {
  let worst: GradingOutcome = "not-applicable";
  for (const outcome of outcomes) {
    if (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[worst]) worst = outcome;
  }
  return worst;
}

export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Duplicated from `artifact-writer.ts:8-10` rather than imported: that module
// pulls the store's redaction module into its graph, which this grading
// module graph must not carry.
function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function serializeGrading(artifact: GradingArtifact): string {
  return toJson(artifact);
}

export function serializeMetrics(artifact: MetricsArtifact): string {
  return toJson(artifact);
}
