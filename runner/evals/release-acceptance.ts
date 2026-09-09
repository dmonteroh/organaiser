import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { DETERMINISTIC_FIXTURE_IDS, LIVE_SCENARIO_IDS } from "./registry-check.ts";
import { VENDOR_IDS } from "./compatibility-schema.ts";
import type { CompatibilityFile } from "./compatibility-schema.ts";

export class ReleaseAcceptanceTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseAcceptanceTableError";
  }
}

// Goals spec section 31's thirteen release conditions, transcribed verbatim
// (bullet text, leading "- " stripped) from
// tmp/eval/workflow-runner-goals-and-architecture.md:1324-1336.
export const SECTION_31_CONDITIONS: readonly string[] = [
  "A six-task fixture completes after the submitting client exits.",
  "A daemon restart causes no duplicate dispatch or lost result.",
  "Codex and Claude each complete the same single-task fixture.",
  "A worker final response cannot terminate a board run.",
  "Overlapping claims never execute concurrently.",
  "Every code change passes specification and quality review in order.",
  "Review retries use fresh sessions.",
  "A capped task parks while unrelated tasks continue.",
  "Destination movement cannot be overwritten.",
  "The operator's active checkout remains untouched.",
  "Every process, gate, integration, and cleanup has durable evidence.",
  "CI requires no vendor credentials.",
  "Live results record vendor, model, effort, CLI version, and workflow revision.",
];

export interface ReleaseAcceptanceCitation {
  kind: "deterministic" | "live";
  id: string;
}

export interface ReleaseAcceptanceCondition {
  line: number;
  text: string;
  citations: readonly ReleaseAcceptanceCitation[];
}

export interface ReleaseAcceptanceTable {
  schemaVersion: number;
  conditions: readonly ReleaseAcceptanceCondition[];
}

export interface ReleaseAcceptanceDeps {
  compatibility: CompatibilityFile;
  availableTestIds: ReadonlySet<string>;
  fixtureSource: string;
}

export interface ReleaseAcceptanceError {
  kind:
    | "row-count"
    | "row-numbering"
    | "condition-text-mismatch"
    | "row-no-citations"
    | "citation-unknown-kind"
    | "citation-unknown-id"
    | "citation-not-runnable"
    | "citation-live-success-missing";
  line: number | null;
  id: string | null;
  detail: string;
}

interface RawCitation {
  kind?: unknown;
  id?: unknown;
}

