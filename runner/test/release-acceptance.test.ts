import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SECTION_31_CONDITIONS,
  loadReleaseAcceptanceTable,
  validateReleaseAcceptance,
  type ReleaseAcceptanceDeps,
} from "../evals/release-acceptance.ts";
import { DETERMINISTIC_FIXTURE_IDS } from "../evals/registry-check.ts";
import { resolveInvocation, UnknownFixtureIdError } from "../evals/fixture-invocations.ts";
import type { CompatibilityFile } from "../evals/compatibility-schema.ts";

const EVALS_DIR = fileURLToPath(new URL("../evals/", import.meta.url));
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

function readAvailableTestIds(): ReadonlySet<string> {
  const suffix = ".test.ts";
  return new Set(
    fs
      .readdirSync(TEST_DIR)
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length)),
  );
}

function loadRealDeps(): ReleaseAcceptanceDeps {
  const compatibility = JSON.parse(
    fs.readFileSync(path.join(EVALS_DIR, "compatibility.json"), "utf8"),
  ) as CompatibilityFile;
  const fixtureSource = fs.readFileSync(path.join(EVALS_DIR, "fixture-invocations.ts"), "utf8");
  return {
    compatibility,
    availableTestIds: readAvailableTestIds(),
    fixtureSource,
  };
}

interface FixtureCitation {
  kind: string;
  id: string;
}

interface FixtureCondition {
  line: number;
  text: string;
  citations: FixtureCitation[];
}

interface FixtureTable {
  schemaVersion: number;
  conditions: FixtureCondition[];
}

function validBaseTable(): FixtureTable {
  return {
    schemaVersion: 1,
    conditions: SECTION_31_CONDITIONS.map((text, index) => ({
      line: index + 1,
      text,
      citations: [{ kind: "deterministic", id: "known-fixture" }],
    })),
  };
}

function validDeps(): ReleaseAcceptanceDeps {
  return {
    compatibility: {
      schemaVersion: 1,
      vendors: {},
      scenarios: {
        "live-single-task": {
          lastSuccessByVendor: { claude: "2026-01-01", codex: "2026-01-02" },
          observations: [],
        },
      },
    },
    availableTestIds: new Set(["known-fixture"]),
    fixtureSource: "",
  };
}

test("release-acceptance: SECTION_31_CONDITIONS is pinned to the goals spec's count", () => {
  assert.equal(SECTION_31_CONDITIONS.length, 13);
});

test("release-acceptance: injected-fixture error kinds", async (t) => {
  await t.test("row-count: fewer than thirteen conditions", () => {
    const table = validBaseTable();
    table.conditions = table.conditions.slice(0, 12);

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "row-count");
  });

  await t.test("row-numbering: a condition's line does not match its position", () => {
    const table = validBaseTable();
    const target = table.conditions[5];
    if (!target) throw new Error("fixture setup error");
    target.line = 99;

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "row-numbering");
    assert.equal(errors[0]?.line, 6);
  });

  await t.test("condition-text-mismatch: a condition's text differs from SECTION_31_CONDITIONS", () => {
    const table = validBaseTable();
    const target = table.conditions[3];
    if (!target) throw new Error("fixture setup error");
    target.text = "this is not the verbatim condition text";

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "condition-text-mismatch");
    assert.equal(errors[0]?.line, 4);
  });

  await t.test("row-no-citations: a condition carries an empty citations array", () => {
    const table = validBaseTable();
    const target = table.conditions[7];
    if (!target) throw new Error("fixture setup error");
    target.citations = [];

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "row-no-citations");
    assert.equal(errors[0]?.line, 8);
  });

  await t.test("citation-unknown-kind: a citation's kind is neither deterministic nor live", () => {
    const table = validBaseTable();
    const target = table.conditions[0];
    if (!target) throw new Error("fixture setup error");
    target.citations = [{ kind: "hearsay", id: "known-fixture" }];

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "citation-unknown-kind");
  });

  await t.test("citation-unknown-id: a deterministic id is not a fixture id or a test basename", () => {
    const table = validBaseTable();
    const target = table.conditions[0];
    if (!target) throw new Error("fixture setup error");
    target.citations = [{ kind: "deterministic", id: "no-such-fixture-anywhere" }];

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "citation-unknown-id");
  });

  await t.test("citation-unknown-id: a live id is not a LIVE_SCENARIO_IDS member", () => {
    const table = validBaseTable();
    const target = table.conditions[0];
    if (!target) throw new Error("fixture setup error");
    target.citations = [{ kind: "live", id: "live-nonexistent-scenario" }];

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "citation-unknown-id");
  });

  await t.test("citation-not-runnable: a reserved fixture id has no runnable backing", () => {
    const table = validBaseTable();
    const target = table.conditions[0];
    if (!target) throw new Error("fixture setup error");
    target.citations = [{ kind: "deterministic", id: "kill-without-supervisor" }];

    const errors = validateReleaseAcceptance(table, validDeps());

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "citation-not-runnable");
  });

  await t.test("citation-live-success-missing: a live id lacks a both-vendor success", () => {
    const table = validBaseTable();
    const target = table.conditions[0];
    if (!target) throw new Error("fixture setup error");
    target.citations = [{ kind: "live", id: "live-single-task" }];

    const deps = validDeps();
    deps.compatibility.scenarios = {
      "live-single-task": {
        lastSuccessByVendor: { claude: "2026-01-01" },
        observations: [],
      },
    };

    const errors = validateReleaseAcceptance(table, deps);

    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "citation-live-success-missing");
    assert.equal(errors[0]?.id, "live-single-task");
  });
});

