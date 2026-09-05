// Fixture: minor-findings-append-once.
//
// `record-minors`'s crash-safety property (`src/engine/minor-findings.ts`)
// proven end to end across both crash windows, each with a real, separate,
// detached process killed with a real `SIGKILL`. `startFixtureRun`'s own
// comment notes that this suite always kills the real production supervisor
// it spawns immediately, before it dispatches anything, so there is no way
// to drive that same process into either of this fixture's precise crash
// windows; this fixture instead spawns this file as its own worker process.
//
// Phase one covers the guard-row window: the `claim` worker durably commits
// the guard row and is killed before it ever touches the follow-ups file,
// then a restarted `full` worker completes the append exactly once. Phase
// two covers the write window, for a distinct attempt id: the `write`
// worker durably commits the guard row and writes the marker-bearing file
// entry, then is killed before the guard row is ever marked done, then a
// restarted `full` worker for that same attempt id sees `alreadyAppended:
// false` from the guard row but must not duplicate the file entry, thanks
// to the marker check in `writeMinorFindingsFile`.
//
// The restarted (`full`) phase in both cases calls `resolveRecordMinors`
// (`workflow-stages.ts`, exported for this purpose), the same function the
// driver's `record-minors` binding calls in production, so the fixture also
// exercises that binding's own wiring — the env-layered follow-ups path
// resolution and the agent report's finding extraction — rather than only
// the lower-level append/claim/write functions.

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
import { claimMinorFindingsAppend, writeMinorFindingsFile } from "../../src/engine/minor-findings.ts";
import { resolveRecordMinors, type DevelopmentStageInput } from "../../src/engine/workflow-stages.ts";
import type { ProcessAdapter } from "../../src/adapters/adapter.ts";

const THIS_FILE = fileURLToPath(import.meta.url);
const TASK_ID = "task-1";
const ATTEMPT_ID = "attempt-1";
const FINDING_SUMMARY = "minor-findings-append-once fixture entry";
const ATTEMPT_ID_2 = "attempt-2";
const FINDING_SUMMARY_2 = "minor-findings-append-once fixture entry, write-window phase";

type WorkerMode = "claim" | "write" | "full";

interface WorkerArgs {
  mode: WorkerMode;
  root: string;
  runId: string;
  followUpsFilePath: string;
  attemptId: string;
  findingSummary: string;
}

function parseWorkerArgs(argv: readonly string[]): WorkerArgs {
  const [mode, root, runId, followUpsFilePath, attemptId, findingSummary] = argv;
  if (mode !== "claim" && mode !== "write" && mode !== "full") {
    throw new Error(`usage: 16-minor-findings.ts <claim|write|full> <root> <runId> <followUpsFilePath> <attemptId> <findingSummary>`);
  }
  if (!root || !runId || !followUpsFilePath || !attemptId || !findingSummary) {
    throw new Error(`usage: 16-minor-findings.ts <claim|write|full> <root> <runId> <followUpsFilePath> <attemptId> <findingSummary>`);
  }
  return { mode, root, runId, followUpsFilePath, attemptId, findingSummary };
}

function stayAlive(): Promise<void> {
  // Holds the event loop open so the fixture can deliver a real SIGKILL
  // exactly at the intended crash point. An interval is the only thing
  // holding the event loop open at this point (the store connection itself
  // is synchronous), so a bare never-resolving promise would let the
  // process exit on its own before any signal arrives.
  return new Promise<void>(() => {
    setInterval(() => {}, 1000);
  });
}

