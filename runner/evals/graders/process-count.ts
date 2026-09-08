import type { FrozenCellBundle, GradingCheck } from "./types.ts";

const ID = "process-count";

function build(outcome: GradingCheck["outcome"], detail: string | null): GradingCheck {
  return { id: ID, grader: "deterministic", outcome, detail };
}

export function gradeProcessCount(bundle: FrozenCellBundle): GradingCheck {
  const read = bundle.process;
  if (read.status === "missing") return build("operational-failure", "process.json is missing");
  if (read.status === "unparseable") return build("operational-failure", `process.json is unparseable: ${read.reason}`);

  const recordedPgids = read.value.recordedPgids;
  if (recordedPgids === null || recordedPgids === undefined || !Array.isArray(recordedPgids)) {
    return build("not-applicable", null);
  }

  const pid = read.value.pid ?? null;
  const seen = new Set<number>();
  const violations: string[] = [];

  recordedPgids.forEach((entry, index) => {
    if (typeof entry !== "number" || !Number.isInteger(entry)) {
      violations.push(`entry at index ${index} (${JSON.stringify(entry)}) is not an integer`);
      return;
    }
    if (entry <= 1) {
      violations.push(`entry at index ${index} (${entry}) is <= 1`);
      return;
    }
    if (pid !== null && entry === pid) {
      violations.push(`entry at index ${index} (${entry}) equals the cell's own pid ${pid}`);
    }
    if (seen.has(entry)) {
      violations.push(`entry at index ${index} (${entry}) is a duplicate`);
    } else {
      seen.add(entry);
    }
  });

  if (violations.length > 0) return build("fail", violations.join("\n"));
  return build("pass", null);
}
