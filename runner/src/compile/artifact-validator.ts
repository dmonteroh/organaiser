import { createHash } from "node:crypto";
import fs from "node:fs";

import { CANONICAL_CHECKS } from "./report-validator.ts";

// Artifact, role-binding, and dispatch-log validation. Proves a report's declared
// artifact paths exist, that each packet carries the exact role file and its hash,
// and that the dispatch count comes from the dispatch log rather than a
// self-reported count.
//
// Deliberately deferred (owned by the controller-config surface, not this module):
// worker-runtime recovery-policy drift; runtime family/model/effort drift; the
// rerun-commit-delta check.

export function fileSha256(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

const DISPATCH_HEADER_COLS = [
  "seq",
  "role",
  "reason",
  "commit_before",
  "commit_after",
  "packet_file",
  "report_file",
] as const;

const DISPATCH_ROLES = new Set(["implementer", "spec-reviewer", "quality-reviewer"]);

// The single dispatch-log failure reason that a verified no-op prior-attempt reuse
// legitimately produces (header present, zero worker rows). Exported so the reuse
// exemption in validateArtifacts matches it without a brittle duplicated literal; a
// malformed/unreadable log returns a DIFFERENT reason and stays a hard gap on reuse.
export const DISPATCH_LOG_EMPTY_REASON = "dispatch log is missing worker rows";

interface Result {
  ok: boolean;
  reason: string | null;
}

function ok(): Result {
  return { ok: true, reason: null };
}
function fail(reason: string): Result {
  return { ok: false, reason };
}

// The packet must reference the exact role file path, its exact sha256, and the
// role file's own first `#`-prefixed heading line (verbatim) — proof the full role
// payload was injected, not just a label. An implementer packet that declares the
// work was completed in a prior attempt may omit the role body.
export function validateRoleBinding(role: string, packetFile: string, roleFile: string): Result {
  let packet: string;
  try {
    packet = fs.readFileSync(packetFile, "utf8");
  } catch {
    return fail(`${role} packet is unreadable: ${packetFile}`);
  }

  let roleSha: string;
  try {
    roleSha = fileSha256(roleFile);
  } catch {
    return fail(`${role} role file is unreadable: ${roleFile}`);
  }
  if (!packet.includes(`Role file: ${roleFile}`) || !packet.includes(`Role sha256: ${roleSha}`)) {
    return fail(`${role} packet is missing role file/sha256 binding`);
  }

  const heading = firstHeadingLine(roleFile);
  if (heading && packet.includes(heading)) {
    return ok();
  }

  if (
    role === "implementer" &&
    /no implementer dispatch needed|implementation was completed (and committed )?in (prior )?attempt|attempt .* exists solely to produce review artifacts/i.test(
      packet,
    )
  ) {
    return ok();
  }

  return fail(`${role} packet is missing required role body content`);
}

// The bound role file's first line that starts with `#` (the whole line, verbatim).
// Returns null if the file is unreadable or has no `#`-prefixed line.
function firstHeadingLine(roleFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(roleFile, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#")) return line;
  }
  return null;
}

export interface DispatchLog {
  header: string[];
  rows: string[][];
}

// Parse a dispatch-log.tsv into header + data rows. Returns { header, rows } where
// rows are arrays of cell strings (preserving column count so format validation can
// detect a wrong column count).
export function readDispatchLog(file: string): DispatchLog | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  return {
    header: lines[0].split("\t"),
    rows: lines.slice(1).map((l) => l.split("\t")),
  };
}

export interface DispatchLogResult extends Result {
  dispatchCount: number;
}

