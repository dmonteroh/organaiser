import { execFileSync } from "node:child_process";

import type { WorkspaceHandle } from "./workspace.ts";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function splitPaths(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Reads the paths an attempt actually touched in its worktree: everything
// changed relative to the recorded base commit, plus everything untracked.
export async function observedPaths(handle: WorkspaceHandle): Promise<string[]> {
  const changed = git(["diff", "--name-only", handle.baseCommit], handle.path);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], handle.path);

  const paths = new Set<string>([...splitPaths(changed), ...splitPaths(untracked)]);
  return [...paths];
}

export interface ValidateClaimsInput {
  observed: string[];
  claimed: string[];
  recordedDirt: string[];
}

export interface ValidateClaimsResult {
  ok: boolean;
  outOfClaim: string[];
}

// Pure comparison: no I/O, no shared state with observedPaths. Paths already
// dirty before the attempt started are subtracted from what it observed
// before checking the remainder against the declared claim set.
export function validateClaims({
  observed,
  claimed,
  recordedDirt,
}: ValidateClaimsInput): ValidateClaimsResult {
  const dirty = new Set(recordedDirt);
  const claimedSet = new Set(claimed);

  const outOfClaim = observed.filter((p) => !dirty.has(p) && !claimedSet.has(p));

  return { ok: outOfClaim.length === 0, outOfClaim };
}
