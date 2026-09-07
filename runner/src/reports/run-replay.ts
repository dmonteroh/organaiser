// Replay report core: reconciles a run's store `tasks` rows against the
// on-disk task directories under `.orga/runs/<run-id>/tasks/`, recomputing
// disposition from frozen artifacts for every task that has both.
//
// Per-task status is one of exactly five values:
//   "agree"          - a store row and an on-disk directory exist, and the
//                       recomputed disposition matches the stored one.
//   "diverged"       - a store row and an on-disk directory exist, but the
//                       recomputed disposition disagrees with the stored one.
//   "not-applicable" - a store row and an on-disk directory exist, but the
//                       stored disposition was never "integrated", so there
//                       is nothing to reconcile against.
//   "no-artifacts"   - a store row exists with no matching on-disk directory
//                       (e.g. a task not yet dispatched).
//   "orphan"         - an on-disk directory exists with no matching store
//                       row. Reported for visibility only; carries no
//                       recomputed disposition, since there is no stored
//                       disposition to compare against.
//
// `buildReplayReport` returns a `ReplayReport`: a `runId` plus a `tasks` list
// of `ReplayTaskEntry` values, each `{ taskId, status, ... }`. For "agree",
// "diverged", and "not-applicable" entries, the entry also carries
// `recomputed`: `recomputeDisposition`'s own `{ state, gaps }` return value
// (`../engine/disposition.ts`), which is the actual diff detail. This is
// deliberately NOT `compareDisposition`'s return value — that is only the
// bare comparison status string reused here as `status` — because
// `compareDisposition` itself carries no gap/diff detail of its own; the
// detail comes from `recomputeDisposition`'s output, `compareDisposition`'s
// own first input parameter.
//
// This module is read-only: no INSERT/UPDATE/DELETE statement is issued
// anywhere, and no live repository state is read beyond the git facts
// `buildFacts` already resolves. It owns its own `openStore`/`close`
// lifecycle, opening once per `buildReplayReport` call and closing in a
// `finally` on every path, including the `ReplayUnknownTaskError` path.
//
// A follow-up task (P9b-iii-b-b) adds `runReplay`, a CLI-facing wrapper
// around `buildReplayReport`, to this same file. `buildReplayReport` must
// therefore stay exported, not be made module-private, once that wrapper
// lands.

import fs from "node:fs";
import path from "node:path";

import { openStore } from "../store/db.ts";
import type { TaskRow } from "../store/types.ts";
import type { TerminalDisposition } from "../engine/board-predicates.ts";
import {
  compareDisposition,
  recomputeDisposition,
  type RecomputedDisposition,
} from "../engine/disposition.ts";
import { EXIT_CODES, type ExitCode } from "../cli/exit-codes.ts";
import { assembleReplayInputs } from "./replay-inputs.ts";
import { buildFacts, reconstructLedger } from "./replay.ts";

export class ReplayUnknownTaskError extends Error {}

export type ReplayTaskStatus = "agree" | "diverged" | "not-applicable" | "no-artifacts" | "orphan";

export interface ReplayTaskEntry {
  taskId: string;
  status: ReplayTaskStatus;
  recomputed?: RecomputedDisposition;
}

export interface ReplayReport {
  runId: string;
  tasks: ReplayTaskEntry[];
}

function recomputeTaskEntry(
  db: ReturnType<typeof openStore>,
  root: string,
  runDir: string,
  taskDir: string,
  task: TaskRow,
): ReplayTaskEntry {
  const { specPath, verificationMode, integrationCommit } = assembleReplayInputs(db, task, { root });
  const ledger = reconstructLedger(taskDir, {
    taskId: task.id,
    specPath,
    verificationMode,
    integrationCommit,
    runRoot: runDir,
  });
  const facts = buildFacts(ledger, { cwd: root, runRoot: runDir });
  const recomputed = recomputeDisposition(facts);
  const status = compareDisposition(recomputed, task.disposition as TerminalDisposition);
  return { taskId: task.id, status, recomputed };
}

export function buildReplayReport(
  root: string,
  runId: string,
  opts?: { taskId?: string },
): ReplayReport {
  const db = openStore(root);
  try {
    const allRows = db
      .prepare(`SELECT * FROM tasks WHERE run_id = ?`)
      .all(runId) as unknown as TaskRow[];

    let rowsToProcess = allRows;
    let includeOrphans = true;
    if (opts?.taskId !== undefined) {
      const match = allRows.find((t) => t.id === opts.taskId);
      if (!match) {
        throw new ReplayUnknownTaskError(
          `no task "${opts.taskId}" found in run "${runId}"`,
        );
      }
      rowsToProcess = [match];
      includeOrphans = false;
    }

    const runDir = path.join(root, ".orga", "runs", runId);
    const tasksRoot = path.join(runDir, "tasks");

    const entries: ReplayTaskEntry[] = [];
    for (const task of rowsToProcess) {
      const taskDir = path.join(tasksRoot, task.id);
      // Existence check must run before the recompute chain: reconstructLedger's
      // readdirSync throws ENOENT on a missing directory, which every
      // not-yet-dispatched task's store row has (no on-disk directory yet).
      if (!fs.existsSync(taskDir)) {
        entries.push({ taskId: task.id, status: "no-artifacts" });
        continue;
      }
      entries.push(recomputeTaskEntry(db, root, runDir, taskDir, task));
    }

    if (includeOrphans) {
      const storeIds = new Set(allRows.map((t) => t.id));
      const onDiskIds = fs.existsSync(tasksRoot)
        ? fs
            .readdirSync(tasksRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
        : [];
      for (const id of onDiskIds) {
        if (!storeIds.has(id)) {
          entries.push({ taskId: id, status: "orphan" });
        }
      }
    }

    return { runId, tasks: entries };
  } finally {
    db.close();
  }
}

export function runReplay(
  root: string,
  runId: string,
  opts?: { taskId?: string },
): { report: ReplayReport; exitCode: ExitCode } {
  const report = buildReplayReport(root, runId, opts);
  const exitCode = report.tasks.some((task) => task.status === "diverged")
    ? EXIT_CODES.STATE_CONFLICT
    : EXIT_CODES.OK;
  return { report, exitCode };
}
