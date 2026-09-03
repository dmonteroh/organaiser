// Declared-check execution and controller-owned claims parity.
//
// A verification check is either an argument-vector command (spawned directly,
// no shell) or an explicit shell command (spawned as '/bin/sh -c <command>').
// There is no third path: a bare command string is accepted only when it is
// free of shell metacharacters, in which case it is whitespace-split into an
// argv check. A string carrying a metacharacter is rejected outright rather
// than silently shell-split, because splitting it would hand the shell
// characters it was never meant to interpret.
//
// The claims-parity functions below re-run nothing themselves; they diff the
// caller's declared verdicts against a TSV the check runner already wrote from
// its own exit codes, so a self-reported status is never trusted on its own.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CANONICAL_CHECKS } from "../compile/report-validator.ts";

const STATUS = {
  pass: "pass",
  fail: "fail",
  skipped: "skipped",
} as const;

export type CheckStatus = (typeof STATUS)[keyof typeof STATUS];

const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const SHELL_METACHARACTERS = new Set([
  "|", "&", ";", "<", ">", "(", ")", "$", "`", '"', "'",
  "*", "?", "[", "]", "#", "~", "=", "%", "{", "}", "\\",
]);

export class InvalidCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCheckError";
  }
}

export interface ArgvCheck {
  id: string;
  argv: string[];
  cwd?: string;
  timeoutSecs?: number;
  shell?: false;
}

export interface ShellCheck {
  id: string;
  shell: true;
  command: string;
  cwd?: string;
  timeoutSecs?: number;
}

export type VerificationCheck = ArgvCheck | ShellCheck;

export interface CheckResult {
  id: string;
  status: CheckStatus;
  exitCode: number | null;
}

export interface RunContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function findMetacharacter(text: string): string | null {
  if (/[\r\n]/.test(text)) return "\n";
  for (const ch of text) {
    if (SHELL_METACHARACTERS.has(ch)) return ch;
  }
  return null;
}

// Accepts a declared check object unchanged (after validating its shape), or
// a bare command string, which is rejected unless it is free of shell
// metacharacters and then whitespace-split into an argv check. `id` is used
// only for the bare-string form; an object form always carries its own `id`.
export function normalizeCheck(input: unknown, id?: string): VerificationCheck {
  if (typeof input === "string") {
    const offending = findMetacharacter(input);
    if (offending !== null) {
      throw new InvalidCheckError(
        `check command contains shell metacharacter ${JSON.stringify(offending)}; declare it as an explicit { shell: true, command } check instead`,
      );
    }
    const argv = input.split(/\s+/).filter((token) => token.length > 0);
    return normalizeCheck({ id, argv });
  }

  if (typeof input !== "object" || input === null) {
    throw new InvalidCheckError("check must be an object or a bare command string");
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.id !== "string" || raw.id.length === 0) {
    throw new InvalidCheckError("check is missing a required id");
  }
  if (!CHECK_ID_PATTERN.test(raw.id)) {
    throw new InvalidCheckError(
      `check id ${JSON.stringify(raw.id)} does not match ${CHECK_ID_PATTERN}`,
    );
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || path.isAbsolute(raw.cwd))) {
    throw new InvalidCheckError(`check ${raw.id} cwd must be a relative path`);
  }

  if (raw.shell === true) {
    if (raw.argv !== undefined) {
      throw new InvalidCheckError(`check ${raw.id} cannot combine shell: true with argv`);
    }
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      throw new InvalidCheckError(`check ${raw.id} with shell: true requires a non-empty command`);
    }
    return input as ShellCheck;
  }

  if (
    !Array.isArray(raw.argv) ||
    raw.argv.length === 0 ||
    raw.argv.some((entry) => typeof entry !== "string")
  ) {
    throw new InvalidCheckError(`check ${raw.id} requires a non-empty argv array of strings`);
  }
  return input as ArgvCheck;
}

function resolveCwd(ctx: RunContext, check: VerificationCheck): string {
  return check.cwd ? path.resolve(ctx.cwd, check.cwd) : ctx.cwd;
}

function execFileAsync(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile(file, args, { ...options, encoding: "utf8" }, (error) => {
      if (!error) {
        resolve({ exitCode: 0 });
        return;
      }
      const code = error.code;
      resolve({ exitCode: typeof code === "number" ? code : null });
    });
  });
}

