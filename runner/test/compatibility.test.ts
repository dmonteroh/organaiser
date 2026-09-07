import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateCompatibility, type CompatibilityFile } from "../evals/compatibility-schema.ts";

const compatibilityPath = fileURLToPath(new URL("../evals/compatibility.json", import.meta.url));

function baseCompatibility(): CompatibilityFile {
  return JSON.parse(fs.readFileSync(compatibilityPath, "utf8")) as CompatibilityFile;
}

test("compatibility: the real compatibility.json has no shape violations", () => {
  const data = baseCompatibility();
  const errors = validateCompatibility(data);
  assert.deepEqual(errors, []);
});

test("compatibility: a lastSuccessByVendor entry with no backing observation yields a last-success-unbacked error", () => {
  const data = baseCompatibility();
  data.scenarios["live-single-task"].lastSuccessByVendor.codex = "2026-09-05";

  const errors = validateCompatibility(data);

  assert.ok(errors.some((error) => error.kind === "last-success-unbacked"));
});

test("compatibility: a lastSuccessByVendor entry whose backing observation's date differs yields a last-success-unbacked error", () => {
  const data = baseCompatibility();
  const scenario = data.scenarios["live-single-task"];
  scenario.observations.push({
    vendor: "codex",
    date: "2026-09-05",
    cliVersion: "0.46.0",
    model: "gpt-oss:20b",
    outcome: "succeeded",
    restingRunState: "succeeded",
    detail: "seeded for test purposes",
    evidenceRef: "runner/evals/fixtures/14-live-single-task.ts#L20-L26",
  });
  scenario.lastSuccessByVendor.codex = "2026-09-06";

  const errors = validateCompatibility(data);

  assert.ok(errors.some((error) => error.kind === "last-success-unbacked"));
});

test("compatibility: a succeeded observation with cliVersion: null yields an observation-succeeded-missing-cli-version-or-model error", () => {
  const data = baseCompatibility();
  data.scenarios["live-single-task"].observations.push({
    vendor: "codex",
    date: "2026-09-05",
    cliVersion: null,
    model: "gpt-oss:20b",
    outcome: "succeeded",
    restingRunState: "succeeded",
    detail: "seeded for test purposes",
    evidenceRef: "runner/evals/fixtures/14-live-single-task.ts#L20-L26",
  });

  const errors = validateCompatibility(data);

  assert.ok(
    errors.some((error) => error.kind === "observation-succeeded-missing-cli-version-or-model"),
  );
});

test("compatibility: an unknown scenario id yields a scenario-unknown error", () => {
  const data = baseCompatibility() as unknown as {
    scenarios: Record<string, CompatibilityFile["scenarios"][string]>;
  };
  data.scenarios["live-nonexistent"] = {
    lastSuccessByVendor: {},
    observations: [],
  };

  const errors = validateCompatibility(data);

  assert.ok(errors.some((error) => error.kind === "scenario-unknown"));
});

test("compatibility: an unknown vendor yields an observation-vendor-unknown error", () => {
  const data = baseCompatibility() as unknown as {
    scenarios: Record<
      string,
      { observations: Array<Record<string, unknown>>; lastSuccessByVendor: unknown }
    >;
  };
  data.scenarios["live-single-task"].observations[0].vendor = "gpt4";

  const errors = validateCompatibility(data);

  assert.ok(errors.some((error) => error.kind === "observation-vendor-unknown"));
});

test("compatibility: an outcome outside the three-value enum yields an observation-outcome-invalid error", () => {
  const data = baseCompatibility() as unknown as {
    scenarios: Record<string, { observations: Array<Record<string, unknown>> }>;
  };
  data.scenarios["live-single-task"].observations[0].outcome = "pending";

  const errors = validateCompatibility(data);

  assert.ok(errors.some((error) => error.kind === "observation-outcome-invalid"));
});

test("compatibility: an evidenceRef pointing into tmp/ yields an observation-evidence-ref-invalid error", () => {
  const data = baseCompatibility() as unknown as {
    scenarios: Record<string, { observations: Array<Record<string, unknown>> }>;
  };
  data.scenarios["live-single-task"].observations[0].evidenceRef =
    "tmp/new-workflow-version/05-briefs/P9h-i-compatibility-schema-and-seed-data.md";

  const errors = validateCompatibility(data);

  assert.ok(errors.some((error) => error.kind === "observation-evidence-ref-invalid"));
});