async function runWorker(args: WorkerArgs): Promise<void> {
  const db = openStore(args.root);
  try {
    if (args.mode === "claim") {
      claimMinorFindingsAppend({ db, runId: args.runId, taskId: TASK_ID, attemptId: args.attemptId });
      // Stays alive so the fixture can kill it here: the guard row is
      // durably committed, the file append has not run.
      await stayAlive();
    } else if (args.mode === "write") {
      claimMinorFindingsAppend({ db, runId: args.runId, taskId: TASK_ID, attemptId: args.attemptId });
      writeMinorFindingsFile({
        runId: args.runId,
        taskId: TASK_ID,
        attemptId: args.attemptId,
        findings: [{ summary: args.findingSummary, path: "src/example.ts", line: 1 }],
        followUpsFilePath: args.followUpsFilePath,
      });
      // Stays alive so the fixture can kill it here: the guard row is
      // durably committed and the marker-bearing entry is written, but the
      // guard row is never marked done.
      await stayAlive();
    } else {
      const input: DevelopmentStageInput = {
        db,
        adapter: {} as unknown as ProcessAdapter,
        runId: args.runId,
        taskId: TASK_ID,
        now: () => Date.now(),
        taskDir: args.root,
        executionRoot: args.root,
        requiredArtifacts: [],
        checks: {},
        env: process.env,
      };
      const ctx = {
        input,
        lastAgentAttempt: { attemptId: args.attemptId, pgid: 0 },
        barrierCache: null,
        lastAgentReport: {
          findings: [
            { id: "finding-1", severity: "minor", summary: args.findingSummary, path: "src/example.ts", line: 1 },
          ],
        },
      };
      resolveRecordMinors(input, ctx);
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

function spawnWorker(
  mode: WorkerMode,
  root: string,
  runId: string,
  followUpsFilePath: string,
  attemptId: string,
  findingSummary: string,
): { pid: number } {
  const child = spawn(process.execPath, [THIS_FILE, mode, root, runId, followUpsFilePath, attemptId, findingSummary], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ORGA_FOLLOWUPS_FILE: followUpsFilePath },
  });
  child.stdout?.resume();
  child.stderr?.resume();
  if (typeof child.pid !== "number") throw new Error(`spawnWorker: no pid for mode ${mode}`);
  child.unref();
  return { pid: child.pid };
}

function guardRowClaimed(root: string, runId: string, attemptId: string): boolean {
  const rows = allRows<{ id: string }>(
    root,
    `SELECT id FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ?`,
    runId,
    TASK_ID,
    attemptId,
  );
  return rows.length === 1;
}

function completedAppendCount(root: string, runId: string, attemptId: string): number {
  return countRows(
    root,
    `SELECT COUNT(*) AS n FROM minor_finding_appends WHERE run_id = ? AND task_id = ? AND attempt_id = ? AND appended_at IS NOT NULL`,
    runId,
    TASK_ID,
    attemptId,
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
        // Phase one: the guard-row window. Kill right after the guard row
        // commits, before the file is ever touched.
        const first = spawnWorker("claim", dir, runId, followUpsFilePath, ATTEMPT_ID, FINDING_SUMMARY);
        registry.track(first.pid);

        const claimed = await waitFor(() => guardRowClaimed(dir, runId, ATTEMPT_ID), 3000);
        assert.ok(claimed, "the worker must durably claim the guard row before it is killed");
        assert.equal(
          fs.existsSync(followUpsFilePath),
          false,
          "the follow-ups file must not exist before the append phase ever runs",
        );

        process.kill(first.pid, "SIGKILL");
        const firstDead = await waitFor(() => !alive(first.pid), 2000);
        assert.ok(firstDead, "the first worker must actually be dead before the restart");

        const second = spawnWorker("full", dir, runId, followUpsFilePath, ATTEMPT_ID, FINDING_SUMMARY);
        registry.track(second.pid);
        const secondDead = await waitFor(() => !alive(second.pid), 3000);
        assert.ok(secondDead, "the restarted worker must run to completion");

        const contents = fs.readFileSync(followUpsFilePath, "utf8");
        const entryCount = contents.split(FINDING_SUMMARY).length - 1;
        assert.equal(entryCount, 1, `expected exactly one appended entry; file contents: ${contents}`);
        assert.equal(completedAppendCount(dir, runId, ATTEMPT_ID), 1, "expected exactly one durably-completed append row");

        // Phase two: the write window, for a distinct attempt id. Kill
        // right after the marker-bearing entry is written, before the
        // guard row is ever marked done.
        const third = spawnWorker("write", dir, runId, followUpsFilePath, ATTEMPT_ID_2, FINDING_SUMMARY_2);
        registry.track(third.pid);

        const written = await waitFor(
          () => fs.existsSync(followUpsFilePath) && fs.readFileSync(followUpsFilePath, "utf8").includes(FINDING_SUMMARY_2),
          3000,
        );
        assert.ok(written, "the write-mode worker must durably write the entry before it is killed");
        assert.equal(completedAppendCount(dir, runId, ATTEMPT_ID_2), 0, "the guard row must not be marked done yet");

        process.kill(third.pid, "SIGKILL");
        const thirdDead = await waitFor(() => !alive(third.pid), 2000);
        assert.ok(thirdDead, "the write-mode worker must actually be dead before the restart");

        const fourth = spawnWorker("full", dir, runId, followUpsFilePath, ATTEMPT_ID_2, FINDING_SUMMARY_2);
        registry.track(fourth.pid);
        const fourthDead = await waitFor(() => !alive(fourth.pid), 3000);
        assert.ok(fourthDead, "the restarted worker must run to completion");

        const contentsAfterPhaseTwo = fs.readFileSync(followUpsFilePath, "utf8");
        const secondEntryCount = contentsAfterPhaseTwo.split(FINDING_SUMMARY_2).length - 1;
        assert.equal(
          secondEntryCount,
          1,
          `expected exactly one appended entry for the write-window attempt; file contents: ${contentsAfterPhaseTwo}`,
        );
        assert.equal(
          completedAppendCount(dir, runId, ATTEMPT_ID_2),
          1,
          "expected exactly one durably-completed append row for the write-window attempt",
        );
      });
    } finally {
      registry.killAll();
      await registry.allDead();
    }
  });
}
