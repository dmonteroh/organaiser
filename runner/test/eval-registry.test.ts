import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DETERMINISTIC_FIXTURE_IDS,
  LIVE_SCENARIO_IDS,
  validateRegistry,
} from "../evals/registry-check.ts";

const registryPath = fileURLToPath(new URL("../evals/registry.json", import.meta.url));
const testDir = fileURLToPath(new URL(".", import.meta.url));

function readAvailableTestIds(): ReadonlySet<string> {
  return new Set(
    fs
      .readdirSync(testDir)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => name.slice(0, -".test.ts".length)),
  );
}

function baseRegistry(): { units: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as { units: Record<string, unknown> };
}

test("eval-registry: the real registry.json has no unmapped unit, unknown fixture id, or unknown live id", () => {
  const registry = baseRegistry();
  const errors = validateRegistry(registry, readAvailableTestIds());
  assert.deepEqual(errors, []);
});

test("eval-registry: a unit missing from the registry yields exactly one unit-missing error", () => {
  const registry = baseRegistry();
  delete registry.units.renderer;

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "unit-missing");
  assert.equal(errors[0]?.unit, "renderer");
});

test("eval-registry: an unknown deterministic fixture id yields exactly one deterministic-unknown-id error", () => {
  const registry = baseRegistry();
  const scheduler = registry.units.scheduler as { deterministic: string[] };
  scheduler.deterministic = [...scheduler.deterministic, "no-such-fixture"];

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "deterministic-unknown-id");
  assert.equal(errors[0]?.unit, "scheduler");
});

test("eval-registry: an unknown live scenario id yields exactly one live-unknown-id error", () => {
  const registry = baseRegistry();
  const gitIntegrator = registry.units["git-integrator"] as { live: string[] };
  gitIntegrator.live = [...gitIntegrator.live, "live-nonexistent"];

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "live-unknown-id");
  assert.equal(errors[0]?.unit, "git-integrator");
});

test("eval-registry: a unit with neither a live entry nor a liveExemptReason yields exactly one live-missing error", () => {
  const registry = baseRegistry();
  const store = registry.units.store as { live?: string[]; liveExemptReason?: string };
  delete store.live;
  delete store.liveExemptReason;

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "live-missing");
  assert.equal(errors[0]?.unit, "store");
});

test("eval-registry: a unit with no deterministic entries yields exactly one deterministic-missing error", () => {
  const registry = baseRegistry();
  const store = registry.units.store as { deterministic: string[] };
  store.deterministic = [];

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "deterministic-missing");
  assert.equal(errors[0]?.unit, "store");
});

test("eval-registry: a unit carrying both a live entry and a liveExemptReason yields exactly one live-missing error", () => {
  const registry = baseRegistry();
  const store = registry.units.store as { live?: string[]; liveExemptReason?: string };
  store.live = ["live-single-task"];
  store.liveExemptReason = "covered elsewhere";

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "live-missing");
  assert.equal(errors[0]?.unit, "store");
});

test("eval-registry: an extra units.evaluator key yields exactly one unit-unknown error", () => {
  const registry = baseRegistry();
  registry.units.evaluator = {
    deterministic: ["worker-final-is-data"],
    live: ["live-single-task"],
  };

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "unit-unknown");
  assert.equal(errors[0]?.unit, "evaluator");
});

test("eval-registry: DETERMINISTIC_FIXTURE_IDS and LIVE_SCENARIO_IDS are pinned to the eval-suite doc's counts", () => {
  // A change to either number means the eval-suite doc changed and the
  // transcription in registry-check.ts was re-checked against it.
  assert.equal(DETERMINISTIC_FIXTURE_IDS.size, 44);
  assert.equal(LIVE_SCENARIO_IDS.size, 8);
});
