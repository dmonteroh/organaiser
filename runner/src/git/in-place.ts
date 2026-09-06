import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { withTransaction } from "../store/db.ts";
import { appendEvent } from "../store/events.ts";
import type { CreateWorkspaceInput, WorkspaceHandle } from "./workspace.ts";

function gitTrim(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

// `git status --porcelain`'s status codes occupy the line's first two
// columns unconditionally (including the leading space of " M"), so the
// output is read untrimmed and split on newlines rather than through a
// helper that would trim away a leading, semantically-significant space.
function statusPorcelainLines(cwd: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return output.split("\n").filter((line) => line.length > 0);
}

function dirtyPaths(cwd: string): string[] {
  return statusPorcelainLines(cwd).map((line) => {
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    return arrow === -1 ? rest : rest.slice(arrow + 4);
  });
}

export class InPlaceDirtyCheckoutError extends Error {
  readonly dirtyPaths: readonly string[];

  constructor(dirtyPaths: readonly string[]) {
    super(
      `in-place run refused: checkout has ${dirtyPaths.length} dirty path(s): ${dirtyPaths.join(", ")} (pass --allow-dirty to proceed)`,
    );
    this.name = "InPlaceDirtyCheckoutError";
    this.dirtyPaths = dirtyPaths;
  }
}

export interface CheckInPlaceStartInput {
  projectRoot: string;
  allowDirty: boolean;
}

export interface InPlaceStartCheck {
  recordedDirt: string[];
}

// Rules for `in-place` (D6): the run refuses to start against a dirty
// checkout unless `--allow-dirty` is passed, in which case the dirty paths
// observed at that moment are recorded rather than blocking the run.
export function checkInPlaceStart({ projectRoot, allowDirty }: CheckInPlaceStartInput): InPlaceStartCheck {
  const dirty = dirtyPaths(projectRoot);
  if (dirty.length > 0 && !allowDirty) {
    throw new InPlaceDirtyCheckoutError(dirty);
  }
  return { recordedDirt: dirty };
}

// The `in-place` counterpart to `workspace.ts`'s `createWorktreeWorkspace`:
// same recording order (resolve base, record, then hand the path to a
// caller), but the path handed back is the project root itself rather than
// a runner-owned worktree, and no worktree or branch is created. Dirt is
// read fresh at each call rather than threaded in from the CLI's start
// check, since a run's later mutating attempts (there is at most one live
// at a time) can themselves be the reason the checkout is no longer clean;
// recording that dirt here, unconditionally, is what lets
// `validateClaims` (`claims.ts`) exclude it from every subsequent claim
// check for this attempt.
export async function createInPlaceWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
  const { db, projectRoot, runId, taskId, ref, root } = input;

  const baseCommit = gitTrim(["rev-parse", ref], projectRoot);
  const branch = gitTrim(["rev-parse", "--abbrev-ref", "HEAD"], projectRoot);
  const recordedDirt = dirtyPaths(projectRoot);

  const now = Date.now();
  withTransaction(db, () => {
    appendEvent(db, {
      id: randomUUID(),
      run_id: runId,
      task_id: taskId,
      type: "workspace.in_place_recorded",
      payload: JSON.stringify({ path: projectRoot, branch, baseCommit, recordedDirt }),
      created_at: now,
    });
  });

  return {
    mode: "in-place",
    root,
    path: projectRoot,
    branch,
    baseCommit,
    recordedDirt,
  };
}
