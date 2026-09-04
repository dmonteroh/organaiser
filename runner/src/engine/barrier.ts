// The runner-owned verification barrier: the gate that decides whether a
// mutating attempt's work is accepted, run after that attempt's process has
// exited. Four conditions run in a fixed order with short-circuit — process
// exit, descendant liveness, required-artifact presence, then the declared
// checks — and only the barrier's own check results decide the verdict. A
// worker's self-reported claims are recorded for observability and diffed
// against the barrier's own results as advisory evidence; they never feed
// the verdict.
//
// Every run of this barrier appends one durable attempt record to the task's
// evidence ledger, on a pass and on a fail alike, so a failing attempt is not
// silently lost. Accreting that record into the ledger's evidence field is
// the caller's job, not this module's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { groupAlive } from "../adapters/process-group.ts";
import { ArtifactRefError, resolveArtifactRef } from "../store/artifact-ref.ts";
import {
  appendAttempt,
  createLedger,
  readLedger,
  writeLedger,
  type Ledger,
} from "../store/evidence.ts";
import {
  InvalidCheckError,
  computeClaimsParity,
  normalizeCheck,
  runChecks,
  writeClaimsTsv,
  type CheckStatus,
  type ClaimsParityResult,
  type VerificationCheck,
} from "./verification.ts";

export type BarrierCondition =
  | "process-exited"
  | "no-live-descendants"
  | "artifacts-present"
  | "checks-pass";

// The claimed status of each declared check, as self-reported by the worker.
// `verificationMode` selects how `computeClaimsParity` reads it; it defaults
// to "declared" whenever claims are supplied at all.
export interface WorkerClaims {
  checks: Record<string, string>;
  verificationMode?: string;
}

export interface BarrierInput {
  attemptId: string;
  taskId: string;
  taskDir: string;
  executionRoot: string;
  // The pgids recorded for this attempt. The first entry is the attempt's own
  // process group leader; any further entries are descendant groups spawned
  // during the attempt with their own group id. `no-live-descendants` checks
  // every entry; `process-exited` checks only the leader.
  pgids: readonly number[];
  // executionRoot-relative POSIX paths. Never absolute.
  requiredArtifacts: readonly string[];
  // Declared checks keyed by check id, in the shape `normalizeCheck` accepts:
  // either a bare command string or a check declaration object.
  checks: Record<string, unknown>;
  workerClaims?: WorkerClaims;
  env: NodeJS.ProcessEnv;
}

export type RunChecksResult = { checks: Record<string, CheckStatus>; overall: CheckStatus };

export interface BarrierAttemptRecord {
  attemptId: string;
  verdict: "pass" | "fail";
  failedCondition: BarrierCondition | null;
  checkResults: RunChecksResult | null;
  workerClaims: WorkerClaims | null;
  claimsParity: ClaimsParityResult | null;
  failureDetail: string | null;
  recordedAt: string;
}

export interface BarrierResult {
  verdict: "pass" | "fail";
  failedCondition: BarrierCondition | null;
  checkResults: RunChecksResult | null;
  evidence: BarrierAttemptRecord;
}

interface ConditionOutcome {
  ok: boolean;
  detail?: string;
}

function checkProcessExited(input: BarrierInput): ConditionOutcome {
  const leader = input.pgids[0];
  if (leader === undefined) return { ok: true };
  if (groupAlive(leader)) {
    return { ok: false, detail: `attempt process group ${leader} has not exited` };
  }
  return { ok: true };
}

function checkNoLiveDescendants(input: BarrierInput): ConditionOutcome {
  for (const pgid of input.pgids) {
    if (groupAlive(pgid)) {
      return { ok: false, detail: `process group ${pgid} still has a live member` };
    }
  }
  return { ok: true };
}

function checkArtifactsPresent(input: BarrierInput): ConditionOutcome {
  for (const relPath of input.requiredArtifacts) {
    let resolved: string;
    try {
      resolved = resolveArtifactRef(input.executionRoot, { path: relPath, sha256: "" });
    } catch (err) {
      if (err instanceof ArtifactRefError) {
        return { ok: false, detail: err.message };
      }
      throw err;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, detail: `required artifact is absent: ${relPath}` };
    }
    if (!stat.isFile()) {
      return { ok: false, detail: `required artifact is not a regular file: ${relPath}` };
    }
  }
  return { ok: true };
}

