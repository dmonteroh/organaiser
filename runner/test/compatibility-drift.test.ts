import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkDrift,
  enumerateAdapterTable,
  type AdapterTableRow,
} from "../evals/compatibility-drift.ts";
import type { CompatibilityFile } from "../evals/compatibility-schema.ts";

const capturesRoot = fileURLToPath(new URL("../evals/captures/", import.meta.url));
const compatibilityPath = fileURLToPath(new URL("../evals/compatibility.json", import.meta.url));

function realCompatibility(): CompatibilityFile {
  return JSON.parse(fs.readFileSync(compatibilityPath, "utf8")) as CompatibilityFile;
}

function buildRow(overrides: Partial<AdapterTableRow> = {}): AdapterTableRow {
  return {
    vendor: "codex",
    cliVersion: "9.9.9",
    captureDate: "2026-01-01",
    captureDatesByCase: { "normal-success": "2026-01-01" },
    captureEvidence: "recorded",
    syntheticCases: [],
    ...overrides,
  };
}

function buildCompatibility(vendors: CompatibilityFile["vendors"]): CompatibilityFile {
  return {
    schemaVersion: 1,
    vendors,
    scenarios: {},
  };
}

test("compatibility-drift: the real captures tree and compatibility.json carry no drift", () => {
  const table = enumerateAdapterTable(capturesRoot);
  const errors = checkDrift(table, realCompatibility());
  assert.deepEqual(errors, []);
});

test("compatibility-drift: a table row absent from compatibility.json yields vendor-version-missing-from-compatibility", () => {
  const table = [buildRow({ vendor: "codex", cliVersion: "9.9.9" })];
  const errors = checkDrift(table, buildCompatibility({}));

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "vendor-version-missing-from-compatibility" &&
        error.vendor === "codex" &&
        error.cliVersion === "9.9.9",
    ),
  );
});

test("compatibility-drift: a compatibility.json vendor entry absent from the tree yields vendor-version-missing-from-tree", () => {
  const table: AdapterTableRow[] = [];
  const compatibility = buildCompatibility({
    codex: {
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
      captureEvidence: "recorded",
      syntheticCases: [],
    },
  });

  const errors = checkDrift(table, compatibility);

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "vendor-version-missing-from-tree" &&
        error.vendor === "codex" &&
        error.cliVersion === "9.9.9",
    ),
  );
});

test("compatibility-drift: a row/entry pair with differing captureEvidence yields capture-evidence-mismatch", () => {
  const table = [
    buildRow({
      vendor: "codex",
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
      captureEvidence: "recorded",
      syntheticCases: [],
    }),
  ];
  const compatibility = buildCompatibility({
    codex: {
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
      captureEvidence: "partially-synthesized",
      syntheticCases: [],
    },
  });

  const errors = checkDrift(table, compatibility);

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "capture-evidence-mismatch" &&
        error.vendor === "codex" &&
        error.cliVersion === "9.9.9",
    ),
  );
});

test("compatibility-drift: a row/entry pair with differing syntheticCases sets yields synthetic-cases-mismatch", () => {
  const table = [
    buildRow({
      vendor: "codex",
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
      captureEvidence: "partially-synthesized",
      syntheticCases: ["normal-success"],
    }),
  ];
  const compatibility = buildCompatibility({
    codex: {
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
      captureEvidence: "partially-synthesized",
      syntheticCases: ["rate-limit"],
    },
  });

  const errors = checkDrift(table, compatibility);

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "synthetic-cases-mismatch" &&
        error.vendor === "codex" &&
        error.cliVersion === "9.9.9",
    ),
  );
});

test("compatibility-drift: a compatibility.json entry naming a known-bad.json version yields known-bad-version-listed", () => {
  const table = [
    buildRow({
      vendor: "codex",
      cliVersion: "0.120.0",
      captureDate: "2026-01-01",
      captureEvidence: "recorded",
      syntheticCases: [],
    }),
  ];
  const compatibility = buildCompatibility({
    codex: {
      cliVersion: "0.120.0",
      captureDate: "2026-01-01",
      captureEvidence: "recorded",
      syntheticCases: [],
    },
  });

  const errors = checkDrift(table, compatibility);

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "known-bad-version-listed" &&
        error.vendor === "codex" &&
        error.cliVersion === "0.120.0",
    ),
  );
});

test("compatibility-drift: two present cases disagreeing on captureDate yields capture-date-inconsistent", () => {
  const table = [
    buildRow({
      vendor: "codex",
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
      captureDatesByCase: {
        "normal-success": "2026-01-01",
        "rate-limit": "2026-01-02",
      },
    }),
  ];

  const errors = checkDrift(table, buildCompatibility({}));

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "capture-date-inconsistent" &&
        error.vendor === "codex" &&
        error.cliVersion === "9.9.9",
    ),
  );
});

test("compatibility-drift: a row's captureDate disagreeing with compatibility.json's captureDate yields capture-date-mismatch", () => {
  const table = [
    buildRow({
      vendor: "codex",
      cliVersion: "9.9.9",
      captureDate: "2026-01-01",
    }),
  ];
  const compatibility = buildCompatibility({
    codex: {
      cliVersion: "9.9.9",
      captureDate: "2026-01-02",
      captureEvidence: "recorded",
      syntheticCases: [],
    },
  });

  const errors = checkDrift(table, compatibility);

  assert.ok(
    errors.some(
      (error) =>
        error.kind === "capture-date-mismatch" &&
        error.vendor === "codex" &&
        error.cliVersion === "9.9.9",
    ),
  );
});
