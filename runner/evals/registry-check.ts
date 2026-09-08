// `DETERMINISTIC_FIXTURE_IDS` and `LIVE_SCENARIO_IDS` are the canonical
// deterministic-fixture and live-scenario id lists. A new fixture or live
// scenario id is added to the matching set in the same change that adds the
// fixture or scenario.

export class EvalRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalRegistryError";
  }
}

export const RUNNER_UNITS: readonly string[] = [
  "scheduler",
  "store",
  "supervisor",
  "claude-adapter",
  "codex-adapter",
  "fake-adapter",
  "process-supervisor",
  "git-integrator",
  "board-compiler",
  "workflow-compiler",
  "packet-compiler",
  "report-validator",
  "renderer",
  "importer",
  "evaluator",
];

export const DETERMINISTIC_FIXTURE_IDS: ReadonlySet<string> = new Set([
  "caller-exit-survival",
  "worker-final-is-data",
  "board-not-drained",
  "supervisor-restart",
  "supervisor-exits-at-rest",
  "cancel-run",
  "descendant-process-cleanup",
  "kill-without-supervisor",
  "pause-resume-roundtrip",
  "duplicate-dispatch",
  "stale-running-recovery",
  "invalid-report-fails-closed",
  "relocatable-artifacts",
  "read-only-source-tests",
  "typed-commit-identity-rejects-placeholder",
  "exit-zero-permission-denial",
  "partial-jsonl",
  "partial-stream-survives-kill",
  "structured-error-source",
  "known-bad-version-refused",
  "gate-order",
  "fresh-reviewer",
  "gate-cap-parks-task",
  "out-of-claim-write",
  "destination-cas",
  "integration-conflict",
  "worktree-cleanup",
  "historical-commit-rewrite",
  "unrelated-dirty-checkout-does-not-affect-task",
  "landed-work-recovery-without-false-success",
  "minor-findings-append-once",
  "in-place-refuses-dirty",
  "in-place-serializes",
  "in-place-claims-exclude-recorded-dirt",
  "blocking-finding-requires-proof",
  "dependency-order",
  "claim-overlap-serializes",
  "disjoint-claims-parallelize",
  "operator-block-does-not-global-stop",
  "terminal-task-never-dispatches",
  "importer-refuses-dead-running",
  "idle-timeout",
  "productive-no-commit",
  "secret-redaction",
]);

export const LIVE_SCENARIO_IDS: ReadonlySet<string> = new Set([
  "live-single-task",
  "live-board-drain",
  "live-review-repair",
  "live-blocked-lane",
  "live-runner-restart",
  "live-layer-isolation",
  "live-context-cost",
  "live-vendor-parity",
]);

export interface RegistryError {
  unit: string;
  kind:
    | "unit-missing"
    | "unit-unknown"
    | "deterministic-missing"
    | "deterministic-unknown-id"
    | "live-missing"
    | "live-unknown-id";
  detail: string;
}

interface RegistryUnitEntry {
  deterministic?: unknown;
  live?: unknown;
  liveExemptReason?: unknown;
}

export function validateRegistry(
  registry: unknown,
  availableTestIds: ReadonlySet<string>,
): RegistryError[] {
  if (
    typeof registry !== "object" ||
    registry === null ||
    !("units" in registry) ||
    typeof (registry as { units: unknown }).units !== "object" ||
    (registry as { units: unknown }).units === null
  ) {
    throw new EvalRegistryError("registry must be an object with a `units` object key");
  }

  const units = (registry as { units: Record<string, RegistryUnitEntry> }).units;
  const errors: RegistryError[] = [];

  const declaredUnits = new Set(RUNNER_UNITS);
  const presentUnits = new Set(Object.keys(units));

  for (const unit of RUNNER_UNITS) {
    if (!presentUnits.has(unit)) {
      errors.push({
        unit,
        kind: "unit-missing",
        detail: `registry.units is missing an entry for runner unit "${unit}"`,
      });
    }
  }

  for (const unit of presentUnits) {
    if (!declaredUnits.has(unit)) {
      errors.push({
        unit,
        kind: "unit-unknown",
        detail: `registry.units names "${unit}", which is not a RUNNER_UNITS entry`,
      });
    }
  }

  for (const unit of RUNNER_UNITS) {
    const entry = units[unit];
    if (!entry) {
      continue;
    }

    const deterministic = Array.isArray(entry.deterministic) ? entry.deterministic : [];
    if (deterministic.length === 0) {
      errors.push({
        unit,
        kind: "deterministic-missing",
        detail: `"${unit}" has no deterministic entries`,
      });
    }
    for (const id of deterministic) {
      if (!DETERMINISTIC_FIXTURE_IDS.has(id) && !availableTestIds.has(id)) {
        errors.push({
          unit,
          kind: "deterministic-unknown-id",
          detail: `"${unit}" names deterministic id "${id}", which is neither a registered fixture id nor a runner/test/*.test.ts basename`,
        });
      }
    }

    const hasLive = Array.isArray(entry.live) && entry.live.length > 0;
    const hasLiveExemptReason =
      typeof entry.liveExemptReason === "string" && entry.liveExemptReason.length > 0;

    if (hasLive && hasLiveExemptReason) {
      errors.push({
        unit,
        kind: "live-missing",
        detail: `"${unit}" carries both a live entry and a liveExemptReason; a unit is either live-covered or live-exempt, not both`,
      });
    } else if (!hasLive && !hasLiveExemptReason) {
      errors.push({
        unit,
        kind: "live-missing",
        detail: `"${unit}" has neither a live entry nor a liveExemptReason`,
      });
    }

    if (Array.isArray(entry.live)) {
      for (const id of entry.live) {
        if (!LIVE_SCENARIO_IDS.has(id)) {
          errors.push({
            unit,
            kind: "live-unknown-id",
            detail: `"${unit}" names live id "${id}", which is not a section 29.6 scenario id`,
          });
        }
      }
    }
  }

  return errors;
}
