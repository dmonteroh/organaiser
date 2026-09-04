// The six-condition classifier goals spec section 14 asks every vendor adapter to apply
// identically, mapped onto the section 27 failure-class enum. This module owns the total
// order and the reason accumulator; a vendor adapter only ever supplies `VendorSignals`.

import type { AttemptArtifacts, AttemptOutcome, FailureClass } from "./adapter.ts";
import { ReportValidationError, type ReportValidator } from "../compile/report-validator.ts";

/**
 * The four facts only a vendor adapter can observe (`permissionDenials`, `toolFailures`,
 * `vendorErrorClass`, `unknownEventTypes`) plus the two the substrate itself measures and
 * overwrites (`descendantsAlive`, `streamTruncated`). Every field MUST be derived from
 * parsed event object fields or process metadata; no field may be derived from a substring
 * search of prompt, stdout, or report text (target architecture section 15,
 * "structured-error-source").
 */
export interface VendorSignals {
  permissionDenials: readonly string[];
  toolFailures: readonly string[];
  vendorErrorClass: "authentication" | "rate-limit" | "provider-overload" | null;
  unknownEventTypes: readonly string[];
  streamTruncated: boolean;
  descendantsAlive: boolean;
}

function describeCandidateReport(
  candidateReportText: string,
  validator: ReportValidator,
): { validated: Record<string, unknown> } | { errorMessage: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateReportText);
  } catch (error) {
    return { errorMessage: `candidate report is not valid JSON: ${(error as Error).message}` };
  }
  try {
    return { validated: validator.validateObject(parsed) };
  } catch (error) {
    if (error instanceof ReportValidationError) {
      return { errorMessage: error.message };
    }
    throw error;
  }
}

/**
 * Applies the seven-step classification order verbatim, then appends the three
 * non-classifying detections. Every step's condition is evaluated independently of
 * whether an earlier step already decided the failure class, so `reason` names every
 * condition an attempt tripped, not only the one that won.
 */
export function classifyAttempt(
  artifacts: AttemptArtifacts,
  signals: VendorSignals,
  validator: ReportValidator,
): AttemptOutcome {
  const reasons: string[] = [];
  let failureClass: FailureClass | null = null;

  // Step 1: permission denials, whatever the exit code.
  if (signals.permissionDenials.length > 0) {
    reasons.push(`permission-denials=${signals.permissionDenials.length}`);
    failureClass ??= "permission-denied";
  }

  // Step 2: descendant processes outlived the attempt.
  if (signals.descendantsAlive) {
    reasons.push("descendants-alive");
    failureClass ??= "runner-invariant";
  }

  // Step 3: the vendor reported an authentication, rate-limit, or overload condition.
  if (signals.vendorErrorClass !== null) {
    reasons.push(`vendor-error-class=${signals.vendorErrorClass}`);
    failureClass ??= signals.vendorErrorClass;
  }

  const exitTokens: string[] = [];
  if (artifacts.exitCode !== null && artifacts.exitCode !== 0) exitTokens.push(`exit=${artifacts.exitCode}`);
  if (artifacts.signal !== null) exitTokens.push(`signal=${artifacts.signal}`);
  const exitedAbnormally = exitTokens.length > 0;

  let validatedReport: Record<string, unknown> | null = null;

  if (artifacts.candidateReportText === null) {
    // Step 4: no candidate report was ever produced.
    reasons.push("no-candidate-report");
    failureClass ??= exitedAbnormally ? "worker-crash" : "runner-invariant";
  } else {
    const described = describeCandidateReport(artifacts.candidateReportText, validator);
    if ("errorMessage" in described) {
      // Step 5: the candidate report was rejected by the validator.
      reasons.push(`schema-invalid: ${described.errorMessage}`);
      failureClass ??= "schema-invalid";
    } else if (exitedAbnormally) {
      // Step 6: a non-zero exit or a signal, with an otherwise valid report.
      reasons.push(...exitTokens);
      failureClass ??= "worker-crash";
    } else {
      // Step 7: nothing above fired; the attempt is clean.
      validatedReport = described.validated;
    }
  }

  // Steps 8 through 10: non-classifying detections, never interleaved with the above.
  if (signals.toolFailures.length > 0) reasons.push(`tool-failures=${signals.toolFailures.length}`);
  if (signals.unknownEventTypes.length > 0) reasons.push(`unknown-event-types=${signals.unknownEventTypes.length}`);
  if (signals.streamTruncated) reasons.push("stream-truncated");

  const ok = failureClass === null;
  return {
    ok,
    report: ok ? validatedReport : null,
    failureClass,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}
