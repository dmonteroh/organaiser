import { LIVE_SCENARIO_IDS } from "./registry-check.ts";

export const VENDOR_IDS = ["claude", "codex"] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export const OUTCOMES = ["succeeded", "failed", "blocked"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const RESTING_RUN_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "paused",
  "waiting-operator",
  "blocked",
] as const;
export type RestingRunState = (typeof RESTING_RUN_STATES)[number];

export const CAPTURE_EVIDENCE_VALUES = ["recorded", "partially-synthesized"] as const;
export type CaptureEvidence = (typeof CAPTURE_EVIDENCE_VALUES)[number];

export interface VendorEntry {
  cliVersion: string;
  captureDate: string;
  captureEvidence: CaptureEvidence;
  syntheticCases: string[];
}

export interface Observation {
  vendor: VendorId;
  date: string;
  cliVersion: string | null;
  model: string | null;
  outcome: Outcome;
  restingRunState: RestingRunState;
  detail: string;
  evidenceRef: string;
}

export interface ScenarioEntry {
  lastSuccessByVendor: Partial<Record<VendorId, string>>;
  observations: Observation[];
}

export interface CompatibilityFile {
  schemaVersion: 1;
  vendors: Partial<Record<VendorId, VendorEntry>>;
  scenarios: Record<string, ScenarioEntry>;
}

export interface CompatibilityError {
  kind:
    | "root-invalid"
    | "scenario-unknown"
    | "last-success-unbacked"
    | "observation-vendor-unknown"
    | "observation-date-invalid"
    | "observation-outcome-invalid"
    | "observation-resting-run-state-invalid"
    | "observation-detail-empty"
    | "observation-evidence-ref-invalid"
    | "observation-succeeded-missing-cli-version-or-model";
  detail: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface RawObservation {
  vendor?: unknown;
  date?: unknown;
  cliVersion?: unknown;
  model?: unknown;
  outcome?: unknown;
  restingRunState?: unknown;
  detail?: unknown;
  evidenceRef?: unknown;
}

interface RawScenario {
  lastSuccessByVendor?: Record<string, unknown>;
  observations?: unknown;
}

export function validateCompatibility(data: unknown): CompatibilityError[] {
  if (
    typeof data !== "object" ||
    data === null ||
    !("scenarios" in data) ||
    typeof (data as { scenarios: unknown }).scenarios !== "object" ||
    (data as { scenarios: unknown }).scenarios === null
  ) {
    return [
      {
        kind: "root-invalid",
        detail: "compatibility data must be an object with a `scenarios` object key",
      },
    ];
  }

  const errors: CompatibilityError[] = [];
  const scenarios = (data as { scenarios: Record<string, RawScenario> }).scenarios;
  const vendors =
    (data as { vendors?: Record<string, { cliVersion?: unknown }> }).vendors ?? {};

  for (const [scenarioId, rawScenario] of Object.entries(scenarios)) {
    if (!LIVE_SCENARIO_IDS.has(scenarioId)) {
      errors.push({
        kind: "scenario-unknown",
        detail: `scenarios names "${scenarioId}", which is not a LIVE_SCENARIO_IDS entry`,
      });
    }

    if (
      typeof rawScenario !== "object" ||
      rawScenario === null ||
      !Array.isArray(rawScenario.observations)
    ) {
      continue;
    }

    const observations = rawScenario.observations.filter(
      (entry): entry is RawObservation => typeof entry === "object" && entry !== null,
    );

    for (const observation of observations) {
      const { vendor, date, cliVersion, model, outcome, restingRunState, detail, evidenceRef } =
        observation;

      if (!(typeof vendor === "string" && (VENDOR_IDS as readonly string[]).includes(vendor))) {
        errors.push({
          kind: "observation-vendor-unknown",
          detail: `scenario "${scenarioId}" carries an observation with vendor "${String(vendor)}", which is not "claude" or "codex"`,
        });
      }

      if (!(typeof date === "string" && DATE_PATTERN.test(date))) {
        errors.push({
          kind: "observation-date-invalid",
          detail: `scenario "${scenarioId}" carries an observation with date "${String(date)}", which does not match YYYY-MM-DD`,
        });
      }

      if (!(typeof outcome === "string" && (OUTCOMES as readonly string[]).includes(outcome))) {
        errors.push({
          kind: "observation-outcome-invalid",
          detail: `scenario "${scenarioId}" carries an observation with outcome "${String(outcome)}", which is not "succeeded", "failed" or "blocked"`,
        });
      }

      if (
        !(
          typeof restingRunState === "string" &&
          (RESTING_RUN_STATES as readonly string[]).includes(restingRunState)
        )
      ) {
        errors.push({
          kind: "observation-resting-run-state-invalid",
          detail: `scenario "${scenarioId}" carries an observation with restingRunState "${String(restingRunState)}", which is not a RestingRunState value`,
        });
      }

      if (!isNonEmptyString(detail)) {
        errors.push({
          kind: "observation-detail-empty",
          detail: `scenario "${scenarioId}" carries an observation with an empty or missing detail`,
        });
      }

      if (!(isNonEmptyString(evidenceRef) && evidenceRef.startsWith("runner/"))) {
        errors.push({
          kind: "observation-evidence-ref-invalid",
          detail: `scenario "${scenarioId}" carries an observation with evidenceRef "${String(evidenceRef)}", which must be a non-empty string beginning "runner/"`,
        });
      }

      if (outcome === "succeeded" && !(isNonEmptyString(cliVersion) && isNonEmptyString(model))) {
        errors.push({
          kind: "observation-succeeded-missing-cli-version-or-model",
          detail: `scenario "${scenarioId}" carries a succeeded observation with an empty or missing cliVersion or model`,
        });
      }
    }

    const lastSuccessByVendor = rawScenario.lastSuccessByVendor ?? {};
    for (const [vendor, date] of Object.entries(lastSuccessByVendor)) {
      const backed = observations.some(
        (observation) =>
          observation.vendor === vendor &&
          observation.date === date &&
          observation.outcome === "succeeded" &&
          observation.cliVersion === vendors[vendor]?.cliVersion,
      );
      if (!backed) {
        errors.push({
          kind: "last-success-unbacked",
          detail: `scenario "${scenarioId}" carries lastSuccessByVendor["${vendor}"] = "${String(date)}" with no matching succeeded observation for that vendor, date and cliVersion`,
        });
      }
    }
  }

  return errors;
}
