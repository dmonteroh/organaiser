import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { WorktreeCleanupState } from "../store/types.ts";
import { createInPlaceWorkspace } from "./in-place.ts";

export const DEFAULT_WORKTREE_ROOT = ".orga/worktrees";
export const DEFAULT_BRANCH_PREFIX = "orga/task/";

class GitCommandError extends Error {
  readonly stderr: string;

  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(" ")} failed: ${stderr}`);
    this.name = "GitCommandError";
    this.stderr = stderr;
  }
}

function stderrOf(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const record = err as { stderr?: Buffer | string };
  if (typeof record.stderr === "string") return record.stderr.trim();
  if (Buffer.isBuffer(record.stderr)) return record.stderr.toString("utf8").trim();
  return "";
}

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
    throw new GitCommandError(args, stderrOf(err));
  }
}

// Used only by removeWorkspace's two guarded steps, which must observe a
// failing step's stderr without the module-wide git() helper's throw
// unwinding the caller.
function runStep(
  args: readonly string[],
  cwd: string,
): { ok: true } | { ok: false; stderr: string } {
  try {
    git(args, { cwd });
    return { ok: true };
  } catch (err) {
    if (err instanceof GitCommandError) return { ok: false, stderr: err.stderr };
    throw err;
  }
}

function worktreeListPaths(cwd: string): string[] {
  const output = git(["worktree", "list", "--porcelain"], { cwd, tolerant: true }) ?? "";
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^worktree (.+)$/.exec(line);
    if (match) paths.push(match[1]);
  }
  return paths;
}

export type WorkspaceMode = "worktree" | "in-place";

export interface WorkspaceHandle {
  mode: WorkspaceMode;
  root: string;
  path: string;
  branch: string;
  baseCommit: string;
  recordedDirt: string[];
}

export interface CreateWorkspaceInput {
  mode: WorkspaceMode;
  db: DatabaseSync;
  projectRoot: string;
  runId: string;
  taskId: string;
  taskKey: string;
  ref: string;
  root: string;
  branchPrefix: string;
}

export interface WorkspaceContext {
  db: DatabaseSync;
  projectRoot: string;
  runId: string;
}

export interface WorkspaceRemovalResult {
  ok: boolean;
  cleanupState: WorktreeCleanupState;
  failedStep?: "worktree-remove" | "branch-delete";
  stderr?: string;
}

export class WorkspaceModeNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceModeNotImplementedError";
  }
}

async function createWorktreeWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
  const { db, projectRoot, runId, taskId, taskKey, ref, root, branchPrefix } = input;

  const baseCommit = git(["rev-parse", ref], { cwd: projectRoot });
  const worktreePath = path.resolve(projectRoot, root, runId, taskKey);
  const branch = `${branchPrefix}${taskKey}`;

  git(["worktree", "add", worktreePath, "-b", branch, baseCommit], { cwd: projectRoot });

  const now = Date.now();
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO worktrees (id, run_id, task_id, path, branch, base_commit, cleanup_state, created_at, cleaned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(randomUUID(), runId, taskId, worktreePath, branch, baseCommit, "active", now);

    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      task_id: taskId,
      type: "worktree.created",
      payload: JSON.stringify({ path: worktreePath, branch, baseCommit }),
      created_at: now,
    });
  });

  return {
    mode: "worktree",
    root,
    path: worktreePath,
    branch,
    baseCommit,
    recordedDirt: [],
  };
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
  if (input.mode === "in-place") {
    return createInPlaceWorkspace(input);
  }
  return createWorktreeWorkspace(input);
}

export async function removeWorkspace(
  handle: WorkspaceHandle,
  ctx: WorkspaceContext,
): Promise<WorkspaceRemovalResult> {
  const worktreePresent = worktreeListPaths(ctx.projectRoot).includes(handle.path);

  let failedStep: "worktree-remove" | "branch-delete" | undefined;
  let stderr = "";

  if (worktreePresent) {
    const result = runStep(["worktree", "remove", "--force", handle.path], ctx.projectRoot);
    if (!result.ok) {
      failedStep = "worktree-remove";
      stderr = result.stderr;
    }
  }

  if (!failedStep) {
    const branchSha = git(["rev-parse", "--verify", `refs/heads/${handle.branch}`], {
      cwd: ctx.projectRoot,
      tolerant: true,
    });
    if (branchSha !== null) {
      const result = runStep(["branch", "-D", handle.branch], ctx.projectRoot);
      if (!result.ok) {
        failedStep = "branch-delete";
        stderr = result.stderr;
      }
    }
  }

  const cleanupState: WorktreeCleanupState = failedStep ? "orphaned" : "cleaned";
  const now = Date.now();

  withTransaction(ctx.db, () => {
    const row = ctx.db
      .prepare("SELECT id FROM worktrees WHERE run_id = ? AND path = ?")
      .get(ctx.runId, handle.path) as { id: string } | undefined;

    if (row) {
      ctx.db
        .prepare("UPDATE worktrees SET cleanup_state = ?, cleaned_at = ? WHERE id = ?")
        .run(cleanupState, cleanupState === "cleaned" ? now : null, row.id);
    }

    appendEvent(ctx.db, {
      id: randomUUID(),
      run_id: ctx.runId,
      type: cleanupState === "cleaned" ? "worktree.cleaned" : "worktree.cleanup_failed",
      payload: JSON.stringify(
        cleanupState === "cleaned"
          ? { path: handle.path, branch: handle.branch }
          : { path: handle.path, branch: handle.branch, step: failedStep, stderr },
      ),
      created_at: now,
    });
  });

  return failedStep
    ? { ok: false, cleanupState, failedStep, stderr }
    : { ok: true, cleanupState };
}

export interface ListUntrackedWorktreesInput {
  db: DatabaseSync;
  runId: string;
  projectRoot: string;
}

// Reconciles worktrees present on disk under this run against the run's
// worktrees rows, surfacing the paths a process killed between `git worktree
// add` and the row-write transaction leaves stranded.
export function listUntrackedWorktrees({
  db,
  runId,
  projectRoot,
}: ListUntrackedWorktreesInput): string[] {
  const marker = `${path.sep}${runId}${path.sep}`;
  const runWorktreePaths = worktreeListPaths(projectRoot).filter((p) => p.includes(marker));

  const rows = db
    .prepare("SELECT path FROM worktrees WHERE run_id = ?")
    .all(runId) as Array<{ path: string }>;
  const known = new Set(rows.map((row) => row.path));

  return runWorktreePaths.filter((p) => !known.has(p));
}
