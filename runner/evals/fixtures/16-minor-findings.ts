// Fixture: minor-findings-append-once.
//
// `record-minors`'s crash-safety property (`src/engine/minor-findings.ts`)
// proven end to end: a real, detached process durably claims the append's
// guard row, is killed with a real `SIGKILL` before it ever touches the
// follow-ups file, and a second, ordinary run of the same module then
// completes the append exactly once. `startFixtureRun`'s own comment notes
// that this suite always kills the real production supervisor it spawns
// immediately, before it dispatches anything, so there is no way to drive
// that same process into this fixture's precise crash window; this fixture
// instead spawns this file as its own worker process, calling the identical
// `claimMinorFindingsAppend`/`appendMinorFindings` exports the driver's
// `record-minors` binding (`workflow-stages.ts`) calls in production.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProcessRegistry,
  alive,
  waitFor,
  startGitFixtureRun,
  assertOperatorCheckoutUnchanged,
  withFixtureWorkspace,
  openStore,
  allRows,
  countRows,
} from "./harness.ts";
import { appendMinorFindings, claimMinorFindingsAppend, type MinorFinding } from "../../src/engine/minor-findings.ts";

const THIS_FILE = fileURLToPath(import.meta.url);
const TASK_ID = "task-1";
const ATTEMPT_ID = "attempt-1";
const FINDING_SUMMARY = "minor-findings-append-once fixture entry";
const FINDINGS: readonly MinorFinding[] = [{ summary: FINDING_SUMMARY, path: "src/example.ts", line: 1 }];

type WorkerMode = "claim" | "full";

interface WorkerArgs {
  mode: WorkerMode;
  root: string;
  runId: string;
  followUpsFilePath: string;
}

function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const [mode, root, runId, followUpsFilePath] = argv;
  if (mode !== "claim" && mode !== "full") {
    throw new Error(`usage: 16-minor-findings.ts <claim|full> <root> <runId> <followUpsFilePath>`);
  }
  if (!root || !runId || !followUpsFilePath) {
    throw new Error(`usage: 16-minor-findings.ts <claim|full> <root> <runId> <followUpsFilePath>`);
  }
  return { mode, root, runId, followUpsFilePath };
}

async function runWorker(args: WorkerArgs): Promise<void> {
  const db = openStore(args.root);
  try {
    if (args.mode === "claim") {
      claimMinorFindingsAppend({ db, runId: args.runId, taskId: TASK_ID, attemptId: ATTEMPT_ID });
      // Stays alive so the fixture can deliver a real SIGKILL exactly here:
      // the guard row is durably committed, the file append has not run. An
      // interval is the only thing holding the event loop open at this
      // point (the store connection itself is synchronous), so a bare
      // never-resolving promise would let the process exit on its own
      // before any signal arrives.
      await new Promise<void>(() => {
        setInterval(() => {}, 1000);
      });
    } else {
      appendMinorFindings({
        db,
        runId: args.runId,
        taskId: TASK_ID,
        attemptId: ATTEMPT_ID,
        findings: FINDINGS,
        followUpsFilePath: args.followUpsFilePath,
      });
    }
  } finally {
    db.close();
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runWorker(parseWorkerArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(
        `[minor-findings-worker] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    });
}

function spawnWorker(mode: WorkerMode, root: string, runId: string, followUpsFilePath: string): { pid: number } {
  const child = spawn(process.execPath, [THIS_FILE, mode, root, runId, followUpsFilePath], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  if (typeof child.pid !== "number") throw new Error(`spawnWorker: no pid for mode ${mode}`);
  child.unref();
  return { pid: child.pid };
}

function guardRowClaimed(root: string, runId: string): boolean {
  const rows = allRows<{ id: string }>(
    root,
    `SELECT id FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ?`,
    runId,
    TASK_ID,
    ATTEMPT_ID,
  );
  return rows.length === 1;
}

function completedAppendCount(root: string, runId: string): number {
  return countRows(
    root,
    `SELECT COUNT(*) AS n FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND appended_at IS NOT NULL`,
    runId,
    TASK_ID,
    ATTEMPT_ID,
  );
}

export async function minorFindingsAppendOnce(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const { runId } = startGitFixtureRun(dir, [{ id: TASK_ID, priority: 0 }]);
    // `.orga/` is git-ignored by `startGitFixtureRun`'s own setup, so a real
    // write here stays confined to the project tree without disturbing
    // `assertOperatorCheckoutUnchanged`'s `git status --porcelain` snapshot.
    const followUpsFilePath = path.join(dir, ".orga", "followups-fixture.md");

    try {
      await assertOperatorCheckoutUnchanged(dir, async () => {
        const first = spawnWorker("claim", dir, runId, followUpsFilePath);
        registry.track(first.pid);

        const claimed = await waitFor(() => guardRowClaimed(dir, runId), 3000);
        assert.ok(claimed, "the worker must durably claim the guard row before it is killed");
        assert.equal(
          fs.existsSync(followUpsFilePath),
          false,
          "the follow-ups file must not exist before the append phase ever runs",
        );

        process.kill(first.pid, "SIGKILL");
        const firstDead = await waitFor(() => !alive(first.pid), 2000);
        assert.ok(firstDead, "the first worker must actually be dead before the restart");

        const second = spawnWorker("full", dir, runId, followUpsFilePath);
        registry.track(second.pid);
        const secondDead = await waitFor(() => !alive(second.pid), 3000);
        assert.ok(secondDead, "the restarted worker must run to completion");

        const contents = fs.readFileSync(followUpsFilePath, "utf8");
        const entryCount = contents.split(FINDING_SUMMARY).length - 1;
        assert.equal(entryCount, 1, `expected exactly one appended entry; file contents: ${contents}`);
        assert.equal(completedAppendCount(dir, runId), 1, "expected exactly one durably-completed append row");
      });
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
