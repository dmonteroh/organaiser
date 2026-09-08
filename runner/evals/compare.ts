import fs from "node:fs";
import path from "node:path";

import { compareIds } from "./grading-schema.ts";

export const DECLARED_VARIABLES = ["prompt", "workflowRevision", "cliVersion", "model", "resolvedConfig"] as const;
export type DeclaredVariable = (typeof DECLARED_VARIABLES)[number];

export type CompareCellOutcome = "pass" | "fail" | "not-applicable" | "operational-failure" | "ungraded";

export type CompareOutcome = "no-cells" | "no-matched-cells" | "single-variable" | "repeat" | "multi-variable";

export interface CompareRepeat {
  side: "left" | "right";
  cellId: string;
  outcome: CompareCellOutcome;
}

export interface CompareCellGroup {
  key: string;
  unstable: boolean;
  repeats: readonly CompareRepeat[];
}

export interface CompareResult {
  left: string;
  right: string;
  leftArtifactRoot: string;
  rightArtifactRoot: string;
  variedVariable: DeclaredVariable | null;
  variedVariables: readonly DeclaredVariable[];
  outcome: CompareOutcome;
  matchedKeys: number;
  unstableKeys: number;
  ungradedCells: number;
  leftOnlyKeys: readonly string[];
  rightOnlyKeys: readonly string[];
  cells: readonly CompareCellGroup[];
}

type SnapshotFieldName = "prompt" | "workflowRevision" | "cliVersion" | "model";

const SNAPSHOT_FIELDS: readonly SnapshotFieldName[] = ["prompt", "workflowRevision", "cliVersion", "model"];

const KNOWN_CELL_OUTCOMES = new Set<string>(["pass", "fail", "not-applicable", "operational-failure"]);

interface CellRecord {
  cellId: string;
  key: string;
  variables: Record<DeclaredVariable, string>;
  outcome: CompareCellOutcome;
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareIds);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cellKeyOf(basename: string): string {
  const match = /^(.*)--\d+$/.exec(basename);
  return match ? match[1] : basename;
}

function readProperty(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return undefined;
  return (value as Record<string, unknown>)[key];
}

function allFieldsAs(status: string): Record<SnapshotFieldName, string> {
  const result = {} as Record<SnapshotFieldName, string>;
  for (const field of SNAPSHOT_FIELDS) result[field] = status;
  return result;
}

function readEvalSnapshotVariables(cellDir: string): Record<SnapshotFieldName, string> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cellDir, "eval-snapshot.json"), "utf8");
  } catch {
    return allFieldsAs("missing");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return allFieldsAs("unparseable");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return allFieldsAs("unparseable");
  }

  const snapshot = (parsed as Record<string, unknown>).snapshot;
  const result = {} as Record<SnapshotFieldName, string>;
  for (const field of SNAPSHOT_FIELDS) {
    result[field] = `ok:${canonical(readProperty(snapshot, field))}`;
  }
  return result;
}

function readResolvedConfigVariable(cellDir: string): string {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cellDir, "resolved-config.json"), "utf8");
  } catch {
    return "missing";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unparseable";
  }
  return `ok:${canonical(parsed)}`;
}

function readCellOutcome(cellDir: string): CompareCellOutcome {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cellDir, "grading.json"), "utf8");
  } catch {
    return "ungraded";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "ungraded";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "ungraded";

  const outcome = (parsed as Record<string, unknown>).outcome;
  return typeof outcome === "string" && KNOWN_CELL_OUTCOMES.has(outcome) ? (outcome as CompareCellOutcome) : "ungraded";
}

function readCells(artifactRoot: string): CellRecord[] {
  let entries;
  try {
    entries = fs.readdirSync(artifactRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const cellIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareIds);

  return cellIds.map((cellId) => {
    const cellDir = path.join(artifactRoot, cellId);
    const snapshotVariables = readEvalSnapshotVariables(cellDir);
    const variables: Record<DeclaredVariable, string> = {
      prompt: snapshotVariables.prompt,
      workflowRevision: snapshotVariables.workflowRevision,
      cliVersion: snapshotVariables.cliVersion,
      model: snapshotVariables.model,
      resolvedConfig: readResolvedConfigVariable(cellDir),
    };
    return { cellId, key: cellKeyOf(cellId), variables, outcome: readCellOutcome(cellDir) };
  });
}

function groupByKey(cells: readonly CellRecord[]): Map<string, CellRecord[]> {
  const map = new Map<string, CellRecord[]>();
  for (const cell of cells) {
    const group = map.get(cell.key);
    if (group) group.push(cell);
    else map.set(cell.key, [cell]);
  }
  return map;
}

function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareIds);
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const PER_KEY_VARIABLES: readonly DeclaredVariable[] = ["workflowRevision", "cliVersion", "model", "resolvedConfig"];

