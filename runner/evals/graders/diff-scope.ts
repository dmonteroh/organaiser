import type { YamlMapping } from "../../src/cli/yaml.ts";
import type { FrozenCellBundle, GradingCheck } from "./types.ts";

const ID = "diff-scope";
const DIFF_HEADER_PREFIX = "diff --git ";
const B_MARKER = " b/";

function build(outcome: GradingCheck["outcome"], detail: string | null): GradingCheck {
  return { id: ID, grader: "deterministic", outcome, detail };
}

function tasksOf(mapping: YamlMapping): YamlMapping[] {
  const tasks = mapping.tasks;
  if (!Array.isArray(tasks)) return [];
  const result: YamlMapping[] = [];
  for (const task of tasks) {
    if (typeof task === "object" && task !== null && !Array.isArray(task)) {
      result.push(task as YamlMapping);
    }
  }
  return result;
}

function claimEntriesOf(mapping: YamlMapping): string[] {
  const claims: string[] = [];
  for (const task of tasksOf(mapping)) {
    const value = task.claims;
    if (typeof value === "string") {
      if (value.length > 0) claims.push(value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.length > 0) claims.push(entry);
      }
    }
  }
  return claims;
}

function extractTouchedPaths(diffText: string): string[] {
  const touched: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      touched.push(candidate);
    }
  };

  for (const line of diffText.split("\n")) {
    if (!line.startsWith(DIFF_HEADER_PREFIX)) continue;
    const remainder = line.slice(DIFF_HEADER_PREFIX.length);
    const markerIndex = remainder.lastIndexOf(B_MARKER);
    if (markerIndex === -1) continue;
    const left = remainder.slice(0, markerIndex);
    const right = remainder.slice(markerIndex + B_MARKER.length);
    const oldPath = left.startsWith("a/") ? left.slice(2) : left;
    add(oldPath);
    add(right);
  }
  return touched;
}

function isCovered(touchedPath: string, claims: readonly string[]): boolean {
  for (const claim of claims) {
    if (claim === touchedPath) return true;
    if (claim.endsWith("/**") && touchedPath.startsWith(claim.slice(0, -3))) return true;
    if (claim.endsWith("/") && touchedPath.startsWith(claim)) return true;
  }
  return false;
}

export function gradeDiffScope(bundle: FrozenCellBundle): GradingCheck {
  if (bundle.diff.status === "missing") return build("operational-failure", "diff.patch is missing");
  if (bundle.diff.status === "unparseable") return build("operational-failure", `diff.patch is unparseable: ${bundle.diff.reason}`);
  if (bundle.boardAfter.status === "missing") return build("operational-failure", "board-after.yaml is missing");
  if (bundle.boardAfter.status === "unparseable") {
    return build("operational-failure", `board-after.yaml is unparseable: ${bundle.boardAfter.reason}`);
  }
  if (bundle.boardBefore.status === "missing") return build("operational-failure", "board-before.yaml is missing");
  if (bundle.boardBefore.status === "unparseable") {
    return build("operational-failure", `board-before.yaml is unparseable: ${bundle.boardBefore.reason}`);
  }

  let claims = claimEntriesOf(bundle.boardAfter.value);
  if (claims.length === 0) claims = claimEntriesOf(bundle.boardBefore.value);
  if (claims.length === 0) return build("not-applicable", null);

  const touched = extractTouchedPaths(bundle.diff.value);
  const violations = touched
    .filter((touchedPath) => !isCovered(touchedPath, claims))
    .map((touchedPath) => `touched path "${touchedPath}" is not covered by any claim`);

  if (violations.length > 0) return build("fail", violations.join("\n"));
  return build("pass", null);
}
