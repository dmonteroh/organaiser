import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_CLOSE,
  CONTRACT_OPEN,
  ContractError,
  extractContractText,
} from "../src/board/legacy-import.ts";

function legacyContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RESULT: "done",
    WORKER_DISPATCH_COUNT: 4,
    DISPATCH_LOG_FILE: "/run/dispatch-log.tsv",
    VERIFICATION_MODE: "legacy",
    SPEC_REVIEWER_VERDICT: "pass",
    QUALITY_REVIEWER_VERDICT: "pass",
    IMPLEMENTER_PACKET_FILE: "/run/implementer.packet.txt",
    IMPLEMENTER_REPORT_FILE: "/run/implementer.report.txt",
    IMPLEMENTER_TRANSCRIPT_FILE: "/run/implementer.transcript.txt",
    SPEC_REVIEWER_PACKET_FILE: "/run/spec-reviewer.packet.txt",
    SPEC_REVIEWER_REPORT_FILE: "/run/spec-reviewer.report.txt",
    SPEC_REVIEWER_TRANSCRIPT_FILE: "/run/spec-reviewer.transcript.txt",
    QUALITY_REVIEWER_PACKET_FILE: "/run/quality-reviewer.packet.txt",
    QUALITY_REVIEWER_REPORT_FILE: "/run/quality-reviewer.report.txt",
    QUALITY_REVIEWER_TRANSCRIPT_FILE: "/run/quality-reviewer.transcript.txt",
    INTEGRATION_COMMIT: "1ef1acf",
    SUMMARY: "gated reference + org-settings writes",
    TASK_VERIFY_STATUS: "pass",
    FINAL_VERIFY_STATUS: "pass",
    ...overrides,
  };
}

function wrap(obj: unknown, { prose = true }: { prose?: boolean } = {}): string {
  const json = JSON.stringify(obj, null, 2);
  if (!prose) return `${CONTRACT_OPEN}\n${json}\n${CONTRACT_CLOSE}`;
  return [
    "Orchestrator final report follows.",
    "Some prose, including the literal tokens in passing.",
    CONTRACT_OPEN,
    json,
    CONTRACT_CLOSE,
    "Trailing prose after the contract block.",
  ].join("\n");
}

test("extracts the JSON object between delimiters even surrounded by prose", () => {
  const obj = legacyContract();
  const text = extractContractText(wrap(obj));
  assert.deepEqual(JSON.parse(text), obj);
});

test("extractContractText succeeds with leading + trailing prose around the block", () => {
  const text = extractContractText(wrap(legacyContract(), { prose: true }));
  const contract = JSON.parse(text);
  assert.equal(contract.RESULT, "done");
});

test("missing open delimiter throws a precise ContractError", () => {
  assert.throws(
    () => extractContractText("no contract delimiter anywhere in this output"),
    (err: unknown) =>
      err instanceof ContractError && /missing contract open delimiter/.test(err.message),
  );
});

test("missing close delimiter throws a precise ContractError", () => {
  assert.throws(
    () => extractContractText(`${CONTRACT_OPEN}\n{"RESULT":"done"}`),
    (err: unknown) =>
      err instanceof ContractError && /missing contract close delimiter/.test(err.message),
  );
});

test("extraction succeeds even when the content between delimiters is not valid JSON (extraction is delimiter-only)", () => {
  const text = extractContractText(`${CONTRACT_OPEN}\n{ this is not json }\n${CONTRACT_CLOSE}`);
  assert.equal(text, "{ this is not json }");
});

test("non-string input throws a precise ContractError", () => {
  assert.throws(
    () => extractContractText(undefined),
    (err: unknown) =>
      err instanceof ContractError && /orchestrator output is not a string/.test(err.message),
  );
});

test("takes the last contract block when delimiter tokens appear earlier", () => {
  const real = legacyContract({ SUMMARY: "real one" });
  const noise = `Instructions mention ${CONTRACT_OPEN} and ${CONTRACT_CLOSE} as tokens.\n`;
  const text = extractContractText(noise + wrap(real, { prose: false }));
  assert.equal(JSON.parse(text).SUMMARY, "real one");
});
