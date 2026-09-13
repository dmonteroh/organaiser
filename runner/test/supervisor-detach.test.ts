import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { startRun, BoardValidationError } from "../src/engine/supervisor-spawn.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const SUPERVISOR_SPAWN_PATH = fileURLToPath(new URL("../src/engine/supervisor-spawn.ts", import.meta.url));
const SUPERVISOR_PATH = fileURLToPath(new URL("../src/engine/supervisor.ts", import.meta.url));
const DB_PATH = fileURLToPath(new URL("../src/store/db.ts", import.meta.url));

// The scheduler never inserts `tasks` rows from a board (that is a later
// phase's job), so a run left with zero task rows resolves to `succeeded` on
// its first real tick (goals spec section 11's vacuous-zero-tasks rule). The
// two tests below need the run to stay open across a real, non-mocked
// timing window, so each seeds one task already at the `waiting-operator`
// disposition: a genuine non-terminal, non-dispatchable board state that
// keeps the tick shell in its bounded operator-poll loop instead of exiting.
function seedWaitingOperatorTask(root: string, runId: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("t1", runId, "t1", "Task 1", "brief.md", "wf1", null, "[]", 0, "waiting-operator", "waiting-operator", now, now);
    });
  } finally {
    db.close();
  }
}

function minimalBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: "t1",
          title: "Task 1",
          briefPath: "brief.md",
          entry: { workflowId: "wf1", stageId: "s1" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          enabled: false,
        },
      ],
    },
  };
}

function writeFixtureFiles(dir: string): { boardPath: string; workflowPath: string; templatePath: string } {
  const boardPath = path.join(dir, "board.json");
  const workflowPath = path.join(dir, "workflow.md");
  const templatePath = path.join(dir, "template.md");
  fs.writeFileSync(boardPath, JSON.stringify(minimalBoard(), null, 2));
  fs.writeFileSync(workflowPath, "# workflow\n");
  fs.writeFileSync(templatePath, "# template\n");
  return { boardPath, workflowPath, templatePath };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 10): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (predicate() || Date.now() > deadline) {
        clearInterval(tick);
        resolve(predicate());
      }
    }, pollMs);
  });
}

test("startRun rejects a board that fails board.schema.json validation", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const { boardPath, workflowPath, templatePath } = writeFixtureFiles(dir);
    assert.throws(
      () =>
        startRun({
          root: dir,
          boardPath,
          board: { apiVersion: "wrong", kind: "NotABoard" },
          workflowPath,
          templatePath,
        }),
      BoardValidationError,
    );
  });
});

