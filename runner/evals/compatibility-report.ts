import fs from "node:fs";

import { createRedactor, DEFAULT_TOKEN_PATTERNS } from "../src/store/redact.ts";
import { LIVE_SCENARIO_IDS } from "./registry-check.ts";
import {
  VENDOR_IDS,
  type CompatibilityFile,
  type Observation,
  type ScenarioEntry,
  type VendorEntry,
  type VendorId,
} from "./compatibility-schema.ts";

const JWT_PATTERN = "eyJ[A-Za-z0-9_-]{10,}(?:\\.[A-Za-z0-9_-]+){1,2}";
const HOME_PATH_PATTERN = "/(?:Users|home)/[^/\\s]+";
const OAUTH_FIELD_PATTERN = "access_token|refresh_token|id_token|account_id";

const redact = createRedactor({
  secretPatterns: [...DEFAULT_TOKEN_PATTERNS, JWT_PATTERN, HOME_PATH_PATTERN, OAUTH_FIELD_PATTERN],
  environmentVariableNames: [],
  homeDirectory: "",
  environment: {} as NodeJS.ProcessEnv,
});

function selectObservation(
  observations: readonly Observation[],
  vendorId: VendorId,
): Observation | undefined {
  let selected: Observation | undefined;
  for (const observation of observations) {
    if (observation.vendor !== vendorId) continue;
    if (!selected || observation.date >= selected.date) {
      selected = observation;
    }
  }
  return selected;
}

function formatVendorLine(vendorId: VendorId, entry: VendorEntry): string {
  const base = `- \`${vendorId}\`: cliVersion=${entry.cliVersion}, captureDate=${entry.captureDate}, evidence=${entry.captureEvidence}`;
  if (entry.captureEvidence !== "partially-synthesized") return base;
  return `${base} (partially-synthesized; syntheticCases: ${entry.syntheticCases.join(", ")})`;
}

function formatScenarioLine(
  scenarioId: string,
  vendorId: VendorId,
  scenario: ScenarioEntry | undefined,
): string {
  const lastSuccessDate = scenario?.lastSuccessByVendor[vendorId];
  if (lastSuccessDate !== undefined) {
    return `- \`${scenarioId}\` / \`${vendorId}\`: live-verified success on ${lastSuccessDate}`;
  }

  const observation = scenario ? selectObservation(scenario.observations, vendorId) : undefined;
  if (observation) {
    return (
      `- \`${scenarioId}\` / \`${vendorId}\`: observed non-success on ${observation.date}, ` +
      `outcome=${observation.outcome}, restingRunState=${observation.restingRunState}, ` +
      `detail=${redact(observation.detail)}, evidenceRef=${redact(observation.evidenceRef)}`
    );
  }

  return `- \`${scenarioId}\` / \`${vendorId}\`: never-attempted`;
}

export function renderCompatibilityReport(data: CompatibilityFile): string {
  const lines: string[] = [];

  lines.push("# Compatibility report");
  lines.push("");
  lines.push("## Vendors");
  for (const vendorId of VENDOR_IDS) {
    const entry = data.vendors[vendorId];
    if (!entry) continue;
    lines.push(formatVendorLine(vendorId, entry));
  }
  lines.push("");

  lines.push("## Scenarios");
  for (const scenarioId of LIVE_SCENARIO_IDS) {
    for (const vendorId of VENDOR_IDS) {
      lines.push(formatScenarioLine(scenarioId, vendorId, data.scenarios[scenarioId]));
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function writeCompatibilityReport(data: CompatibilityFile, outputPath?: string): void {
  const content = renderCompatibilityReport(data);
  if (outputPath) {
    fs.writeFileSync(outputPath, content, "utf8");
    return;
  }
  process.stdout.write(content);
}
