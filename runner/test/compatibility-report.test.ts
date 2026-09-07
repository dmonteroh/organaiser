import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { renderCompatibilityReport } from "../evals/compatibility-report.ts";
import type { CompatibilityFile } from "../evals/compatibility-schema.ts";

const compatibilityPath = fileURLToPath(new URL("../evals/compatibility.json", import.meta.url));

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]+/,
  /ghp_[A-Za-z0-9]+/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
  /\/(?:Users|home)\/[^/\s]+/,
];
const OAUTH_FIELD_NAMES = ["access_token", "refresh_token", "id_token", "account_id"];

function assertNoPlantedSecret(text: string): void {
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(!pattern.test(text), `output carries a planted secret shape: ${pattern}`);
  }
  for (const field of OAUTH_FIELD_NAMES) {
    assert.ok(!text.includes(field), `output carries the OAuth field name "${field}"`);
  }
}

function baseCompatibility(): CompatibilityFile {
  return {
    schemaVersion: 1,
    vendors: {
      claude: {
        cliVersion: "1.2.3",
        captureDate: "2026-08-01",
        captureEvidence: "recorded",
        syntheticCases: [],
      },
    },
    scenarios: {},
  };
}

test("compatibility-report: redacts every planted secret shape and picks the tie-break winner", () => {
  const data = baseCompatibility();
  data.scenarios["live-single-task"] = {
    lastSuccessByVendor: {},
    observations: [
      {
        vendor: "claude",
        date: "2026-09-01",
        cliVersion: null,
        model: null,
        outcome: "failed",
        restingRunState: "failed",
        detail: "attempt one failed cleanly",
        evidenceRef: "runner/evals/fixtures/x.ts#L1",
      },
      {
        vendor: "claude",
        date: "2026-09-01",
        cliVersion: null,
        model: null,
        outcome: "blocked",
        restingRunState: "blocked",
        detail:
          "attempt two sk-aaaaaaaaaaaa1111 Bearer zzzYYY111token ghp_1234567890ab " +
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U " +
          "access_token refresh_token id_token account_id",
        evidenceRef: "runner/evals/fixtures/x.ts#L2 near /Users/alice/secret-project",
      },
    ],
  };

  const output = renderCompatibilityReport(data);
  const lines = output.split("\n");
  const row = lines.find((line) => line.includes("live-single-task") && line.includes("`claude`"));

  assert.ok(row, "expected a row for the live-single-task/claude cell");
  assert.ok(row!.includes("outcome=blocked"), "expected the later-appended observation to win the tie-break");
  assert.ok(!row!.includes("outcome=failed"), "the earlier observation must not appear");
  assert.ok(row!.includes("[REDACTED]"), "expected redaction to have fired");
  assertNoPlantedSecret(output);
});

test("compatibility-report: a partially-synthesized vendor states so and names its syntheticCases; an absent vendor renders no row", () => {
  const data = baseCompatibility();
  data.vendors = {
    codex: {
      cliVersion: "0.46.0",
      captureDate: "2026-09-04",
      captureEvidence: "partially-synthesized",
      syntheticCases: ["case-a", "case-b"],
    },
  };

  const output = renderCompatibilityReport(data);
  const lines = output.split("\n");

  const codexRow = lines.find((line) => line.startsWith("- `codex`:"));
  assert.ok(codexRow, "expected a vendor row for codex");
  assert.ok(codexRow!.includes("partially-synthesized"));
  assert.ok(codexRow!.includes("case-a"));
  assert.ok(codexRow!.includes("case-b"));

  assert.ok(
    !lines.some((line) => line.startsWith("- `claude`:")),
    "claude is absent from data.vendors and must render no row",
  );
});

test("compatibility-report: a canonical scenario id absent from data.scenarios renders never-attempted for every vendor", () => {
  const data = baseCompatibility();
  data.vendors.codex = {
    cliVersion: "0.46.0",
    captureDate: "2026-09-04",
    captureEvidence: "recorded",
    syntheticCases: [],
  };

  const output = renderCompatibilityReport(data);
  const lines = output.split("\n");

  const claudeRow = lines.find(
    (line) => line.includes("live-vendor-parity") && line.includes("`claude`"),
  );
  const codexRow = lines.find(
    (line) => line.includes("live-vendor-parity") && line.includes("`codex`"),
  );

  assert.ok(claudeRow?.includes("never-attempted"));
  assert.ok(codexRow?.includes("never-attempted"));
});

test("compatibility-report: a live-verified success cell carries the date and no other observation field", () => {
  const data = baseCompatibility();
  data.scenarios["live-single-task"] = {
    lastSuccessByVendor: { claude: "2026-08-15" },
    observations: [
      {
        vendor: "claude",
        date: "2026-08-15",
        cliVersion: "1.2.3",
        model: "some-model",
        outcome: "succeeded",
        restingRunState: "succeeded",
        detail: "clean run",
        evidenceRef: "runner/evals/fixtures/x.ts#L9",
      },
    ],
  };

  const output = renderCompatibilityReport(data);
  const lines = output.split("\n");
  const row = lines.find((line) => line.includes("live-single-task") && line.includes("`claude`"));

  assert.ok(row);
  assert.ok(row!.includes("live-verified success on 2026-08-15"));
  assert.ok(!row!.includes("outcome="));
  assert.ok(!row!.includes("restingRunState="));
  assert.ok(!row!.includes("detail="));
  assert.ok(!row!.includes("evidenceRef="));
});

test("compatibility-report: renders the real compatibility.json without throwing and with no planted-secret shape", () => {
  const data = JSON.parse(fs.readFileSync(compatibilityPath, "utf8")) as CompatibilityFile;

  const output = renderCompatibilityReport(data);

  assert.ok(output.length > 0);
  assertNoPlantedSecret(output);
});