// Diff the worker's claimed statuses against the barrier's own check results.
// `computeClaimsParity` reads a report's TASK_VERIFY_/FINAL_VERIFY_ fields
// against a claims TSV, so the worker's claims and the barrier's own results
// are adapted into that shape through a short-lived temp file.
function computeWorkerClaimsParity(
  workerClaims: WorkerClaims,
  results: RunChecksResult,
): ClaimsParityResult {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "barrier-claims-"));
  try {
    const tsvPath = path.join(tmpDir, "verify.claims.tsv");
    writeClaimsTsv(tsvPath, results.checks);

    const report: Record<string, unknown> = {};
    for (const [id, status] of Object.entries(workerClaims.checks)) {
      const upper = id.toUpperCase();
      report[`TASK_VERIFY_${upper}_STATUS`] = status;
      report[`FINAL_VERIFY_${upper}_STATUS`] = status;
    }

    return computeClaimsParity(report, tsvPath, workerClaims.verificationMode ?? "declared");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface ChecksPassOutcome {
  ok: boolean;
  checkResults: RunChecksResult | null;
  claimsParity?: ClaimsParityResult;
  detail?: string;
}

async function checkChecksPass(input: BarrierInput): Promise<ChecksPassOutcome> {
  const normalized: VerificationCheck[] = [];
  for (const [id, declared] of Object.entries(input.checks)) {
    try {
      normalized.push(normalizeCheck(declared, id));
    } catch (err) {
      if (err instanceof InvalidCheckError) {
        return { ok: false, checkResults: null, detail: err.message };
      }
      throw err;
    }
  }

  const checkResults = await runChecks(normalized, { cwd: input.executionRoot, env: input.env });

  const claimsParity = input.workerClaims
    ? computeWorkerClaimsParity(input.workerClaims, checkResults)
    : undefined;

  return { ok: checkResults.overall === "pass", checkResults, claimsParity };
}

function recordAttempt(
  input: BarrierInput,
  verdict: "pass" | "fail",
  failedCondition: BarrierCondition | null,
  checkResults: RunChecksResult | null,
  claimsParity: ClaimsParityResult | undefined,
  failureDetail: string | undefined,
): BarrierAttemptRecord {
  return {
    attemptId: input.attemptId,
    verdict,
    failedCondition,
    checkResults,
    workerClaims: input.workerClaims ?? null,
    claimsParity: claimsParity ?? null,
    failureDetail: failureDetail ?? null,
    recordedAt: new Date().toISOString(),
  };
}

function appendToLedger(input: BarrierInput, record: BarrierAttemptRecord): void {
  const ledger: Ledger =
    readLedger(input.taskDir) ?? createLedger({ taskId: input.taskId, specPath: null });
  appendAttempt(ledger, record);
  writeLedger(input.taskDir, ledger);
}

export async function runVerificationBarrier(input: BarrierInput): Promise<BarrierResult> {
  let verdict: "pass" | "fail" = "pass";
  let failedCondition: BarrierCondition | null = null;
  let checkResults: RunChecksResult | null = null;
  let claimsParity: ClaimsParityResult | undefined;
  let failureDetail: string | undefined;

  const processExited = checkProcessExited(input);
  if (!processExited.ok) {
    verdict = "fail";
    failedCondition = "process-exited";
    failureDetail = processExited.detail;
  }

  if (verdict === "pass") {
    const noLiveDescendants = checkNoLiveDescendants(input);
    if (!noLiveDescendants.ok) {
      verdict = "fail";
      failedCondition = "no-live-descendants";
      failureDetail = noLiveDescendants.detail;
    }
  }

  if (verdict === "pass") {
    const artifactsPresent = checkArtifactsPresent(input);
    if (!artifactsPresent.ok) {
      verdict = "fail";
      failedCondition = "artifacts-present";
      failureDetail = artifactsPresent.detail;
    }
  }

  if (verdict === "pass") {
    const checksPass = await checkChecksPass(input);
    checkResults = checksPass.checkResults;
    claimsParity = checksPass.claimsParity;
    if (!checksPass.ok) {
      verdict = "fail";
      failedCondition = "checks-pass";
      failureDetail = checksPass.detail;
    }
  }

  const record = recordAttempt(input, verdict, failedCondition, checkResults, claimsParity, failureDetail);
  appendToLedger(input, record);

  return { verdict, failedCondition, checkResults, evidence: record };
}

// Pure predicate over an already-resolved barrier verdict: no filesystem or
// child-process call in its path. Suitable for the runner stages that gate on
// "did this task's checks pass" without re-running the barrier themselves.
export function taskChecksPass(facts: { verdict: "pass" | "fail" }): "true" | "false" {
  return facts.verdict === "pass" ? "true" : "false";
}
