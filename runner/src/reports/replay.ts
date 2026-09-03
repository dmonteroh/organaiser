// Offline replay: reconstructs a per-task accreting ledger from a recorded run
// tree and resolves the git/fs facts the pure accept() predicate consumes.
// This is where all I/O lives: git reads, report file reads, and the tolerant
// verdict-regex pass-line re-check. accept() itself stays pure.
//
// Reconstruction reads dispatch-log.tsv per attempt to learn which commits and
// which reviewer reports each attempt produced, then accretes them
// first-satisfier: the earliest attempt whose dispatch log shows an
// implementer commit contributes implementerCommits; the earliest attempt
// with a pass-verdict spec-reviewer / quality-reviewer report contributes
// that reviewer. Reviewer reports are stored as run-relative ArtifactRefs so
// a saved run tree keeps resolving after its directory moves; a report_file
// column that already carries an absolute path cannot be expressed relative
// to the run root and is therefore treated as unresolvable rather than as a
// path to trust.

import fs from "node:fs";
import path from "node:path";

import { type ArtifactRef, makeArtifactRef, resolveArtifactRef } from "../store/artifact-ref.ts";
import { createLedger, recordEvidence, sha256, type Ledger } from "../store/evidence.ts";
import * as git from "../git/git.ts";
import type { Facts, ReviewerFacts, VerificationFacts, VerificationMode } from "../engine/predicates.ts";

const VERDICT_REGEX_SOURCE =
  "^[ \\t]*(#{1,6}[ \\t]*)?(\\*{0,2})?(final[ \\t]+)?verdict:(\\*{0,2})?[ \\t]*";

export function verdictRegex(expectedVerdict: string): RegExp {
  return new RegExp(`${VERDICT_REGEX_SOURCE}${expectedVerdict}\\b`, "im");
}

export function reportHasPassVerdict(reportFile: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(reportFile, "utf8");
  } catch {
    return false;
  }
  return verdictRegex("pass").test(text);
}

export interface DispatchLogRow {
  role?: string;
  commit_after?: string;
  report_file?: string;
  [column: string]: string | undefined;
}

export function parseDispatchLog(file: string): DispatchLogRow[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cols = line.split("\t");
    const row: DispatchLogRow = {};
    header.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function isRealCommit(sha: string | undefined): sha is string {
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha);
}

export function deriveImplementerCommits(rows: DispatchLogRow[]): string[] {
  return rows
    .filter((r) => r.role === "implementer" && isRealCommit(r.commit_after))
    .map((r) => r.commit_after as string);
}

export interface ReviewerEvidence {
  verdict: string;
  report: ArtifactRef;
  attempt: number;
}

// A report_file column value resolves against the attempt dir when relative;
// an absolute value cannot be made run-relative and is unresolvable, so it
// is never used, not even as a raw path. An empty/absent value falls back to
// the conventional filename.
function resolveReportPath(
  attemptDir: string,
  rawReportFile: string | undefined,
  conventionalName: string,
): string | null {
  const trimmed = rawReportFile?.trim();
  if (!trimmed) {
    return path.join(attemptDir, conventionalName);
  }
  if (path.isAbsolute(trimmed)) {
    return null;
  }
  return path.resolve(attemptDir, trimmed);
}

function recordReviewerEvidence(
  ledger: Ledger,
  field: "specReviewer" | "qualityReviewer",
  row: DispatchLogRow | undefined,
  attemptDir: string,
  runRoot: string,
  conventionalName: string,
  attempt: number,
): void {
  const reportPath = resolveReportPath(attemptDir, row?.report_file, conventionalName);
  if (!reportPath) return;
  if (!fs.existsSync(reportPath) || !reportHasPassVerdict(reportPath)) return;
  const report = makeArtifactRef(runRoot, reportPath);
  recordEvidence(ledger, field, { verdict: "pass", report, attempt });
}