interface RawCondition {
  line?: unknown;
  text?: unknown;
  citations?: unknown;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function isRunnableDeterministic(id: string, deps: ReleaseAcceptanceDeps): boolean {
  if (deps.availableTestIds.has(id)) {
    return true;
  }
  return stripCommentLines(deps.fixtureSource).includes(`"${id}"`);
}

function hasBothVendorSuccess(id: string, compatibility: CompatibilityFile): boolean {
  const lastSuccessByVendor = compatibility.scenarios?.[id]?.lastSuccessByVendor ?? {};
  return VENDOR_IDS.every((vendor) => {
    const date = lastSuccessByVendor[vendor];
    return typeof date === "string" && DATE_PATTERN.test(date);
  });
}

export function validateReleaseAcceptance(
  table: unknown,
  deps: ReleaseAcceptanceDeps,
): ReleaseAcceptanceError[] {
  if (
    typeof table !== "object" ||
    table === null ||
    !("conditions" in table) ||
    !Array.isArray((table as { conditions: unknown }).conditions)
  ) {
    throw new ReleaseAcceptanceTableError(
      "release-acceptance table must be an object with a `conditions` array key",
    );
  }

  const conditions = (table as { conditions: unknown[] }).conditions;
  const errors: ReleaseAcceptanceError[] = [];

  if (conditions.length !== SECTION_31_CONDITIONS.length) {
    errors.push({
      kind: "row-count",
      line: null,
      id: null,
      detail: `release-acceptance table carries ${conditions.length} condition entries, expected exactly ${SECTION_31_CONDITIONS.length}`,
    });
  }

  conditions.forEach((rawCondition, index) => {
    const condition = (
      typeof rawCondition === "object" && rawCondition !== null ? rawCondition : {}
    ) as RawCondition;
    const expectedLine = index + 1;

    if (condition.line !== expectedLine) {
      errors.push({
        kind: "row-numbering",
        line: expectedLine,
        id: null,
        detail: `condition at position ${expectedLine} carries line ${JSON.stringify(condition.line)}, expected ${expectedLine}`,
      });
    }

    const expectedText = SECTION_31_CONDITIONS[index];
    if (expectedText !== undefined && condition.text !== expectedText) {
      errors.push({
        kind: "condition-text-mismatch",
        line: expectedLine,
        id: null,
        detail: `condition at position ${expectedLine} text does not match SECTION_31_CONDITIONS[${index}] verbatim`,
      });
    }

    const rawCitations = Array.isArray(condition.citations) ? condition.citations : [];
    if (rawCitations.length === 0) {
      errors.push({
        kind: "row-no-citations",
        line: expectedLine,
        id: null,
        detail: `condition at position ${expectedLine} carries no citations`,
      });
    }

    for (const rawCitation of rawCitations) {
      const citation = (
        typeof rawCitation === "object" && rawCitation !== null ? rawCitation : {}
      ) as RawCitation;
      const id = typeof citation.id === "string" ? citation.id : "";

      if (citation.kind !== "deterministic" && citation.kind !== "live") {
        errors.push({
          kind: "citation-unknown-kind",
          line: expectedLine,
          id: id.length > 0 ? id : null,
          detail: `condition at position ${expectedLine} carries a citation with kind ${JSON.stringify(citation.kind)}, expected "deterministic" or "live"`,
        });
        continue;
      }

      if (citation.kind === "deterministic") {
        if (!DETERMINISTIC_FIXTURE_IDS.has(id) && !deps.availableTestIds.has(id)) {
          errors.push({
            kind: "citation-unknown-id",
            line: expectedLine,
            id,
            detail: `condition at position ${expectedLine} cites deterministic id "${id}", which is neither a DETERMINISTIC_FIXTURE_IDS member nor a runner/test/*.test.ts basename`,
          });
          continue;
        }

        if (!isRunnableDeterministic(id, deps)) {
          errors.push({
            kind: "citation-not-runnable",
            line: expectedLine,
            id,
            detail: `condition at position ${expectedLine} cites deterministic id "${id}", which resolves to no runnable fixture or test file`,
          });
          continue;
        }
      } else {
        if (!LIVE_SCENARIO_IDS.has(id)) {
          errors.push({
            kind: "citation-unknown-id",
            line: expectedLine,
            id,
            detail: `condition at position ${expectedLine} cites live id "${id}", which is not a LIVE_SCENARIO_IDS member`,
          });
          continue;
        }

        if (!hasBothVendorSuccess(id, deps.compatibility)) {
          errors.push({
            kind: "citation-live-success-missing",
            line: expectedLine,
            id,
            detail: `condition at position ${expectedLine} cites live id "${id}", which has no recorded lastSuccessByVendor date for both "claude" and "codex"`,
          });
          continue;
        }
      }
    }
  });

  return errors;
}

const TABLE_PATH = fileURLToPath(new URL("./release-acceptance.json", import.meta.url));
const COMPATIBILITY_PATH = fileURLToPath(new URL("./compatibility.json", import.meta.url));
const FIXTURE_INVOCATIONS_PATH = fileURLToPath(new URL("./fixture-invocations.ts", import.meta.url));
const TEST_DIR = fileURLToPath(new URL("../test/", import.meta.url));

/** Reads and parses the sibling `release-acceptance.json`, a fixed, code-shipped asset, not user-supplied input. */
export function loadReleaseAcceptanceTable(): ReleaseAcceptanceTable {
  return JSON.parse(fs.readFileSync(TABLE_PATH, "utf8")) as ReleaseAcceptanceTable;
}

function loadCompatibility(): CompatibilityFile {
  return JSON.parse(fs.readFileSync(COMPATIBILITY_PATH, "utf8")) as CompatibilityFile;
}

function loadAvailableTestIds(): ReadonlySet<string> {
  const suffix = ".test.ts";
  const ids = fs
    .readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length));
  return new Set(ids);
}

function loadFixtureSource(): string {
  return fs.readFileSync(FIXTURE_INVOCATIONS_PATH, "utf8");
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

export function main(argv: readonly string[]): void {
  void argv;
  try {
    const table = loadReleaseAcceptanceTable();
    const deps: ReleaseAcceptanceDeps = {
      compatibility: loadCompatibility(),
      availableTestIds: loadAvailableTestIds(),
      fixtureSource: loadFixtureSource(),
    };
    const errors = validateReleaseAcceptance(table, deps);
    if (errors.length === 0) {
      process.exitCode = 0;
      return;
    }
    for (const error of errors) {
      const location = error.id
        ? `line ${String(error.line)}, id "${error.id}"`
        : `line ${String(error.line)}`;
      process.stderr.write(`${error.kind} (${location}): ${error.detail}\n`);
    }
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (isMainModule()) {
  main(process.argv);
}