// Run one declared check and classify its exit code: a clean exit is `pass`,
// any non-zero exit or spawn error is `fail`, and an absent check (undefined)
// or one whose declared value is the literal `"skipped"` runs nothing and is
// recorded as `skipped`. An argv check is spawned directly with no shell; a
// `shell: true` check is spawned as `/bin/sh -c <command>` and nothing else,
// so a shell only ever interprets a command the caller explicitly opted in.
export async function runCheck(
  id: string,
  check: VerificationCheck | "skipped" | undefined,
  ctx: RunContext,
): Promise<CheckResult> {
  if (!check || check === "skipped") {
    return { id, status: STATUS.skipped, exitCode: null };
  }

  const cwd = resolveCwd(ctx, check);
  const options: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number } = {
    cwd,
    env: ctx.env,
  };
  if (check.timeoutSecs !== undefined) options.timeout = check.timeoutSecs * 1000;

  const { exitCode } =
    check.shell === true
      ? await execFileAsync("/bin/sh", ["-c", check.command], options)
      : await execFileAsync(check.argv[0], check.argv.slice(1), options);

  return { id, status: exitCode === 0 ? STATUS.pass : STATUS.fail, exitCode };
}

// Run a declared list of normalized checks in order and produce the
// controller-owned claims: { checks: { <id>: status }, overall }. `overall` is
// `fail` when any check failed. This iterates exactly the checks it was
// given, never the legacy canonical four.
export async function runChecks(
  checks: VerificationCheck[],
  ctx: RunContext,
): Promise<{ checks: Record<string, CheckStatus>; overall: CheckStatus }> {
  const results: Record<string, CheckStatus> = {};
  let overall: CheckStatus = STATUS.pass;
  for (const check of checks) {
    const { status } = await runCheck(check.id, check, ctx);
    results[check.id] = status;
    if (status === STATUS.fail) overall = STATUS.fail;
  }
  return { checks: results, overall };
}

// Serialize the controller's own claims for the legacy canonical four checks
// to the `scope check_id status source` TSV format.
export function writeClaimsTsv(
  file: string,
  checks: Record<string, string>,
  sources: Record<string, string> = {},
): string {
  const lines = ["scope\tcheck_id\tstatus\tsource"];
  for (const id of CANONICAL_CHECKS) {
    const status = checks[id] ?? "skipped";
    const source = sources[id] ?? status;
    lines.push(`task\t${id}\t${status}\t${source}`);
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

// Parse a claims TSV into a { check_id: status } map. The header row (scope
// == "scope") is skipped; a later row for the same check id overwrites an
// earlier one. Returns null when the file cannot be read.
export function parseClaimsTsv(file: string): Record<string, string> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const status: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const cols = line.split("\t");
    const [scope, checkId, stat] = cols;
    if (scope === "scope") continue;
    if (checkId) status[checkId] = stat ?? "";
  }
  return status;
}

export interface ClaimsParityResult {
  parity: boolean;
  mode: string;
  mismatches: string[];
}

// Diff a declared-mode report's self-reported per-check statuses against the
// controller-written claims TSV, so a report field is never trusted alone.
// `legacy` imposes no parity obligation. `declared` requires the report's
// TASK_VERIFY_<CHECK>_STATUS and FINAL_VERIFY_<CHECK>_STATUS to both match the
// TSV evidence for every canonical check; a missing TSV or a missing per-check
// row is itself a mismatch. Any other mode is invalid-mixed and rejected.
export function computeClaimsParity(
  report: Record<string, unknown> | null,
  claimsTsvPath: string,
  verificationMode: string,
): ClaimsParityResult {
  if (verificationMode === "legacy") {
    return { parity: true, mode: "legacy", mismatches: [] };
  }
  if (verificationMode !== "declared") {
    return {
      parity: false,
      mode: verificationMode,
      mismatches: ["verification gate section is invalid-mixed; parity cannot proceed"],
    };
  }

  const mismatches: string[] = [];
  const tsv = parseClaimsTsv(claimsTsvPath);
  if (tsv === null) {
    return {
      parity: false,
      mode: "declared",
      mismatches: [`controller verification claims TSV is missing: ${claimsTsvPath ?? "<empty>"}`],
    };
  }

  for (const id of CANONICAL_CHECKS) {
    const upper = id.toUpperCase();
    const taskClaimed = report?.[`TASK_VERIFY_${upper}_STATUS`];
    const finalClaimed = report?.[`FINAL_VERIFY_${upper}_STATUS`];
    const evidence = tsv[id];
    if (evidence === undefined || evidence === "") {
      mismatches.push(`controller TSV missing evidence for check: ${id}`);
      continue;
    }
    if (taskClaimed !== evidence) {
      mismatches.push(
        `claim mismatch for ${id}: TASK_VERIFY_${upper}_STATUS=${taskClaimed ?? "<empty>"} but controller evidence=${evidence}`,
      );
    }
    if (finalClaimed !== evidence) {
      mismatches.push(
        `claim mismatch for ${id}: FINAL_VERIFY_${upper}_STATUS=${finalClaimed ?? "<empty>"} but controller evidence=${evidence}`,
      );
    }
  }

  return { parity: mismatches.length === 0, mode: "declared", mismatches };
}