export function compareEvalRuns(args: { root: string; leftEvalRunId: string; rightEvalRunId: string }): CompareResult {
  const { root, leftEvalRunId, rightEvalRunId } = args;
  const leftArtifactRoot = path.join(root, ".orga", "evals", leftEvalRunId);
  const rightArtifactRoot = path.join(root, ".orga", "evals", rightEvalRunId);

  const leftCells = readCells(leftArtifactRoot);
  const rightCells = readCells(rightArtifactRoot);

  const leftByKey = groupByKey(leftCells);
  const rightByKey = groupByKey(rightCells);

  const allKeys = distinctSorted([...leftByKey.keys(), ...rightByKey.keys()]);
  const matchedKeyList = allKeys.filter((key) => leftByKey.has(key) && rightByKey.has(key));
  const leftOnlyKeys = allKeys.filter((key) => leftByKey.has(key) && !rightByKey.has(key));
  const rightOnlyKeys = allKeys.filter((key) => !leftByKey.has(key) && rightByKey.has(key));

  const variedSet = new Set<DeclaredVariable>();

  for (const variable of PER_KEY_VARIABLES) {
    for (const key of matchedKeyList) {
      const leftValues = distinctSorted((leftByKey.get(key) ?? []).map((cell) => cell.variables[variable]));
      const rightValues = distinctSorted((rightByKey.get(key) ?? []).map((cell) => cell.variables[variable]));
      if (!arraysEqual(leftValues, rightValues)) {
        variedSet.add(variable);
        break;
      }
    }
  }

  const leftPrompts = distinctSorted(leftCells.map((cell) => cell.variables.prompt));
  const rightPrompts = distinctSorted(rightCells.map((cell) => cell.variables.prompt));
  if (!arraysEqual(leftPrompts, rightPrompts)) variedSet.add("prompt");

  const variedVariables = DECLARED_VARIABLES.filter((variable) => variedSet.has(variable));
  const variedVariable = variedVariables.length === 1 ? variedVariables[0] : null;

  const cells: CompareCellGroup[] = allKeys.map((key) => {
    const leftRepeats: CompareRepeat[] = (leftByKey.get(key) ?? [])
      .slice()
      .sort((a, b) => compareIds(a.cellId, b.cellId))
      .map((cell) => ({ side: "left" as const, cellId: cell.cellId, outcome: cell.outcome }));
    const rightRepeats: CompareRepeat[] = (rightByKey.get(key) ?? [])
      .slice()
      .sort((a, b) => compareIds(a.cellId, b.cellId))
      .map((cell) => ({ side: "right" as const, cellId: cell.cellId, outcome: cell.outcome }));
    const repeats = [...leftRepeats, ...rightRepeats];
    const distinctOutcomes = new Set(repeats.map((repeat) => repeat.outcome));
    return { key, unstable: distinctOutcomes.size > 1, repeats };
  });

  const unstableKeys = cells.filter((group) => group.unstable).length;
  const ungradedCells = cells.reduce(
    (count, group) => count + group.repeats.filter((repeat) => repeat.outcome === "ungraded").length,
    0,
  );

  const outcome: CompareOutcome =
    leftCells.length === 0 && rightCells.length === 0
      ? "no-cells"
      : matchedKeyList.length === 0
        ? "no-matched-cells"
        : variedVariables.length === 1
          ? "single-variable"
          : variedVariables.length === 0
            ? "repeat"
            : "multi-variable";

  return {
    left: leftEvalRunId,
    right: rightEvalRunId,
    leftArtifactRoot,
    rightArtifactRoot,
    variedVariable,
    variedVariables,
    outcome,
    matchedKeys: matchedKeyList.length,
    unstableKeys,
    ungradedCells,
    leftOnlyKeys,
    rightOnlyKeys,
    cells,
  };
}