// Derives the dispatch (worker-row) count from the row count rather than any
// self-reported total. The dispatch-limit comparison against a controller config
// value is the caller's job; this function only derives the authoritative count.
export function validateDispatchLog(file: string): DispatchLogResult {
  const parsed = readDispatchLog(file);
  if (parsed === null) {
    return { ...fail(`dispatch log is unreadable: ${file}`), dispatchCount: 0 };
  }
  const { header, rows } = parsed;

  const headerOk =
    header.length === DISPATCH_HEADER_COLS.length &&
    DISPATCH_HEADER_COLS.every((col, i) => header[i] === col);
  if (!headerOk) {
    return { ...fail("dispatch log header is invalid"), dispatchCount: 0 };
  }
  if (rows.length < 1) {
    return { ...fail(DISPATCH_LOG_EMPTY_REASON), dispatchCount: 0 };
  }
  for (const row of rows) {
    if (row.length !== DISPATCH_HEADER_COLS.length) {
      return { ...fail("dispatch log row has wrong column count"), dispatchCount: 0 };
    }
    if (!/^[0-9]+$/.test(row[0])) {
      return { ...fail(`dispatch log seq is not an integer: ${row[0]}`), dispatchCount: 0 };
    }
    if (!DISPATCH_ROLES.has(row[1])) {
      return { ...fail(`dispatch log role is invalid: ${row[1]}`), dispatchCount: 0 };
    }
  }

  return { ...ok(), dispatchCount: rows.length };
}

// Enforces that the reported VERIFICATION_MODE matches the task-declared mode, and
// that the field set present is coherent with that mode (coarse fields only in
// legacy mode, per-check fields only in declared mode).
export function validateVerificationFieldCoherence(
  contract: Record<string, unknown> | null | undefined,
  taskMode: string,
): Result {
  if (taskMode === "invalid-mixed") {
    return fail("task verification gate section is malformed (invalid-mixed mode)");
  }
  const reported = contract?.VERIFICATION_MODE;
  if (reported !== taskMode) {
    return fail(`VERIFICATION_MODE drifted from task-declared mode: ${reported ?? "<empty>"} vs ${taskMode}`);
  }
  const c = contract as Record<string, unknown>;

  if (taskMode === "declared") {
    if (c.TASK_VERIFY_STATUS !== undefined || c.FINAL_VERIFY_STATUS !== undefined) {
      return fail("coarse verification fields coexist with declared per-check mode (invalid-mixed)");
    }
    for (const id of CANONICAL_CHECKS) {
      const upper = id.toUpperCase();
      for (const prefix of ["TASK", "FINAL"]) {
        const field = `${prefix}_VERIFY_${upper}_STATUS`;
        const val = c[field];
        if (val === undefined) {
          return fail(`missing per-check field: ${field}`);
        }
        if (val !== "pass" && val !== "fail" && val !== "skipped") {
          return fail(`invalid value for ${field}: ${String(val)}`);
        }
      }
    }
    return ok();
  }

  for (const id of CANONICAL_CHECKS) {
    const upper = id.toUpperCase();
    if (c[`TASK_VERIFY_${upper}_STATUS`] !== undefined || c[`FINAL_VERIFY_${upper}_STATUS`] !== undefined) {
      return fail("per-check verification fields present without a declared gate section (invalid-mixed)");
    }
  }
  if (c.TASK_VERIFY_STATUS !== "pass") {
    return fail(`task verification status was not pass: ${c.TASK_VERIFY_STATUS ?? "<empty>"}`);
  }
  if (c.FINAL_VERIFY_STATUS !== "pass") {
    return fail(`final verification status was not pass: ${c.FINAL_VERIFY_STATUS ?? "<empty>"}`);
  }
  return ok();
}

export interface RoleFiles {
  implementer: string;
  specReviewer: string;
  qualityReviewer: string;
}

export interface ArtifactEvidence {
  packets: RoleFiles;
  reports: RoleFiles;
  transcripts?: Partial<RoleFiles>;
  dispatchLog: string;
}

export interface ValidateArtifactsInput {
  evidence: ArtifactEvidence;
  roles: RoleFiles;
  contract: Record<string, unknown> | null | undefined;
  taskMode: string;
  allowEmptyDispatchLog?: boolean;
}

export interface ValidateArtifactsResult {
  ok: boolean;
  gaps: string[];
  warnings: string[];
  dispatchCount: number;
}

