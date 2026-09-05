// Pure Git mechanics for `integration.v1`'s replay-and-fast-forward strategy:
// candidate worktree creation, replay-with-abort-on-conflict, and the
// `update-ref` compare-and-swap. No store row is read or written here beyond
// the `worktrees` bookkeeping insert `createCandidateWorkspace` makes so
// `removeWorkspace` (git/workspace.ts, unmodified) can tear the candidate
// down the same way it tears down any other worktree row. No stage-machine
// concern (locks, gates, evidence) lives in this module.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { WorkspaceHandle } from "./workspace.ts";

interface GitCallOptions {
  cwd: string;
}

function git(
  args: readonly string[],
  options: GitCallOptions & { tolerant: true },
): string | null;
function git(
  args: readonly string[],
  options: GitCallOptions & { tolerant?: false },
): string;
function git(
  args: readonly string[],
  { cwd, tolerant = false }: GitCallOptions & { tolerant?: boolean },
): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  } catch (err) {
    if (tolerant) return null;
    throw err;
  }
}

export function readRefSha(projectRoot: string, ref: string): string {
  return git(["rev-parse", ref], { cwd: projectRoot });
}

// The fully-qualified ref of the operator checkout's current branch: the
// destination `integration.v1` advances is whatever branch the operator's
// own repository is on, not a fixed name this package hard-codes.
export function resolveDestinationRef(projectRoot: string): string {
  const branch = git(["symbolic-ref", "--short", "HEAD"], { cwd: projectRoot });
  return `refs/heads/${branch}`;
}

export function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], { cwd });
}

export interface CreateCandidateWorkspaceInput {
  db: DatabaseSync;
  runId: string;
  taskId: string;
  projectRoot: string;
  candidatePath: string;
  destinationSha: string;
}

// A detached worktree at the destination's current sha: `--detach` so no
// branch is created (there is nothing to name it, and the task's own branch
// already exists), keeping this candidate a distinct worktree from the
// task's own for as long as it lives. Recorded in `worktrees` with an empty
// `branch` so `removeWorkspace`'s branch-delete step finds no matching ref
// and is a no-op, exactly as it is for any other detached worktree.
export function createCandidateWorkspace(input: CreateCandidateWorkspaceInput): WorkspaceHandle {
  const { db, runId, taskId, projectRoot, candidatePath, destinationSha } = input;

  git(["worktree", "add", "--detach", candidatePath, destinationSha], { cwd: projectRoot });

  const now = Date.now();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO worktrees (id, run_id, task_id, path, branch, base_commit, cleanup_state, created_at, cleaned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(randomUUID(), runId, taskId, candidatePath, "", destinationSha, "active", now);

    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      task_id: taskId,
      type: "worktree.created",
      payload: JSON.stringify({ path: candidatePath, branch: "", baseCommit: destinationSha, role: "integration-candidate" }),
      created_at: now,
    });
  });

  return {
    mode: "worktree",
    root: "",
    path: candidatePath,
    branch: "",
    baseCommit: destinationSha,
    recordedDirt: [],
  };
}

export interface ReplayConflict {
  conflictingPaths: string[];
}

export type ReplayResult = { ok: true } | { ok: false; conflict: ReplayConflict };

export interface ReplayTaskBranchInput {
  candidatePath: string;
  baseCommit: string;
  taskBranch: string;
}

// `git cherry-pick <base>..<branch>` as a single range argument: no shell, no
// interpolation, and no model-controlled command anywhere in this path. A
// non-zero exit aborts the cherry-pick and captures the conflicting paths
// before returning, leaving the candidate worktree in a clean (if still
// present) state for the caller to remove.
export function replayTaskBranch(input: ReplayTaskBranchInput): ReplayResult {
  try {
    git(["cherry-pick", `${input.baseCommit}..${input.taskBranch}`], { cwd: input.candidatePath });
    return { ok: true };
  } catch {
    const raw = git(["diff", "--name-only", "--diff-filter=U"], { cwd: input.candidatePath, tolerant: true }) ?? "";
    const conflictingPaths = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    git(["cherry-pick", "--abort"], { cwd: input.candidatePath, tolerant: true });
    return { ok: false, conflict: { conflictingPaths } };
  }
}

export interface AdvanceDestinationInput {
  projectRoot: string;
  ref: string;
  newSha: string;
  expectedOldSha: string;
}

// The only compare-and-swap Git offers: a three-argument `update-ref` that
// fails closed (non-zero exit, no partial move) when `ref` no longer holds
// `expectedOldSha`. A `false` return means exactly "someone else moved the
// ref since it was read", never a distinguishable error; the caller treats
// it as a contended update, not a fault.
export function advanceDestination(input: AdvanceDestinationInput): boolean {
  return git(["update-ref", input.ref, input.newSha, input.expectedOldSha], { cwd: input.projectRoot, tolerant: true }) !== null;
}

// The integration strategies a destination can be landed with. This module
// implements only `replay-and-fast-forward` (candidate worktree, replay,
// compare-and-swap, all above). `commit-on-branch` is the `in-place`
// workspace mode's landing step — a commit on the current branch, with no
// candidate worktree and no compare-and-swap.
export type IntegrationStrategy = "replay-and-fast-forward" | "commit-on-branch";

export interface AdvanceIntegrationInput extends AdvanceDestinationInput {
  strategy: IntegrationStrategy;
}

// The strategy switch every caller lands an integration through.
// `replay-and-fast-forward` reduces to `advanceDestination`'s compare-and-
// swap above; every current call site uses this branch exclusively.
export function advanceIntegration(input: AdvanceIntegrationInput): boolean {
  switch (input.strategy) {
    case "replay-and-fast-forward":
      return advanceDestination(input);
    case "commit-on-branch":
      throw new Error("commit-on-branch: not implemented — P7e fills this in"); // P7e: commit-on-branch integration is not implemented.
  }
}