test("startRun commits the run row, writes the content-hash snapshot, and spawns a live detached supervisor", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const { boardPath, workflowPath, templatePath } = writeFixtureFiles(dir);

    const result = startRun({ root: dir, boardPath, board: minimalBoard(), workflowPath, templatePath });
    assert.ok(result.supervisorPid !== null && result.logPath !== null, "spawn defaults to true: pid and log path must be set");
    const supervisorPid = result.supervisorPid as number;
    const logPath = result.logPath as string;

    try {
      const db = openStore(dir);
      const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(result.runId) as Record<string, unknown>;
      db.close();

      assert.ok(run, "run row must exist");
      assert.equal(run.state, "starting");
      assert.equal(run.desired_state, "running");
      const snapshot = JSON.parse(run.config_snapshot_ref as string);
      assert.ok(snapshot.board.sha256);
      assert.ok(snapshot.workflow.sha256);
      assert.ok(snapshot.template.sha256);

      assert.ok(fs.existsSync(logPath));
      const pidFile = path.join(path.dirname(logPath), "supervisor.pid");
      assert.equal(fs.readFileSync(pidFile, "utf8"), String(supervisorPid));

      const stillAlive = await waitFor(() => alive(supervisorPid), 1000);
      assert.ok(stillAlive, "supervisor must still be alive shortly after spawn");
    } finally {
      try {
        process.kill(-supervisorPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});

// ── Real parent-exit test: the supervisor must survive its caller's death ──

const CALLER_SCRIPT = `
import { startRun } from ${JSON.stringify(SUPERVISOR_SPAWN_PATH)};
import { openStore, withTransaction } from ${JSON.stringify(DB_PATH)};

const [root, boardPath, workflowPath, templatePath] = process.argv.slice(2);
const fs = await import("node:fs");
const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
const result = startRun({ root, boardPath, board, workflowPath, templatePath });

// Seeded synchronously, before stdout is printed, so the row is durable
// before the just-spawned supervisor's first tick can observe zero tasks.
const seedDb = openStore(root);
try {
  withTransaction(seedDb, () => {
    seedDb.prepare(
      "INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("t1", result.runId, "t1", "Task 1", "brief.md", "wf1", null, "[]", 0, "waiting-operator", "waiting-operator", Date.now(), Date.now());
  });
} finally {
  seedDb.close();
}

process.stdout.write(JSON.stringify(result) + "\\n");
// stay alive long enough for the test to kill this process before it exits
// naturally — the point is to prove the supervisor survives a forceful death
// of its caller, not a caller that already finished on its own.
await new Promise((resolve) => setTimeout(resolve, 10000));
`;

test("the supervisor survives the caller's terminal closing (real spawn, real kill, no mock)", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const { boardPath, workflowPath, templatePath } = writeFixtureFiles(dir);
    const callerPath = path.join(dir, "caller.mjs");
    fs.writeFileSync(callerPath, CALLER_SCRIPT);

    const caller = spawn(process.execPath, [callerPath, dir, boardPath, workflowPath, templatePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    caller.stdout?.setEncoding("utf8");
    caller.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    let stderr = "";
    caller.stderr?.setEncoding("utf8");
    caller.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const gotOutput = await waitFor(() => stdout.includes("\n"), 5000);
    assert.ok(gotOutput, `caller did not print startRun result in time; stderr: ${stderr}`);

    const result = JSON.parse(stdout.trim().split("\n")[0] as string) as {
      runId: string;
      supervisorPid: number;
      logPath: string;
    };

    // Kill only the caller — the supervisor is detached into its own process
    // group/session and must not be reachable by this signal.
    caller.kill("SIGKILL");
    await new Promise<void>((resolve) => caller.on("exit", () => resolve()));
    assert.equal(alive(caller.pid as number), false, "caller must actually be dead for this test to mean anything");

    try {
      const stillAlive = await waitFor(() => alive(result.supervisorPid), 1000);
      assert.ok(stillAlive, "supervisor must survive its caller's death");

      const sizeBefore = fs.statSync(result.logPath).size;
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const sizeAfter = fs.statSync(result.logPath).size;
      assert.ok(sizeAfter > sizeBefore, `supervisor.log must still be growing (before=${sizeBefore}, after=${sizeAfter})`);
    } finally {
      try {
        process.kill(-result.supervisorPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});

// ── Real two-supervisor-process race for the same run's lease ─────────────

test("two real supervisor processes racing for the same run: exactly one stays up, the other exits 4", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const { boardPath, workflowPath, templatePath } = writeFixtureFiles(dir);
    const { runId, supervisorPid: firstPid } = startRun({
      root: dir,
      boardPath,
      board: minimalBoard(),
      workflowPath,
      templatePath,
    });
    assert.ok(firstPid !== null, "spawn defaults to true: the first supervisor must have a pid");
    seedWaitingOperatorTask(dir, runId, Date.now());

    // startRun already spawned a first supervisor for this run; spawn a
    // second one directly against the same run id so it races the first for
    // the lease. Which one wins is not guaranteed by spawn order alone, so
    // this test never assumes it — it reads the outcome back from the store.
    // detached, matching how startRun itself spawns a supervisor: if this one
    // wins the race it becomes its own process group leader, which is what
    // makes the process-group kill below able to reach it in cleanup.
    const second = spawn(process.execPath, [SUPERVISOR_PATH, dir, runId], { detached: true, stdio: "ignore" });
    second.unref();
    let secondExitCode: number | null | "still-running" = "still-running";
    second.on("exit", (code) => {
      secondExitCode = code;
    });

    // Both processes decide the race on their first tick — lease acquisition
    // itself never waits — so a short, bounded settle window is enough
    // regardless of which one wins; nothing here waits unboundedly.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const db = openStore(dir);
    let survivorPid: number;
    try {
      const activeCount = db
        .prepare("SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL")
        .get(runId) as { n: number };
      assert.equal(activeCount.n, 1, "exactly one lease must remain held");
      const activeLease = db
        .prepare("SELECT owner_pid FROM locks WHERE resource = ? AND released_at IS NULL")
        .get(runId) as { owner_pid: number };
      survivorPid = activeLease.owner_pid;
    } finally {
      db.close();
    }

    assert.ok(
      survivorPid === firstPid || survivorPid === second.pid,
      "the surviving lease owner must be one of the two racing processes",
    );
    const loserPid = survivorPid === firstPid ? (second.pid as number) : firstPid;

    assert.ok(groupAlive(survivorPid), "the winning supervisor must still be alive");
    const loserDead = await waitFor(() => !alive(loserPid), 2000);
    assert.ok(loserDead, "the losing supervisor must have exited");

    if (loserPid === second.pid) {
      const gotExitCode = await waitFor(() => secondExitCode !== "still-running", 2000);
      assert.ok(gotExitCode);
      assert.equal(secondExitCode, 4);
    }

    try {
      process.kill(-survivorPid, "SIGKILL");
    } catch {
      // already gone
    }
  });
});