// Composes path-existence, role-binding, dispatch-log, and field-coherence checks
// into one fact bundle: `gaps` are hard failures, `warnings` are advisory. Worker
// transcripts are advisory only: a missing or empty transcript for a dispatched
// role produces a warning, never a gap, and a role that was never dispatched is
// neither checked nor warned. `allowEmptyDispatchLog` exempts a header-only log
// only when the caller has already determined this attempt is a verified no-op
// prior-attempt reuse; a malformed or unreadable log still gates. Every path
// validated here is supplied by the caller — this function computes no root and
// reads no file outside the paths it is handed.
export function validateArtifacts({
  evidence,
  roles,
  contract,
  taskMode,
  allowEmptyDispatchLog = false,
}: ValidateArtifactsInput): ValidateArtifactsResult {
  const gaps: string[] = [];
  const warnings: string[] = [];

  const requiredFiles: Record<string, string | undefined> = {
    "implementer packet": evidence.packets.implementer,
    "implementer report": evidence.reports.implementer,
    "spec-reviewer packet": evidence.packets.specReviewer,
    "spec-reviewer report": evidence.reports.specReviewer,
    "quality-reviewer packet": evidence.packets.qualityReviewer,
    "quality-reviewer report": evidence.reports.qualityReviewer,
    "dispatch log": evidence.dispatchLog,
  };
  for (const [label, file] of Object.entries(requiredFiles)) {
    if (!file || !fs.existsSync(file)) {
      gaps.push(`artifact:missing:${label}`);
    }
  }

  const bindings: Array<[string, string, string]> = [
    ["implementer", evidence.packets.implementer, roles.implementer],
    ["spec-reviewer", evidence.packets.specReviewer, roles.specReviewer],
    ["quality-reviewer", evidence.packets.qualityReviewer, roles.qualityReviewer],
  ];
  for (const [role, packetFile, roleFile] of bindings) {
    if (packetFile && fs.existsSync(packetFile)) {
      const r = validateRoleBinding(role, packetFile, roleFile);
      if (!r.ok) gaps.push(`roleBinding:${role}:${r.reason}`);
    }
  }

  const dispatch = validateDispatchLog(evidence.dispatchLog);
  if (!dispatch.ok) {
    const emptyButValid = dispatch.reason === DISPATCH_LOG_EMPTY_REASON;
    if (!(allowEmptyDispatchLog && emptyButValid)) {
      gaps.push(`dispatchLog:${dispatch.reason}`);
    }
  }

  const dispatchedRoles = dispatchedRoleKeys(evidence.dispatchLog);
  const transcripts = evidence.transcripts ?? {};
  for (const [roleKey, label] of [
    ["implementer", "implementer"],
    ["specReviewer", "spec-reviewer"],
    ["qualityReviewer", "quality-reviewer"],
  ] as const) {
    if (!dispatchedRoles.has(roleKey)) continue;
    const file = transcripts[roleKey];
    if (!file || !fs.existsSync(file)) {
      warnings.push(`transcript:missing:${label}:${file ?? "<unset>"}`);
    } else if (fs.statSync(file).size === 0) {
      warnings.push(`transcript:empty:${label}:${file}`);
    }
  }

  const coherence = validateVerificationFieldCoherence(contract, taskMode);
  if (!coherence.ok) gaps.push(`verificationFields:${coherence.reason}`);

  return {
    ok: gaps.length === 0,
    gaps,
    warnings,
    dispatchCount: dispatch.dispatchCount,
  };
}

// Maps the dispatch-log's TSV role names to the evidence keys and returns the set
// of roles that were actually dispatched. Reads the SAME rows validateDispatchLog
// derives the count from; an unreadable log yields an empty set (nothing is
// checked/warned).
const DISPATCH_ROLE_TO_KEY: Record<string, keyof RoleFiles> = {
  implementer: "implementer",
  "spec-reviewer": "specReviewer",
  "quality-reviewer": "qualityReviewer",
};

function dispatchedRoleKeys(dispatchLogFile: string): Set<keyof RoleFiles> {
  const parsed = readDispatchLog(dispatchLogFile);
  const set = new Set<keyof RoleFiles>();
  if (parsed === null) return set;
  for (const row of parsed.rows) {
    const key = DISPATCH_ROLE_TO_KEY[row[1]];
    if (key) set.add(key);
  }
  return set;
}

export default validateArtifacts;
