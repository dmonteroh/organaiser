import assert from "node:assert/strict";
import test from "node:test";

import { RUNNER_UNITS } from "../evals/registry-check.ts";
import {
  SUITE_NAMES,
  PROFILE_IDS,
  UnknownSuiteError,
  UnknownProfileError,
  assertKnownSuite,
  assertKnownProfile,
  loadRegistry,
  buildEvalCatalog,
  resolveSuiteProfile,
} from "../evals/eval-vocabulary.ts";

test("SUITE_NAMES equals registry-check.ts's RUNNER_UNITS", () => {
  assert.deepEqual(SUITE_NAMES, RUNNER_UNITS);
});

test("PROFILE_IDS is exactly [fake, claude, codex]", () => {
  assert.deepEqual(PROFILE_IDS, ["fake", "claude", "codex"]);
});

test("assertKnownSuite accepts every real suite name and rejects an unknown one", () => {
  for (const suite of SUITE_NAMES) {
    assert.doesNotThrow(() => assertKnownSuite(suite));
  }
  assert.throws(() => assertKnownSuite("no-such-suite"), UnknownSuiteError);
});

test("assertKnownProfile accepts every real profile id and rejects an unknown one", () => {
  for (const profile of PROFILE_IDS) {
    assert.doesNotThrow(() => assertKnownProfile(profile));
  }
  assert.throws(() => assertKnownProfile("no-such-profile"), UnknownProfileError);
});

test("resolveSuiteProfile rejects an unknown suite or profile with the named errors", () => {
  const registry = loadRegistry();
  assert.throws(() => resolveSuiteProfile(registry, "no-such-suite", "fake"), UnknownSuiteError);
  assert.throws(() => resolveSuiteProfile(registry, "scheduler", "no-such-profile"), UnknownProfileError);
});

test("resolveSuiteProfile: fake always maps to deterministic with the unit's exact id array", () => {
  const registry = loadRegistry();
  for (const suite of SUITE_NAMES) {
    const entry = resolveSuiteProfile(registry, suite, "fake");
    assert.equal(entry.tier, "deterministic");
    assert.deepEqual(entry.ids, registry.units[suite]?.deterministic);
    assert.equal(entry.liveExemptReason, undefined);
  }
});

test("resolveSuiteProfile: claude/codex map to live where the registry declares a live array", () => {
  const registry = loadRegistry();
  const liveCoveredSuites = SUITE_NAMES.filter(
    (suite) => registry.units[suite]?.liveExemptReason === undefined,
  );
  assert.ok(liveCoveredSuites.length > 0);

  for (const suite of liveCoveredSuites) {
    for (const profile of ["claude", "codex"] as const) {
      const entry = resolveSuiteProfile(registry, suite, profile);
      assert.equal(entry.tier, "live");
      assert.deepEqual(entry.ids, registry.units[suite]?.live);
      assert.equal(entry.liveExemptReason, undefined);
    }
  }
});

test("resolveSuiteProfile: claude/codex map to live-exempt carrying the exact reason for fake-adapter, renderer, importer", () => {
  const registry = loadRegistry();
  const exemptUnits: Record<string, string> = {
    "fake-adapter":
      "the live tier invokes the installed authenticated CLIs (06-eval-suite.md:9); a scripted fake CLI cannot be a live subject",
    renderer:
      "BOARD.md is an operator-facing projection the runner never reads back (runner/test/board-render.test.ts:390), so no live scenario can observe it",
    importer:
      "no section 29.6 scenario imports a Markdown board; both implemented live fixtures construct board JSON directly",
  };

  for (const [suite, reason] of Object.entries(exemptUnits)) {
    for (const profile of ["claude", "codex"] as const) {
      const entry = resolveSuiteProfile(registry, suite, profile);
      assert.equal(entry.tier, "live-exempt");
      assert.deepEqual(entry.ids, []);
      assert.equal(entry.liveExemptReason, reason);
    }
  }
});

test("buildEvalCatalog: every suite carries all three profiles, matching resolveSuiteProfile pair by pair", () => {
  const registry = loadRegistry();
  const catalog = buildEvalCatalog(registry);

  assert.equal(catalog.length, SUITE_NAMES.length);
  for (const entry of catalog) {
    assert.ok(SUITE_NAMES.includes(entry.suite));
    for (const profile of PROFILE_IDS) {
      assert.deepEqual(entry.profiles[profile], resolveSuiteProfile(registry, entry.suite, profile));
    }
  }
});