// Reflects compatibility.json's current empty lastSuccessByVendor for both
// live-single-task and live-board-drain; shrink this list, never weaken the
// assertion, once a both-vendor success is recorded for either scenario.
const EXPECTED_LIVE_SUCCESS_MISSING: ReadonlyArray<{ line: number; id: string }> = [
  { line: 1, id: "live-board-drain" },
  { line: 3, id: "live-single-task" },
  { line: 13, id: "live-single-task" },
  { line: 13, id: "live-board-drain" },
];

const NON_LIVE_SUCCESS_KINDS: ReadonlySet<string> = new Set([
  "row-count",
  "row-numbering",
  "condition-text-mismatch",
  "row-no-citations",
  "citation-unknown-kind",
  "citation-unknown-id",
  "citation-not-runnable",
]);

test("release-acceptance: the real table", async (t) => {
  const table = loadReleaseAcceptanceTable();
  const deps = loadRealDeps();
  const errors = validateReleaseAcceptance(table, deps);

  await t.test("carries zero errors of the seven non-live-success kinds", () => {
    const offending = errors.filter((error) => NON_LIVE_SUCCESS_KINDS.has(error.kind));
    assert.deepEqual(offending, []);
  });

  await t.test("carries exactly the expected citation-live-success-missing errors", () => {
    const actual = errors
      .filter((error) => error.kind === "citation-live-success-missing")
      .map((error) => ({ line: error.line, id: error.id }));
    assert.deepEqual(actual, EXPECTED_LIVE_SUCCESS_MISSING);
  });
});

test("release-acceptance: the runnable oracle matches resolveInvocation for every DETERMINISTIC_FIXTURE_IDS entry", () => {
  const deps = loadRealDeps();

  for (const id of DETERMINISTIC_FIXTURE_IDS) {
    const table: FixtureTable = {
      schemaVersion: 1,
      conditions: [
        {
          line: 1,
          text: SECTION_31_CONDITIONS[0] ?? "",
          citations: [{ kind: "deterministic", id }],
        },
      ],
    };

    const errors = validateReleaseAcceptance(table, deps);
    const oracleRunnable = !errors.some((error) => error.kind === "citation-not-runnable");

    let resolvableRunnable = true;
    try {
      resolveInvocation("claude-adapter", "fake", id);
    } catch (err) {
      if (err instanceof UnknownFixtureIdError) {
        resolvableRunnable = false;
      } else {
        throw err;
      }
    }

    assert.equal(oracleRunnable, resolvableRunnable, `oracle/resolveInvocation disagreement for id "${id}"`);
  }
});
