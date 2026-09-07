// Per-task accreting evidence ledger.
//
// State is task-scoped, not attempt-scoped: evidence fields accrete across
// attempts, each recording the FIRST attempt that satisfied it plus the on-disk
// path. A predicate over the accreted `evidence` never looks at a single attempt
// dir, which is what lets a review pass from an early attempt and a later pass
// from a different reviewer jointly satisfy acceptance.
//
// This module owns ledger shape, accretion, and the invalidation-key rule. It
// performs no git or verification work; callers compute evidence facts and feed
// them in.

import fs from "node:fs";
import { createHash } from "node:crypto";

import { redactorForRoot } from "./redact.ts";

const LEDGER_FILENAME = "ledger.json";

// The accreting evidence fields. Each records the first satisfying attempt; the
// invalidation rule clears all of them together when any invalidation key changes.
export const EVIDENCE_KEYS = [
  "implementerCommits",
  "specReviewer",
  "qualityReviewer",
  "verification",
  "integrationCommit",
] as const;

export type EvidenceField = (typeof EVIDENCE_KEYS)[number];

export interface Evidence {
  implementerCommits: string[];
  specReviewer: unknown;
  qualityReviewer: unknown;
  verification: unknown;
  integrationCommit: unknown;
}

// The four keys whose drift invalidates accreted evidence: a change to any one
// means prior reviews/verifications ran against a stale input.
export interface InvalidationKeys {
  specSha256: string | null;
  workflowVersion: string | null;
  reviewedCommit: string | null;
  contextSnapshot: string | null;
}

export interface Ledger extends InvalidationKeys {
  taskId: string;
  specPath: string | null;
  verificationMode: string;
  attempts: unknown[];
  evidence: Evidence;
  state: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function emptyEvidence(): Evidence {
  return {
    implementerCommits: [],
    specReviewer: null,
    qualityReviewer: null,
    verification: null,
    integrationCommit: null,
  };
}

// Build a fresh ledger for a task. verificationMode is a fact derived by the
// caller from the spec's verification-gate section (legacy | declared).
export function createLedger({
  taskId,
  specPath,
  specSha256 = null,
  workflowVersion = null,
  reviewedCommit = null,
  contextSnapshot = null,
  verificationMode = "legacy",
}: {
  taskId: string;
  specPath: string | null;
  specSha256?: string | null;
  workflowVersion?: string | null;
  reviewedCommit?: string | null;
  contextSnapshot?: string | null;
  verificationMode?: string;
}): Ledger {
  return {
    taskId,
    specPath,
    specSha256: specSha256 ?? null,
    workflowVersion: workflowVersion ?? null,
    reviewedCommit: reviewedCommit ?? null,
    contextSnapshot: contextSnapshot ?? null,
    verificationMode,
    attempts: [],
    evidence: emptyEvidence(),
    state: "pending",
  };
}

/**
 * Append an attempt record to the ledger's attempts history.
 * Bookkeeping only — does NOT itself accrete evidence; callers accrete via
 * recordEvidence so the first-satisfier semantics are explicit.
 *
 * Mutates the passed ledger in place AND returns the same reference.
 * Callers must not assume immutability — the returned value is the same object.
 */
export function appendAttempt(ledger: Ledger, attempt: unknown): Ledger {
  ledger.attempts.push(attempt);
  return ledger;
}

/**
 * Accrete one evidence field, honoring first-satisfier semantics: once a field
 * is set it is NOT overwritten by a later attempt, so the recorded evidence
 * always points at the FIRST attempt that produced satisfying evidence.
 *
 * Mutates the passed ledger in place AND returns the same reference.
 * Callers must not assume immutability — the returned value is the same object.
 *
 * `field` is one of EVIDENCE_KEYS. `value` shape per field:
 *   implementerCommits: string[]  (accreted as a de-duplicated union — implementer
 *                                   commits can legitimately span attempts)
 *   specReviewer/qualityReviewer:  { verdict, report, attempt }
 *   verification:                  { status, mode, attempt[, claimsParity] }
 *   integrationCommit:             string (commit sha)
 */
export function recordEvidence(
  ledger: Ledger,
  field: EvidenceField,
  value: unknown,
): Ledger {
  if (!EVIDENCE_KEYS.includes(field)) {
    throw new Error(`unknown evidence field: ${field}`);
  }

  if (field === "implementerCommits") {
    const existing = ledger.evidence.implementerCommits;
    const incoming = Array.isArray(value) ? (value as string[]) : [];
    const merged = [...existing];
    for (const c of incoming) {
      if (c && !merged.includes(c)) merged.push(c);
    }
    ledger.evidence.implementerCommits = merged;
    return ledger;
  }

  // Scalar / object fields: first writer wins. A stored `false` or `0` still
  // counts as written, so the guard checks null/undefined explicitly rather
  // than falsiness.
  if (ledger.evidence[field] === null || ledger.evidence[field] === undefined) {
    ledger.evidence[field] = value;
  }
  return ledger;
}

// Invalidation: a change to any of the four keys means prior reviews/verifies
// ran against a now-stale input and can no longer be trusted, so accreted
// evidence is cleared and the new key set adopted. Attempts history is
// preserved for observability, but the evidence a predicate consumes is wiped.
// Returns true when invalidation fired.
export function applyInvalidationKeys(
  ledger: Ledger,
  keys: InvalidationKeys,
): boolean {
  const unchanged =
    ledger.specSha256 === keys.specSha256 &&
    ledger.workflowVersion === keys.workflowVersion &&
    ledger.reviewedCommit === keys.reviewedCommit &&
    ledger.contextSnapshot === keys.contextSnapshot;
  if (unchanged) return false;

  ledger.specSha256 = keys.specSha256;
  ledger.workflowVersion = keys.workflowVersion;
  ledger.reviewedCommit = keys.reviewedCommit;
  ledger.contextSnapshot = keys.contextSnapshot;
  ledger.evidence = emptyEvidence();
  ledger.state = "pending";
  return true;
}

export function ledgerPath(taskDir: string): string {
  return `${taskDir.replace(/\/$/, "")}/${LEDGER_FILENAME}`;
}

export function readLedger(taskDir: string): Ledger | null {
  const file = ledgerPath(taskDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
}

// Derives the project root from `taskDir` by taking the substring before its
// `/.orga/` segment; a `taskDir` carrying no such segment yields `undefined`,
// which `redactorForRoot` falls back on to the built-in pattern set.
function projectRootFromTaskDir(taskDir: string): string | undefined {
  const marker = "/.orga/";
  const idx = taskDir.indexOf(marker);
  return idx === -1 ? undefined : taskDir.slice(0, idx);
}

export function writeLedger(taskDir: string, ledger: Ledger): string {
  const file = ledgerPath(taskDir);
  const root = projectRootFromTaskDir(taskDir);
  const redacted = redactorForRoot(root, process.env)(JSON.stringify(ledger, null, 2));
  fs.writeFileSync(file, `${redacted}\n`, "utf8");
  return file;
}
