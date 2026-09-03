// Pure acceptance predicate: accept(facts) -> { state, gaps }.
//
// This module is I/O-free: it performs no git, filesystem, or child-process
// calls. It reasons only over the `facts` object the caller assembled: every
// git read, file read, reviewer report pass-line re-check, and claims-parity
// computation happens in the caller and is passed in as an already-resolved
// value. The predicate consumes the re-checked booleans; it never re-opens a
// report itself.
//
// reportPassLine is the caller's tolerant verdict-regex re-check result. The
// predicate trusts neither the stored verdict alone nor the report alone: it
// requires the stored verdict to be "pass" AND the re-opened report to carry
// a pass line.

const ACCEPT_STATE = {
  accepted: "accepted",
  incomplete: "incomplete",
} as const;

export type AcceptState = (typeof ACCEPT_STATE)[keyof typeof ACCEPT_STATE];

const VERIFICATION_MODE = {
  legacy: "legacy",
  declared: "declared",
} as const;

export type VerificationMode = (typeof VERIFICATION_MODE)[keyof typeof VERIFICATION_MODE];

export interface ReviewerFacts {
  verdict: string;
  reportExists: boolean;
  reportPassLine: boolean;
}

export interface VerificationFacts {
  status: string;
  claimsParity?: boolean;
}

export interface Facts {
  verificationMode: VerificationMode;
  frontmatterStatus: string | null;
  integrationCommit: string | null;
  integrationCommitExists: boolean;
  integrationCommitIsAncestor: boolean;
  implementerCommits: string[];
  implementerCommitsAllExist: boolean;
  // Verified no-op reuse: the work already landed (integration commit is an
  // ancestor of HEAD, spec is Done) but this run dispatched no implementer, so
  // no implementer commits accreted. The landed integration commit is
  // strictly stronger proof of work than the per-attempt implementer-commit
  // list, so it satisfies that conjunct instead.
  reuseLanded: boolean;
  specReviewer: ReviewerFacts | null;
  qualityReviewer: ReviewerFacts | null;
  verification: VerificationFacts | null;
}

export interface AcceptResult {
  state: AcceptState;
  gaps: string[];
}

// Verify one reviewer conjunct, pushing precise gaps. Re-checked, not
// trusted: the stored verdict must be "pass" AND the caller's reopened-report
// pass-line boolean must hold.
function checkReviewer(
  role: "specReviewer" | "qualityReviewer",
  reviewer: ReviewerFacts | null,
  gaps: string[],
): void {
  if (!reviewer) {
    gaps.push(`${role}:missing`);
    return;
  }
  if (reviewer.verdict !== "pass") {
    gaps.push(`${role}:verdict`);
  }
  if (!reviewer.reportExists) {
    gaps.push(`${role}:reportMissing`);
  }
  if (!reviewer.reportPassLine) {
    gaps.push(`${role}:reportPassLine`);
  }
}

export function accept(facts: Facts): AcceptResult {
  const gaps: string[] = [];

  if (facts.frontmatterStatus !== "Done") {
    gaps.push("status");
  }

  if (!facts.integrationCommit) {
    gaps.push("integrationCommit:missing");
  } else {
    if (!facts.integrationCommitExists) {
      gaps.push("integrationCommit:notInRepo");
    }
    if (!facts.integrationCommitIsAncestor) {
      gaps.push("integrationCommit:notAncestor");
    }
  }

  if (facts.implementerCommits.length === 0) {
    if (!facts.reuseLanded) gaps.push("implementerCommits:empty");
  } else if (!facts.implementerCommitsAllExist) {
    gaps.push("implementerCommits:missingInRepo");
  }

  checkReviewer("specReviewer", facts.specReviewer, gaps);
  checkReviewer("qualityReviewer", facts.qualityReviewer, gaps);

  // legacy mode requires only verification.status == "pass" and imposes no
  // parity obligation; declared mode additionally requires the
  // caller-supplied claimsParity boolean.
  if (!facts.verification) {
    gaps.push("verification:missing");
  } else {
    if (facts.verification.status !== "pass") {
      gaps.push("verification:status");
    }
    if (facts.verificationMode === VERIFICATION_MODE.declared) {
      if (facts.verification.claimsParity !== true) {
        gaps.push("verification:claimsParity");
      }
    }
  }

  return {
    state: gaps.length === 0 ? ACCEPT_STATE.accepted : ACCEPT_STATE.incomplete,
    gaps,
  };
}
