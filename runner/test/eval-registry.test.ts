import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DETERMINISTIC_FIXTURE_IDS,
  LIVE_SCENARIO_IDS,
  validateRegistry,
  validateRegistryInvocations,
} from "../evals/registry-check.ts";

const registryPath = fileURLToPath(new URL("../evals/registry.json", import.meta.url));
const testDir = fileURLToPath(new URL(".", import.meta.url));
const registryCheckPath = fileURLToPath(new URL("../evals/registry-check.ts", import.meta.url));

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

test("eval-registry: the real registry.json has no unmapped unit, unknown fixture id, or unknown live id", async () => {
  const registry = baseRegistry();
  const errors = validateRegistry(registry, readAvailableTestIds());
  assert.deepEqual(errors, []);
  assert.deepEqual(await validateRegistryInvocations(registry), []);
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

test("eval-registry: an extra units key naming a non-RUNNER_UNITS unit yields exactly one unit-unknown error", () => {
  const registry = baseRegistry();
  registry.units["no-such-unit"] = {
    deterministic: ["worker-final-is-data"],
    live: ["live-single-task"],
  };

  const errors = validateRegistry(registry, readAvailableTestIds());

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "unit-unknown");
  assert.equal(errors[0]?.unit, "no-such-unit");
});

test("eval-registry: DETERMINISTIC_FIXTURE_IDS and LIVE_SCENARIO_IDS are pinned to the eval-suite doc's counts", () => {
  // A change to either number means the eval-suite doc changed and the
  // transcription in registry-check.ts was re-checked against it.
  assert.equal(DETERMINISTIC_FIXTURE_IDS.size, 44);
  assert.equal(LIVE_SCENARIO_IDS.size, 8);
});

test("eval-registry: a deterministic id with no fixture-invocations.ts entry yields exactly one deterministic-unresolved-invocation error", async () => {
  const registry = baseRegistry();
  const scheduler = registry.units.scheduler as { deterministic: string[] };
  scheduler.deterministic = [...scheduler.deterministic, "no-such-fixture"];

  const errors = await validateRegistryInvocations(registry);

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "deterministic-unresolved-invocation");
  assert.equal(errors[0]?.unit, "scheduler");
  assert.ok(errors[0]?.detail.includes("no-such-fixture"));
});

test("eval-registry: a live id with no fixture-invocations.ts entry yields exactly one live-unresolved-invocation error", async () => {
  const registry = baseRegistry();
  const gitIntegrator = registry.units["git-integrator"] as { live: string[] };
  gitIntegrator.live = [...gitIntegrator.live, "live-nonexistent"];

  const errors = await validateRegistryInvocations(registry);

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "live-unresolved-invocation");
  assert.equal(errors[0]?.unit, "git-integrator");
  assert.ok(errors[0]?.detail.includes("live-nonexistent"));
});

test("eval-registry: a parametrized-factory id registered under a non-adapter unit yields exactly one deterministic-unresolved-invocation error", async () => {
  const registry = baseRegistry();
  const scheduler = registry.units.scheduler as { deterministic: string[] };
  scheduler.deterministic = [...scheduler.deterministic, "partial-jsonl"];

  const errors = await validateRegistryInvocations(registry);

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.kind, "deterministic-unresolved-invocation");
  assert.equal(errors[0]?.unit, "scheduler");
  assert.ok(errors[0]?.detail.includes("partial-jsonl"));
});

test("eval-registry: registry-check.ts reaches fixture-invocations.ts only through a dynamic import", () => {
  const source = fs.readFileSync(registryCheckPath, "utf8");
  assert.ok(source.includes('await import("./fixture-invocations.ts")'));
  assert.ok(!source.includes('from "./fixture-invocations.ts"'));
});

test("eval-registry: the live vendor loop only breaks after a thrown resolveInvocation, never after a successful one", () => {
  // resolveInvocation's live-id branch is vendor-agnostic today, so a
  // behavioral test can't force "claude" to succeed while "codex" throws for
  // the same id. This pins the control-flow shape directly: the vendor loop
  // must attempt every vendor in order and stop only once resolveInvocation
  // throws (inside the catch). A `break;` placed immediately after the
  // resolveInvocation(unit, vendor, id) call itself (i.e. on the success
  // path, before the catch) would end the loop as soon as any vendor
  // succeeds, so "codex" would only ever be attempted when "claude" throws.
  const source = fs.readFileSync(registryCheckPath, "utf8");
  assert.ok(
    /resolveInvocation\(unit, vendor, id\);\s*\}\s*catch/.test(source),
    "resolveInvocation(unit, vendor, id) must fall through to the next vendor on success, not break early",
  );
});