export function reconstructLedger(
  taskDir: string,
  {
    taskId,
    specPath,
    verificationMode,
    integrationCommit,
    runRoot,
  }: {
    taskId: string;
    specPath: string | null;
    verificationMode: string;
    integrationCommit: string | null;
    runRoot: string;
  },
): Ledger {
  let specSha256: string | null = null;
  if (specPath) {
    try {
      specSha256 = sha256(fs.readFileSync(specPath, "utf8"));
    } catch {
      specSha256 = null;
    }
  }

  const ledger = createLedger({ taskId, specPath, specSha256, verificationMode });

  const attemptDirs = fs
    .readdirSync(taskDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^attempt\d+-artifacts$/.test(d.name))
    .map((d) => {
      const match = /^attempt(\d+)-artifacts$/.exec(d.name) as RegExpExecArray;
      return { n: Number(match[1]), dir: path.join(taskDir, d.name) };
    })
    .sort((a, b) => a.n - b.n);

  for (const { n, dir } of attemptDirs) {
    const rows = parseDispatchLog(path.join(dir, "dispatch-log.tsv"));

    const implementerCommits = deriveImplementerCommits(rows);
    if (implementerCommits.length > 0) {
      recordEvidence(ledger, "implementerCommits", implementerCommits);
    }

    const specReviewerRow = rows.find((r) => r.role === "spec-reviewer");
    recordReviewerEvidence(
      ledger,
      "specReviewer",
      specReviewerRow,
      dir,
      runRoot,
      "spec-reviewer.report.txt",
      n,
    );

    const qualityReviewerRow = rows.find((r) => r.role === "quality-reviewer");
    recordReviewerEvidence(
      ledger,
      "qualityReviewer",
      qualityReviewerRow,
      dir,
      runRoot,
      "quality-reviewer.report.txt",
      n,
    );
  }

  recordEvidence(ledger, "verification", { status: "pass", mode: verificationMode });
  if (integrationCommit) {
    recordEvidence(ledger, "integrationCommit", integrationCommit);
  }

  return ledger;
}

function buildReviewerFacts(
  reviewer: ReviewerEvidence | null,
  runRoot: string,
): ReviewerFacts | null {
  if (!reviewer) return null;
  const reportPath = resolveArtifactRef(runRoot, reviewer.report);
  return {
    verdict: reviewer.verdict,
    reportExists: fs.existsSync(reportPath),
    reportPassLine: reportHasPassVerdict(reportPath),
  };
}

export function buildFacts(
  ledger: Ledger,
  { cwd = process.cwd(), runRoot }: { cwd?: string; runRoot: string },
): Facts {
  const ev = ledger.evidence;

  const specReviewer = buildReviewerFacts(ev.specReviewer as ReviewerEvidence | null, runRoot);
  const qualityReviewer = buildReviewerFacts(ev.qualityReviewer as ReviewerEvidence | null, runRoot);

  const frontmatterStatus = ledger.specPath ? git.frontmatterStatus(ledger.specPath) : null;
  const integrationCommit = (ev.integrationCommit as string | null) ?? null;
  const integrationCommitExists = integrationCommit ? git.commitExists(integrationCommit, cwd) : false;
  const integrationCommitIsAncestor = integrationCommit
    ? git.isAncestor(integrationCommit, "HEAD", cwd)
    : false;
  const implementerCommits = ev.implementerCommits ?? [];

  return {
    verificationMode: ledger.verificationMode as VerificationMode,
    frontmatterStatus,
    integrationCommit,
    integrationCommitExists,
    integrationCommitIsAncestor,
    implementerCommits,
    implementerCommitsAllExist: implementerCommits.every((c) => git.commitExists(c, cwd)),
    reuseLanded:
      implementerCommits.length === 0 &&
      integrationCommitExists &&
      integrationCommitIsAncestor &&
      frontmatterStatus === "Done",
    specReviewer,
    qualityReviewer,
    verification: ev.verification as VerificationFacts | null,
  };
}
