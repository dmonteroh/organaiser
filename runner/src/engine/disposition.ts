// Pure disposition-recomputation predicates: recomputeDisposition(facts),
// compareDisposition(recomputed, stored), and deriveVerificationFact(attempts,
// verificationMode). This module is I/O-free: no filesystem, git, database, or
// child-process call happens here. It imports only types from barrier.ts and
// board-predicates.ts, never a runtime binding from either.

import { accept, type Facts, type VerificationMode } from "./predicates.ts";
import type { TerminalDisposition } from "./board-predicates.ts";
import type { BarrierAttemptRecord } from "./barrier.ts";

export interface RecomputedDisposition {
  state: "integrated" | "not-integrated";
  gaps: string[];
}

export function recomputeDisposition(facts: Facts): RecomputedDisposition {
  const result = accept(facts);
  if (result.state === "accepted") {
    return { state: "integrated", gaps: [] };
  }
  return { state: "not-integrated", gaps: result.gaps };
}

export type DispositionComparison = "agree" | "diverged" | "not-applicable";

export function compareDisposition(
  recomputed: RecomputedDisposition,
  stored: TerminalDisposition,
): DispositionComparison {
  if (stored !== "integrated") return "not-applicable";
  return recomputed.state === "integrated" ? "agree" : "diverged";
}

export interface LedgerVerificationFact {
  status: string;
  mode: VerificationMode;
  attempt: string;
  claimsParity?: boolean;
}

export function deriveVerificationFact(
  attempts: readonly BarrierAttemptRecord[],
  verificationMode: VerificationMode,
): LedgerVerificationFact | null {
  if (attempts.length === 0) return null;

  const record = attempts.find((a) => a.verdict === "pass") ?? attempts[attempts.length - 1];

  const fact: LedgerVerificationFact = {
    status: record.verdict,
    mode: verificationMode,
    attempt: record.attemptId,
  };
  if (record.claimsParity) {
    fact.claimsParity = record.claimsParity.parity;
  }
  return fact;
}
