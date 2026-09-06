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

// A live re-read of `projectRoot`'s current branch, compared against `ref` in
// its branch-name form: `tolerant: true` so a detached HEAD (no branch to
// compare) resolves to "no collision" rather than throwing.
export function refIsCurrentCheckout(projectRoot: string, ref: string): boolean {
  const branch = git(["symbolic-ref", "--short", "HEAD"], { cwd: projectRoot, tolerant: true });
  if (branch === null) return false;
  return ref === `refs/heads/${branch}`;
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

export interface StageClaimedPathsInput {
  projectRoot: string;
  claimedPaths: readonly string[];
}

// `git add -- <path...>`: an explicit, argument-array path list, never `-A`
// or `.`, so pre-existing dirt in the operator's checkout is never staged
// alongside the claim set. A no-op when `claimedPaths` is empty (an empty
// `git add --` prints an advisory hint but stages nothing).
export function stageClaimedPaths({ projectRoot, claimedPaths }: StageClaimedPathsInput): void {
  if (claimedPaths.length === 0) return;
  git(["add", "--", ...claimedPaths], { cwd: projectRoot });
}

// Writes the current index as a tree object: touches no ref, no HEAD, no
// working tree.
export function writeTree(projectRoot: string): string {
  return git(["write-tree"], { cwd: projectRoot });
}

export interface CommitTreeInput {
  projectRoot: string;
  tree: string;
  parentSha: string;
  message: string;
}

// Creates a real commit object parented at `parentSha`: touches no ref, no
// HEAD, no working tree. The returned sha exists in the object database
// without moving anything the operator can observe.
export function commitTree({ projectRoot, tree, parentSha, message }: CommitTreeInput): string {
  return git(["commit-tree", tree, "-p", parentSha, "-m", message], { cwd: projectRoot });
}

export interface CommitOnBranchInput {
  projectRoot: string;
  claimedPaths: readonly string[];
  message: string;
}

// The `in-place` workspace mode's landing step: re-stages the claim set
// (idempotent — safe whether or not it is already staged from building the
// review candidate) and runs a plain, argument-array `git commit` directly
// on whatever the branch's current tip is. No compare-and-swap, no
// `update-ref`: this is a normal commit on the operator's own checkout.
// `--allow-empty` so a task whose claim set is empty, or whose edits net out
// to no diff against the destination, still lands a commit rather than
// failing the whole integration on git's own "nothing to commit" refusal.
export function commitOnBranch({ projectRoot, claimedPaths, message }: CommitOnBranchInput): string {
  stageClaimedPaths({ projectRoot, claimedPaths });
  git(["commit", "--allow-empty", "-m", message], { cwd: projectRoot });
  return headSha(projectRoot);
}

// The integration strategies a destination can be landed with.
// `replay-and-fast-forward` is the `worktree` workspace mode's landing step
// (candidate worktree, replay, compare-and-swap, all above).
// `commit-on-branch` is the `in-place` workspace mode's landing step — a
// commit on the current branch, with no candidate worktree and no
// compare-and-swap.
export type IntegrationStrategy = "replay-and-fast-forward" | "commit-on-branch";

export interface AdvanceIntegrationReplayInput extends AdvanceDestinationInput {
  strategy: "replay-and-fast-forward";
}

export type AdvanceIntegrationCommitInput = CommitOnBranchInput & { strategy: "commit-on-branch" };

export type AdvanceIntegrationInput = AdvanceIntegrationReplayInput | AdvanceIntegrationCommitInput;

// The strategy switch every caller lands an integration through.
// `replay-and-fast-forward` reduces to `advanceDestination`'s compare-and-
// swap above and reports whether the swap succeeded. `commit-on-branch`
// reduces to `commitOnBranch` above and reports the new commit's sha, since
// there is no compare-and-swap outcome to report.
export function advanceIntegration(input: AdvanceIntegrationReplayInput): boolean;
export function advanceIntegration(input: AdvanceIntegrationCommitInput): string;
export function advanceIntegration(input: AdvanceIntegrationInput): boolean | string {
  switch (input.strategy) {
    case "replay-and-fast-forward":
      return advanceDestination(input);
    case "commit-on-branch":
      return commitOnBranch(input);
  }
}
