// Per-attempt worker artifact persistence: `dispatch-log.tsv` rows and the
// two reviewer report files, written under
// `<taskDir>/attempt<N>-artifacts/`. `N` is fixed once per `kind: agent`
// dispatch loop by a directory scan (`computeAttemptRound`), never derived
// from the DB-backed round counters `dispatch.ts` tracks per stage.

import fs from "node:fs";
import path from "node:path";

export type DispatchLogRole = "implementer" | "spec-reviewer" | "quality-reviewer";
export type ReviewerDispatchLogRole = "spec-reviewer" | "quality-reviewer";

// `development.v1.yaml`'s five `kind: agent` stage ids, mapped to the
// dispatch-log's own role vocabulary (`artifact-validator.ts`'s
// `DISPATCH_ROLES`) rather than the stage's own `role` field: `review-quality`
// declares `role: "code-quality-reviewer"`, which is not a member of that
// vocabulary.
export const STAGE_DISPATCH_LOG_ROLE: Readonly<Record<string, DispatchLogRole>> = {
  implement: "implementer",
  "fix-spec": "implementer",
  "fix-quality": "implementer",
  "review-spec": "spec-reviewer",
  "review-quality": "quality-reviewer",
};

export const SPEC_REVIEWER_REPORT_FILENAME = "spec-reviewer.report.txt";
export const QUALITY_REVIEWER_REPORT_FILENAME = "quality-reviewer.report.txt";

const REVIEWER_REPORT_FILENAMES: Readonly<Record<ReviewerDispatchLogRole, string>> = {
  "spec-reviewer": SPEC_REVIEWER_REPORT_FILENAME,
  "quality-reviewer": QUALITY_REVIEWER_REPORT_FILENAME,
};

const DISPATCH_LOG_HEADER = ["seq", "role", "reason", "commit_before", "commit_after", "packet_file", "report_file"];

function attemptDirPath(taskDir: string, attemptRound: number): string {
  return path.join(taskDir, `attempt${attemptRound}-artifacts`);
}

export function computeAttemptRound(taskDir: string): number {
  try {
    const entries = fs.readdirSync(taskDir, { withFileTypes: true });
    let highest = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^attempt(\d+)-artifacts$/.exec(entry.name);
      if (!match) continue;
      const n = Number(match[1]);
      if (n > highest) highest = n;
    }
    return highest + 1;
  } catch {
    return 1;
  }
}

function dataRowCount(dispatchLogFile: string): number {
  const text = fs.readFileSync(dispatchLogFile, "utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  return Math.max(lines.length - 1, 0);
}

export interface DispatchLogRowInput {
  role: DispatchLogRole;
  commitBefore: string;
  commitAfter: string;
  reportFile: string;
}

export function appendDispatchLogRow(taskDir: string, attemptRound: number, row: DispatchLogRowInput): void {
  const dir = attemptDirPath(taskDir, attemptRound);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "dispatch-log.tsv");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${DISPATCH_LOG_HEADER.join("\t")}\n`, "utf8");
  }
  const seq = dataRowCount(file) + 1;
  const cells = [String(seq), row.role, "", row.commitBefore, row.commitAfter, "", row.reportFile];
  fs.appendFileSync(file, `${cells.join("\t")}\n`, "utf8");
}

export function writeReviewerReport(
  taskDir: string,
  attemptRound: number,
  role: ReviewerDispatchLogRole,
  verdict: string,
): string {
  const dir = attemptDirPath(taskDir, attemptRound);
  fs.mkdirSync(dir, { recursive: true });
  const filename = REVIEWER_REPORT_FILENAMES[role];
  fs.writeFileSync(path.join(dir, filename), `Verdict: ${verdict}\n`, "utf8");
  return filename;
}
