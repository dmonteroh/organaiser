import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor, ProcessAdapter } from "../src/adapters/adapter.ts";
import {
  acquireDestinationLock,
  INTEGRATION_CAPS,
  INTEGRATION_ENTRY_STAGE,
  INTEGRATION_STAGES,
  INTEGRATION_TERMINAL_OUTCOMES,
  integrationLockStaleMs,
  runIntegrationStages,
  type IntegrationDriverContext,
  type IntegrationStagesInput,
} from "../src/engine/integration-stages.ts";
import { commitExists, isAncestor } from "../src/git/git.ts";
import { advanceIntegration, refIsCurrentCheckout } from "../src/git/integrate.ts";
import { accept, type Facts } from "../src/engine/predicates.ts";
import type { WorkspaceHandle } from "../src/git/workspace.ts";

// ── A minimal reader for `integration.v1.yaml` only ────────────────────────
//
// `test/workflow-parity/static.test.mjs` carries a general restricted-YAML
// reader, but its parse functions are local to that script and are not
// exported for import — `workflow-stages.test.ts` hits the same wall for
// `development.v1.yaml` and writes its own minimal reader instead; this is
// that same reader adapted to this manifest's own shape.
interface ParsedIntegrationStage {
  id: string;
  kind: string | null;
  role: string | null;
  predicate: string | null;
  authority: string | null;
  freshSession: boolean | null;
  verdicts: string[];
  transitions: Record<string, string>;
  retry: Record<string, number> | null;
}

interface ParsedIntegrationManifest {
  entryStage: string | null;
  terminalOutcomes: { success: string[]; attention: string[]; neutral: string[] };
  caps: Record<string, number>;
  stages: ParsedIntegrationStage[];
}

function parseIntegrationManifest(text: string): ParsedIntegrationManifest {
  const result: ParsedIntegrationManifest = {
    entryStage: null,
    terminalOutcomes: { success: [], attention: [], neutral: [] },
    caps: {},
    stages: [],
  };

  let topSection: "none" | "terminalOutcomes" | "caps" | "stages" = "none";
  let outcomesBucket: "success" | "attention" | "neutral" | null = null;
  let stage: ParsedIntegrationStage | null = null;
  let stageSubsection: "none" | "verdicts" | "transitions" | "retry" = "none";

  for (const raw of text.split("\n")) {
    const entryStageMatch = raw.match(/^ {2}entryStage: (\S+)\s*$/);
    if (entryStageMatch) {
      result.entryStage = entryStageMatch[1] as string;
      continue;
    }
    if (/^ {2}terminalOutcomes:\s*$/.test(raw)) {
      topSection = "terminalOutcomes";
      outcomesBucket = null;
      continue;
    }
    if (/^ {2}caps:\s*$/.test(raw)) {
      topSection = "caps";
      continue;
    }
    if (/^ {2}stages:\s*$/.test(raw)) {
      topSection = "stages";
      continue;
    }

    if (topSection === "terminalOutcomes") {
      const bucketMatch = raw.match(/^ {4}(success|attention|neutral):(.*)$/);
      if (bucketMatch) {
        const inline = (bucketMatch[2] as string).trim();
        outcomesBucket = inline === "[]" ? null : (bucketMatch[1] as "success" | "attention" | "neutral");
        continue;
      }
      const itemMatch = raw.match(/^ {6}- (\S+)\s*$/);
      if (itemMatch && outcomesBucket) {
        result.terminalOutcomes[outcomesBucket].push(itemMatch[1] as string);
        continue;
      }
    }

    if (topSection === "caps") {
      const kv = raw.match(/^ {4}(\w+): (\d+)\s*$/);
      if (kv) {
        result.caps[kv[1] as string] = Number(kv[2]);
        continue;
      }
    }

    if (topSection === "stages") {
      const idMatch = raw.match(/^ {4}- id: (\S+)\s*$/);
      if (idMatch) {
        stage = {
          id: idMatch[1] as string,
          kind: null,
          role: null,
          predicate: null,
          authority: null,
          freshSession: null,
          verdicts: [],
          transitions: {},
          retry: null,
        };
        result.stages.push(stage);
        stageSubsection = "none";
        continue;
      }
      if (!stage) continue;

      const kindMatch = raw.match(/^ {6}kind: (\S+)\s*$/);
      if (kindMatch) {
        stage.kind = kindMatch[1] as string;
        stageSubsection = "none";
        continue;
      }
      const roleMatch = raw.match(/^ {6}role: (\S+)\s*$/);
      if (roleMatch) {
        stage.role = roleMatch[1] as string;
        stageSubsection = "none";
        continue;
      }
      const predicateMatch = raw.match(/^ {6}predicate: (\S+)\s*$/);
      if (predicateMatch) {
        stage.predicate = predicateMatch[1] as string;
        stageSubsection = "none";
        continue;
      }
      const authorityMatch = raw.match(/^ {6}authority: (\S+)\s*$/);
      if (authorityMatch) {
        stage.authority = authorityMatch[1] as string;
        stageSubsection = "none";
        continue;
      }
      const freshSessionMatch = raw.match(/^ {6}freshSession: (\S+)\s*$/);
      if (freshSessionMatch) {
        stage.freshSession = freshSessionMatch[1] === "true";
        stageSubsection = "none";
        continue;
      }
      if (/^ {6}verdicts:\s*$/.test(raw)) {
        stageSubsection = "verdicts";
        continue;
      }
      if (/^ {6}transitions:\s*$/.test(raw)) {
        stageSubsection = "transitions";
        continue;
      }
      if (/^ {6}retry:\s*$/.test(raw)) {
        stage.retry = {};
        stageSubsection = "retry";
        continue;
      }

      if (stageSubsection === "verdicts") {
        const quotedItem = raw.match(/^ {8}- "([^"]+)"\s*$/);
        if (quotedItem) {
          stage.verdicts.push(quotedItem[1] as string);
          continue;
        }
        const bareItem = raw.match(/^ {8}- (\S+)\s*$/);
        if (bareItem) {
          stage.verdicts.push(bareItem[1] as string);
          continue;
        }
        stageSubsection = "none";
      }
      if (stageSubsection === "transitions") {
        const quotedKv = raw.match(/^ {8}"([^"]+)":\s*(\S+)\s*$/);
        if (quotedKv) {
          stage.transitions[quotedKv[1] as string] = quotedKv[2] as string;
          continue;
        }
        const bareKv = raw.match(/^ {8}([A-Za-z][\w-]*):\s*(\S+)\s*$/);
        if (bareKv) {
          stage.transitions[bareKv[1] as string] = bareKv[2] as string;
          continue;
        }
        stageSubsection = "none";
      }
      if (stageSubsection === "retry") {
        const kv = raw.match(/^ {8}(\w+): (\d+)\s*$/);
        if (kv) {
          (stage.retry as Record<string, number>)[kv[1] as string] = Number(kv[2]);
          continue;
        }
        stageSubsection = "none";
      }
    }
  }

  return result;
}

const manifestPath = fileURLToPath(new URL("../../workflows/manifests/integration.v1.yaml", import.meta.url));
const manifest = parseIntegrationManifest(fs.readFileSync(manifestPath, "utf8"));

test("INTEGRATION_ENTRY_STAGE equals the manifest's entryStage", () => {
  assert.equal(manifest.entryStage, "lock-destination");
  assert.equal(INTEGRATION_ENTRY_STAGE, manifest.entryStage);
});

test("INTEGRATION_CAPS equals the manifest's caps block, cap for cap, in both directions", () => {
  assert.deepEqual(INTEGRATION_CAPS, manifest.caps);
});

test("INTEGRATION_TERMINAL_OUTCOMES equals the manifest's spec.terminalOutcomes", () => {
  assert.deepEqual(
    {
      success: [...INTEGRATION_TERMINAL_OUTCOMES.success],
      attention: [...INTEGRATION_TERMINAL_OUTCOMES.attention],
      neutral: [...INTEGRATION_TERMINAL_OUTCOMES.neutral],
    },
    manifest.terminalOutcomes,
  );
});

test("INTEGRATION_STAGES mirrors the manifest's eight stage ids, in order", () => {
  assert.deepEqual(
    INTEGRATION_STAGES.map((s) => s.id),
    manifest.stages.map((s) => s.id),
  );
  assert.deepEqual(INTEGRATION_STAGES.map((s) => s.id), [
    "lock-destination",
    "create-candidate",
    "replay-task",
    "verify-candidate",
    "cross-task-review",
    "advance-destination",
    "persist-integration",
    "cleanup",
  ]);
});

test("INTEGRATION_STAGES mirrors kind, role, predicate, authority, and freshSession per stage", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of INTEGRATION_STAGES) {
    const parsed = byId.get(stage.id);
    assert.ok(parsed, `manifest has no stage ${stage.id}`);
    assert.equal(stage.kind, parsed!.kind, `${stage.id} kind`);
    assert.equal(stage.role, parsed!.role, `${stage.id} role`);
    assert.equal(stage.predicate, parsed!.predicate, `${stage.id} predicate`);
    assert.equal(stage.authority, parsed!.authority, `${stage.id} authority`);
    assert.equal(stage.freshSession, parsed!.freshSession, `${stage.id} freshSession`);
  }
});

test("INTEGRATION_STAGES mirrors transitions, transition for transition, in both directions", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of INTEGRATION_STAGES) {
    const parsed = byId.get(stage.id)!;
    assert.deepEqual(stage.transitions, parsed.transitions, `${stage.id} transitions`);
  }
});

test("INTEGRATION_STAGES mirrors the agent stage's declared verdicts and retry policy", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of INTEGRATION_STAGES) {
    if (stage.kind !== "agent") continue;
    const parsed = byId.get(stage.id)!;
    assert.deepEqual([...stage.verdicts], parsed.verdicts, `${stage.id} verdicts`);
    assert.deepEqual(stage.retry, parsed.retry, `${stage.id} retry`);
  }
});

// ── Driver test fixtures ────────────────────────────────────────────────

const RUN_ID = "run-1";

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function commitFile(dir: string, relPath: string, contents: string, message: string): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", message, "--", relPath]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function fakeClock(startMs: number): { now: () => number } {
  let current = startMs;
  return { now: () => (current += 1) };
}

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function reviewerReport(
  taskId: string,
  verdict: string,
  questions?: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "integration",
    workflowVersion: "1.0.0",
    runId: RUN_ID,
    taskId,
    attemptId: "attempt-fixture",
    stageId: "cross-task-review",
    roleId: "code-quality-reviewer",
    status: "completed",
    verdict,
    summary: `cross-task-review reported ${verdict}`,
    ...(questions !== undefined ? { questions } : {}),
  };
}

function writeReviewerStream(
  streamsDir: string,
  scenario: string,
  taskId: string,
  verdict: string,
  questions?: readonly Record<string, unknown>[],
): void {
  const ops = [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(taskId, verdict, questions) },
    { op: "exit", code: 0 },
  ];
  fs.mkdirSync(streamsDir, { recursive: true });
  fs.writeFileSync(
    path.join(streamsDir, `cross-task-review--${scenario}.jsonl`),
    `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`,
    "utf8",
  );
}

function makeAdapter(streamsDir: string): { adapter: FakeAdapter; queue: (scenario: string) => void } {
  const queue: string[] = [];
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (_attempt: AttemptDescriptor) => {
      const next = queue.shift();
      if (!next) throw new Error("no cross-task-review scenario queued");
      return next;
    },
  });
  return { adapter, queue: (scenario) => queue.push(scenario) };
}

// ── Watchdog timeout on the cross-task-review agent stage (P9d-iii) ───────
// `noopTerminate` above never sends a real signal, so it cannot actually end
// a hung real process (`FakeAdapter.start` always spawns one, regardless of
// scenario). This reuses the real SIGTERM/SIGKILL `terminate`/`isAlive`
// helpers already written for exactly this purpose in
// `timeout-watchdog.test.ts` and mirrored by sibling task P9d-ii's own
// `workflow-stages.test.ts`, rather than inventing a third copy.

function watchdogSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

const realTerminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  let signalSent: NodeJS.Signals | null = null;
  try {
    process.kill(-pgid, "SIGTERM");
    signalSent = "SIGTERM";
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && isAlive(pgid)) {
    await watchdogSleep(10);
  }
  if (isAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
      signalSent = "SIGKILL";
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && isAlive(pgid); i++) await watchdogSleep(10);
  }
  return {
    signalSent,
    exitCode: null,
    killedProcessTree: !isAlive(pgid),
    timedOutWaitingForExit: isAlive(pgid),
  };
};

function makeHangingAdapter(streamsDir: string): { adapter: FakeAdapter; queue: (scenario: string) => void } {
  const queue: string[] = [];
  const adapter = new FakeAdapter({
    terminate: realTerminate,
    streamsDir,
    scenarioFor: (_attempt: AttemptDescriptor) => {
      const next = queue.shift();
      if (!next) throw new Error("no cross-task-review scenario queued");
      return next;
    },
  });
  return { adapter, queue: (scenario) => queue.push(scenario) };
}

interface TestEnv {
  dir: string;
  db: ReturnType<typeof openStore>;
  clock: { now: () => number };
  taskDir: string;
  streamsDir: string;
  destinationSha0: string;
  taskWorkspace: WorkspaceHandle;
}

const TASK_BRANCH = "orga/task/task-1";
const TASK_ID = "task-1";
const OPERATOR_BRANCH = "operator-scratch";

function seedTaskWorktree(env: { dir: string; db: ReturnType<typeof openStore> }, taskWorktreePath: string, baseCommit: string): WorkspaceHandle {
  runGit(env.dir, ["worktree", "add", taskWorktreePath, TASK_BRANCH]);
  withTransaction(env.db, () => {
    env.db
      .prepare(
        `INSERT INTO worktrees (id, run_id, task_id, path, branch, base_commit, cleanup_state, created_at, cleaned_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
      )
      .run(`worktree-${TASK_ID}`, RUN_ID, TASK_ID, taskWorktreePath, TASK_BRANCH, baseCommit, 1000);
  });
  return { mode: "worktree", root: "", path: taskWorktreePath, branch: TASK_BRANCH, baseCommit, recordedDirt: [] };
}

async function withEnv(fn: (env: TestEnv) => Promise<void>): Promise<void> {
  await withTempWorkspace(async (dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    commitFile(dir, "seed.txt", "seed\n", "seed");
    runGit(dir, ["branch", "-M", "main"]);
    const destinationSha0 = runGit(dir, ["rev-parse", "HEAD"]);

    runGit(dir, ["branch", TASK_BRANCH, destinationSha0]);
    runGit(dir, ["checkout", TASK_BRANCH]);
    commitFile(dir, "feature.txt", "feature\n", "add feature");
    runGit(dir, ["checkout", "main"]);

    // The operator's own checkout, resting on something other than the
    // destination branch: `refIsCurrentCheckout` treats a match between the
    // two as a collision, so the fixture's default state must not collide
    // with `destinationRef` ("refs/heads/main") by accident.
    runGit(dir, ["checkout", "-b", OPERATOR_BRANCH]);

    initProject(dir);

    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare("INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)").run(
          RUN_ID,
          "board.yaml",
          "running",
          "starting",
          1_000_000,
        );
      });

      const taskWorktreePath = path.join(dir, ".orga", "worktrees", TASK_ID);
      const taskWorkspace = seedTaskWorktree({ dir, db }, taskWorktreePath, destinationSha0);

      const taskDir = path.join(dir, "task-dir");
      fs.mkdirSync(taskDir, { recursive: true });
      const streamsDir = path.join(dir, "streams");
      fs.mkdirSync(streamsDir, { recursive: true });

      await fn({ dir, db, clock: fakeClock(1_000_000), taskDir, streamsDir, destinationSha0, taskWorkspace });
    } finally {
      db.close();
    }
  });
}

function baseInput(env: TestEnv, adapter: FakeAdapter, overrides: Partial<IntegrationStagesInput> = {}): IntegrationStagesInput {
  return {
    db: env.db,
    adapter,
    runId: RUN_ID,
    taskId: TASK_ID,
    now: env.clock.now,
    projectRoot: env.dir,
    destinationRef: "refs/heads/main",
    taskWorkspace: env.taskWorkspace,
    candidateRoot: path.join(env.dir, ".orga", "worktrees"),
    taskDir: env.taskDir,
    requiredArtifacts: [],
    checks: {},
    env: process.env,
    ...overrides,
  };
}

test("the happy path reaches integrated through all eight stages, and the destination lands the task's change", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", TASK_ID, "pass");
    queue("pass");

    const outcome = await runIntegrationStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "integrated");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      ["lock-destination", "create-candidate", "replay-task", "verify-candidate", "cross-task-review", "advance-destination", "persist-integration", "cleanup"],
    );
    assert.ok(outcome.resultCommit);
    assert.equal(runGit(env.dir, ["rev-parse", "refs/heads/main"]), outcome.resultCommit);
    // `update-ref` moves the branch pointer only; it never touches the
    // operator's working tree, so the task's change is read from the
    // destination's committed history, not from the checked-out file.
    assert.ok(
      runGit(env.dir, ["show", "refs/heads/main:feature.txt"]).includes("feature"),
      "the destination's history now contains the task's change",
    );

    const lockRow = env.db.prepare(`SELECT released_at FROM locks WHERE run_id = ? AND resource = ?`).get(RUN_ID, "refs/heads/main") as {
      released_at: number | null;
    };
    assert.ok(lockRow.released_at, "the destination lock is released on the successful exit path");

    const integrationRow = env.db
      .prepare(`SELECT disposition, result_commit FROM integrations WHERE run_id = ? AND task_id = ?`)
      .get(RUN_ID, TASK_ID) as { disposition: string; result_commit: string };
    assert.equal(integrationRow.disposition, "integrated");
    assert.equal(integrationRow.result_commit, outcome.resultCommit);

    const worktreeRows = env.db.prepare(`SELECT cleanup_state FROM worktrees WHERE run_id = ?`).all(RUN_ID) as Array<{
      cleanup_state: string;
    }>;
    assert.ok(worktreeRows.length >= 2, "the task and candidate worktree rows both exist");
    assert.ok(worktreeRows.every((r) => r.cleanup_state === "cleaned"), "cleanup removed every recorded worktree");
  });
});

test("a hung cross-task-review attempt past its spawn budget is recorded interrupted/signalled/worker-timeout, parks without classification, and still releases the destination lock", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeHangingAdapter(env.streamsDir);
    // No trailing `{"op":"exit",...}`: the replay process sleeps well past
    // the test's own budget and would otherwise run for a full minute.
    fs.writeFileSync(path.join(env.streamsDir, "cross-task-review--hangs.jsonl"), `${JSON.stringify({ op: "sleep", ms: 60000 })}\n`, "utf8");
    queue("hangs");

    const outcome = await runIntegrationStages(
      baseInput(env, adapter, { timeoutBudget: { spawnMs: 150, idleMs: 5000, wallMs: 5000 }, graceMs: 100 }),
    );

    assert.equal(outcome.outcome, "parked");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      ["lock-destination", "create-candidate", "replay-task", "verify-candidate", "cross-task-review"],
    );
    assert.equal(outcome.stages[outcome.stages.length - 1]!.verdict, "worker-timeout");
    assert.equal(outcome.schemaInvalid, undefined);

    const attemptRow = env.db
      .prepare(
        `SELECT id, status, interrupt_reason FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'cross-task-review'`,
      )
      .get(RUN_ID, TASK_ID) as { id: string; status: string; interrupt_reason: string | null };
    assert.equal(attemptRow.status, "interrupted");
    assert.equal(attemptRow.interrupt_reason, "worker-timeout");

    const workerRow = env.db
      .prepare(`SELECT pgid, termination_state FROM workers WHERE attempt_id = ?`)
      .get(attemptRow.id) as { pgid: number; termination_state: string | null };
    assert.equal(workerRow.termination_state, "signalled");
    assert.equal(isAlive(workerRow.pgid), false, "the hung process must actually be dead, not merely marked so");

    const timedOutEvents = env.db
      .prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.timed-out'`)
      .all(RUN_ID) as Array<{ payload: string }>;
    assert.equal(timedOutEvents.length, 1);
    assert.deepEqual(JSON.parse(timedOutEvents[0]!.payload), { firedBudget: "spawn-timeout" });

    const normalizedEvents = env.db
      .prepare(`SELECT id FROM events WHERE run_id = ? AND type = 'attempt.normalized'`)
      .all(RUN_ID);
    assert.equal(normalizedEvents.length, 0, "no attempt.normalized event on the timeout path");

    const lockRow = env.db
      .prepare(`SELECT released_at FROM locks WHERE run_id = ? AND resource = ?`)
      .get(RUN_ID, "refs/heads/main") as { released_at: number | null };
    assert.ok(lockRow.released_at, "the destination lock is released on the timeout-parked exit path");
  });
});

test("a failing candidate routes verify-candidate to ready-to-implement, not parked", async () => {
  await withEnv(async (env) => {
    const { adapter } = makeAdapter(env.streamsDir);
    const outcome = await runIntegrationStages(
      baseInput(env, adapter, { checks: { fail: "false" } }),
    );

    assert.equal(outcome.outcome, "ready-to-implement");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      ["lock-destination", "create-candidate", "replay-task", "verify-candidate"],
    );
  });
});

test("a needs-info verdict from cross-task-review routes to waiting-operator and persists the reported question to the questions table", async () => {
  await withEnv(async (env) => {
    withTransaction(env.db, () => {
      env.db
        .prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(TASK_ID, RUN_ID, TASK_ID, "Task 1", "brief.md", "task-board", null, "[]", 0, "integrating", null, 1000, 1000);
    });

    const reportedQuestion = {
      id: "iq-1",
      taskId: TASK_ID,
      owner: "operator",
      question: "which candidate wins the conflict?",
      context: "cross-task-review found a cross-task conflict",
      impact: "landing the wrong side breaks the destination",
      safeDefault: null,
      blocks: [],
    };

    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "needs-info", TASK_ID, "needs-info", [reportedQuestion]);
    queue("needs-info");

    const outcome = await runIntegrationStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "waiting-operator");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      ["lock-destination", "create-candidate", "replay-task", "verify-candidate", "cross-task-review"],
    );

    const rows = env.db
      .prepare(`SELECT * FROM questions WHERE run_id = ?`)
      .all(RUN_ID) as Array<{ id: string; task_id: string | null; owner: string; prompt: string; status: string; payload: string | null }>;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, `${RUN_ID}#iq-1#${TASK_ID}`);
    assert.equal(row.task_id, TASK_ID);
    assert.equal(row.owner, "operator");
    assert.equal(row.prompt, "which candidate wins the conflict?");
    assert.equal(row.status, "open");
    assert.deepEqual(JSON.parse(row.payload as string), reportedQuestion);
  });
});

test("a conflicting replay parks the task, leaves the destination ref and operator checkout unchanged, and records the conflicting paths", async () => {
  await withEnv(async (env) => {
    runGit(env.dir, ["checkout", "main"]);
    commitFile(env.dir, "feature.txt", "destination edit\n", "destination edits the same file");
    const destinationSha = runGit(env.dir, ["rev-parse", "refs/heads/main"]);
    runGit(env.dir, ["checkout", OPERATOR_BRANCH]);
    const statusBefore = runGit(env.dir, ["status", "--porcelain"]);

    const { adapter } = makeAdapter(env.streamsDir);
    const outcome = await runIntegrationStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      ["lock-destination", "create-candidate", "replay-task"],
    );
    assert.equal(runGit(env.dir, ["rev-parse", "refs/heads/main"]), destinationSha, "the destination ref is unchanged");
    assert.equal(runGit(env.dir, ["status", "--porcelain"]), statusBefore, "the operator checkout is unchanged");

    const row = env.db.prepare(`SELECT checks FROM integrations WHERE run_id = ? AND task_id = ?`).get(RUN_ID, TASK_ID) as {
      checks: string;
    };
    const checks = JSON.parse(row.checks) as { integrationConflict?: { conflictingPaths: string[] } };
    assert.deepEqual(checks.integrationConflict?.conflictingPaths, ["feature.txt"]);
  });
});

test("two concurrent integrations for the same destination produce exactly one holder; the loser never runs create-candidate", async () => {
  await withEnv(async (env) => {
    const { adapter: adapterA, queue: queueA } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", TASK_ID, "pass");
    queueA("pass");
    const { adapter: adapterB } = makeAdapter(env.streamsDir);

    const [outcomeA, outcomeB] = await Promise.all([
      runIntegrationStages(baseInput(env, adapterA, { taskId: TASK_ID })),
      runIntegrationStages(baseInput(env, adapterB, { taskId: "task-2" })),
    ]);

    const outcomes = [outcomeA, outcomeB];
    const holder = outcomes.find((o) => o.stages.some((s) => s.stageId === "create-candidate"));
    const loser = outcomes.find((o) => o !== holder);
    assert.ok(holder, "one of the two attempts must acquire the lock and proceed");
    assert.deepEqual(loser?.stages.map((s) => s.stageId), ["lock-destination"], "the loser never runs create-candidate");
    assert.equal(loser?.outcome, "parked");
  });
});

test("advance-destination's compare-and-swap: an external move between lock and advance is never overwritten, and the rebuild lands both changes", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass-1", TASK_ID, "pass");
    writeReviewerStream(env.streamsDir, "pass-2", TASK_ID, "pass");
    queue("pass-1");
    queue("pass-2");

    let moved = false;
    const outcome = await runIntegrationStages(
      baseInput(env, adapter, {
        beforeAdvanceDestination: () => {
          if (!moved) {
            moved = true;
            runGit(env.dir, ["checkout", "main"]);
            commitFile(env.dir, "external.txt", "external\n", "external move");
            runGit(env.dir, ["checkout", OPERATOR_BRANCH]);
          }
        },
      }),
    );

    assert.equal(outcome.outcome, "integrated");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      [
        "lock-destination",
        "create-candidate",
        "replay-task",
        "verify-candidate",
        "cross-task-review",
        "advance-destination",
        "create-candidate",
        "replay-task",
        "verify-candidate",
        "cross-task-review",
        "advance-destination",
        "persist-integration",
        "cleanup",
      ],
    );
    assert.ok(runGit(env.dir, ["show", "refs/heads/main:external.txt"]).includes("external"), "the external change landed");
    assert.ok(
      runGit(env.dir, ["show", "refs/heads/main:feature.txt"]).includes("feature"),
      "the task's change also landed",
    );
  });
});

test("the create-candidate rebuild loop is bounded by integration_rebuild_cap (default 3); at the cap the task parks with the observed destination shas in evidence", async () => {
  const previous = process.env.ORGA_INTEGRATION_REBUILD_CAP;
  process.env.ORGA_INTEGRATION_REBUILD_CAP = "2";
  try {
    await withEnv(async (env) => {
      const { adapter, queue } = makeAdapter(env.streamsDir);
      writeReviewerStream(env.streamsDir, "pass-1", TASK_ID, "pass");
      writeReviewerStream(env.streamsDir, "pass-2", TASK_ID, "pass");
      queue("pass-1");
      queue("pass-2");

      const outcome = await runIntegrationStages(
        baseInput(env, adapter, {
          beforeAdvanceDestination: () => {
            runGit(env.dir, ["checkout", "main"]);
            commitFile(env.dir, `external-${env.clock.now()}.txt`, "external\n", "external move");
            runGit(env.dir, ["checkout", OPERATOR_BRANCH]);
          },
        }),
      );

      assert.equal(outcome.outcome, "parked");
      // Two successful rebuilds (rounds 1 and 2) each run the full pipeline
      // back to a failing compare-and-swap; the third visit is the
      // over-the-cap round, which returns `false` without building a
      // candidate at all — three visits to `create-candidate` in total.
      const createCandidateVisits = outcome.stages.filter((s) => s.stageId === "create-candidate");
      assert.equal(createCandidateVisits.length, 3);

      const row = env.db.prepare(`SELECT checks FROM integrations WHERE run_id = ? AND task_id = ?`).get(RUN_ID, TASK_ID) as {
        checks: string;
      };
      const checks = JSON.parse(row.checks) as { rebuildCount: number; observedDestinationShas: string[] };
      assert.equal(checks.rebuildCount, 3, "the third, over-cap attempt is recorded before parking");
      assert.equal(checks.observedDestinationShas.length, 3);
    });
  } finally {
    if (previous === undefined) delete process.env.ORGA_INTEGRATION_REBUILD_CAP;
    else process.env.ORGA_INTEGRATION_REBUILD_CAP = previous;
  }
});

test("persist-integration's durable result_commit is accepted by predicates.ts's accept(), and a rewritten history reports the integrationCommit gap instead of a false success", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", TASK_ID, "pass");
    queue("pass");

    const outcome = await runIntegrationStages(baseInput(env, adapter));
    assert.equal(outcome.outcome, "integrated");
    const resultCommit = outcome.resultCommit as string;

    const passingFacts: Facts = {
      verificationMode: "legacy",
      frontmatterStatus: "Done",
      integrationCommit: resultCommit,
      integrationCommitExists: commitExists(resultCommit, env.dir),
      integrationCommitIsAncestor: isAncestor(resultCommit, "refs/heads/main", env.dir),
      implementerCommits: ["deadbeef"],
      implementerCommitsAllExist: true,
      reuseLanded: false,
      specReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
      qualityReviewer: { verdict: "pass", reportExists: true, reportPassLine: true },
      verification: { status: "pass" },
    };
    assert.equal(accept(passingFacts).state, "accepted");

    // Rewrite the destination's history so the recorded integration commit is
    // no longer reachable from it: reset `main` back to the pre-integration
    // commit and advance it past that point with an unrelated commit.
    runGit(env.dir, ["checkout", "main"]);
    runGit(env.dir, ["reset", "--hard", env.destinationSha0]);
    commitFile(env.dir, "unrelated.txt", "unrelated\n", "unrelated history");

    const rewrittenFacts: Facts = {
      ...passingFacts,
      integrationCommitExists: commitExists(resultCommit, env.dir),
      integrationCommitIsAncestor: isAncestor(resultCommit, "refs/heads/main", env.dir),
    };
    const result = accept(rewrittenFacts);
    assert.equal(result.state, "incomplete");
    assert.ok(
      result.gaps.includes("integrationCommit:notAncestor") || result.gaps.includes("integrationCommit:notInRepo"),
      `expected an integrationCommit gap; got ${JSON.stringify(result.gaps)}`,
    );
  });
});

test("cleanup: a failed worktree removal never reports integrated, and the retry after the fix does", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", TASK_ID, "pass");
    queue("pass");

    // Force the task worktree's own removal to fail, mirroring
    // `workspace.test.ts`'s own forced-failure setup: free its branch from
    // the worktree, then check it out in the operator's own repo so `git
    // branch -D` refuses to delete it. Neither call touches the destination
    // ref, so it does not disturb any earlier stage's own work.
    runGit(env.dir, ["worktree", "remove", "--force", env.taskWorkspace.path]);
    runGit(env.dir, ["checkout", TASK_BRANCH]);

    const firstOutcome = await runIntegrationStages(baseInput(env, adapter));
    assert.equal(firstOutcome.outcome, "cleanup-pending");
    assert.notEqual(firstOutcome.outcome, "integrated");

    const worktreeRow = env.db
      .prepare(`SELECT cleanup_state FROM worktrees WHERE run_id = ? AND path = ?`)
      .get(RUN_ID, env.taskWorkspace.path) as { cleanup_state: string };
    assert.equal(worktreeRow.cleanup_state, "orphaned");

    const integrationRow = env.db
      .prepare(`SELECT disposition, result_commit FROM integrations WHERE run_id = ? AND task_id = ?`)
      .get(RUN_ID, TASK_ID) as { disposition: string; result_commit: string | null };
    assert.equal(integrationRow.disposition, "integrated", "the evidence is durable even though cleanup hasn't finished");
    assert.ok(integrationRow.result_commit);

    // Fix the branch conflict and retry: the retry resumes cleanup only, and
    // never re-runs cross-task-review or re-attempts the compare-and-swap.
    runGit(env.dir, ["checkout", "main"]);
    const retryOutcome = await runIntegrationStages(baseInput(env, adapter));
    assert.equal(retryOutcome.outcome, "integrated");
    assert.deepEqual(retryOutcome.stages, []);

    const worktreeRowsAfter = env.db.prepare(`SELECT cleanup_state FROM worktrees WHERE run_id = ?`).all(RUN_ID) as Array<{
      cleanup_state: string;
    }>;
    assert.ok(worktreeRowsAfter.every((r) => r.cleanup_state === "cleaned"));
  });
});

test("lock-destination refuses and parks with destinationEqualsOperatorCheckout evidence when destinationRef is the operator's live checkout", async () => {
  await withEnv(async (env) => {
    runGit(env.dir, ["checkout", "main"]);
    const { adapter } = makeAdapter(env.streamsDir);

    const outcome = await runIntegrationStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.deepEqual(outcome.stages.map((s) => s.stageId), ["lock-destination"]);

    const lockRows = env.db
      .prepare(`SELECT id FROM locks WHERE run_id = ? AND resource = ?`)
      .all(RUN_ID, "refs/heads/main");
    assert.equal(lockRows.length, 0, "no lock row is inserted when the checkout collides");

    const row = env.db.prepare(`SELECT checks FROM integrations WHERE run_id = ? AND task_id = ?`).get(RUN_ID, TASK_ID) as {
      checks: string;
    };
    const checks = JSON.parse(row.checks) as { destinationEqualsOperatorCheckout?: boolean };
    assert.equal(checks.destinationEqualsOperatorCheckout, true);
  });
});

test("advance-destination treats the operator checking out the destination between lock-destination and advance-destination as a lost compare-and-swap, taking the rebuild-loop path with no ref move", async () => {
  const previous = process.env.ORGA_INTEGRATION_REBUILD_CAP;
  process.env.ORGA_INTEGRATION_REBUILD_CAP = "1";
  try {
    await withEnv(async (env) => {
      const { adapter, queue } = makeAdapter(env.streamsDir);
      writeReviewerStream(env.streamsDir, "pass", TASK_ID, "pass");
      queue("pass");

      const outcome = await runIntegrationStages(
        baseInput(env, adapter, {
          beforeAdvanceDestination: () => {
            runGit(env.dir, ["checkout", "main"]);
          },
        }),
      );

      assert.equal(outcome.outcome, "parked");
      assert.deepEqual(
        outcome.stages.map((s) => s.stageId),
        ["lock-destination", "create-candidate", "replay-task", "verify-candidate", "cross-task-review", "advance-destination", "create-candidate"],
      );
      assert.equal(
        runGit(env.dir, ["rev-parse", "refs/heads/main"]),
        env.destinationSha0,
        "no ref move: the live checkout collision skips update-ref entirely",
      );
    });
  } finally {
    if (previous === undefined) delete process.env.ORGA_INTEGRATION_REBUILD_CAP;
    else process.env.ORGA_INTEGRATION_REBUILD_CAP = previous;
  }
});

function freshCtx(input: IntegrationStagesInput): IntegrationDriverContext {
  return {
    input,
    integrationId: randomUUID(),
    lockId: null,
    destinationSha: null,
    candidate: null,
    rebuildCount: 0,
    observedDestinationShas: [],
    lastAgentAttempt: null,
    lastAgentReport: null,
    resultCommit: null,
  };
}

test("acquireDestinationLock reclaims a stale unreleased integration lock and leaves exactly one unreleased row", async () => {
  await withEnv(async (env) => {
    const { adapter } = makeAdapter(env.streamsDir);
    const input = baseInput(env, adapter);
    const staleHeartbeat = env.clock.now() - (integrationLockStaleMs() + 1);
    withTransaction(env.db, () => {
      env.db
        .prepare(
          `INSERT INTO locks (id, run_id, kind, resource, owner_pid, acquired_at, heartbeat_at, released_at)
           VALUES (?, ?, 'integration', ?, ?, ?, ?, NULL)`,
        )
        .run("stale-lock", RUN_ID, "refs/heads/main", 999999, staleHeartbeat, staleHeartbeat);
    });

    const ctx = freshCtx(input);
    const verdict = acquireDestinationLock(ctx);

    assert.equal(verdict, "true");
    const rows = env.db.prepare(`SELECT id, released_at FROM locks WHERE resource = ?`).all("refs/heads/main") as Array<{
      id: string;
      released_at: number | null;
    }>;
    const unreleased = rows.filter((r) => r.released_at === null);
    assert.equal(unreleased.length, 1, "the stale row is reclaimed and exactly one unreleased row remains");
    assert.equal(unreleased[0]?.id, ctx.lockId, "the surviving unreleased row is the one just acquired");
  });
});

test("acquireDestinationLock still rejects a fresh unreleased integration lock for the same resource", async () => {
  await withEnv(async (env) => {
    const { adapter } = makeAdapter(env.streamsDir);
    const input = baseInput(env, adapter);
    const freshHeartbeat = env.clock.now();
    withTransaction(env.db, () => {
      env.db
        .prepare(
          `INSERT INTO locks (id, run_id, kind, resource, owner_pid, acquired_at, heartbeat_at, released_at)
           VALUES (?, ?, 'integration', ?, ?, ?, ?, NULL)`,
        )
        .run("fresh-lock", RUN_ID, "refs/heads/main", 999999, freshHeartbeat, freshHeartbeat);
    });

    const ctx = freshCtx(input);
    const verdict = acquireDestinationLock(ctx);

    assert.equal(verdict, "false");
    const rows = env.db.prepare(`SELECT id, released_at FROM locks WHERE resource = ?`).all("refs/heads/main") as Array<{
      id: string;
      released_at: number | null;
    }>;
    assert.equal(rows.length, 1, "no new row is inserted when the existing one is still fresh");
    assert.equal(rows[0]?.released_at, null);
    assert.equal(ctx.lockId, null, "the loser records no lock of its own");
  });
});

// ── `in-place` mode's integration path ──────────────────────────────────

test("advanceIntegration('commit-on-branch') lands exactly one commit via a plain git commit, never update-ref", async () => {
  await withTempWorkspace(async (dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    const before = commitFile(dir, "seed.txt", "seed\n", "seed");
    runGit(dir, ["branch", "-M", "main"]);

    fs.writeFileSync(path.join(dir, "claimed.txt"), "claimed contents\n", "utf8");

    const sha = advanceIntegration({
      strategy: "commit-on-branch",
      projectRoot: dir,
      claimedPaths: ["claimed.txt"],
      message: "land claimed.txt",
    });

    assert.equal(runGit(dir, ["rev-parse", "HEAD"]), sha);
    assert.equal(runGit(dir, ["rev-parse", "HEAD^"]), before, "exactly one new commit, parented at the prior tip");
    assert.equal(runGit(dir, ["rev-list", "--count", `${before}..${sha}`]), "1");
    assert.equal(runGit(dir, ["show", "HEAD:claimed.txt"]), "claimed contents");

    const reflogSubjects = runGit(dir, ["reflog", "show", "--format=%gs", "refs/heads/main"]).split("\n");
    assert.ok(
      reflogSubjects[0]?.startsWith("commit"),
      `the newest reflog entry must be a commit, not an update-ref move; got ${JSON.stringify(reflogSubjects[0])}`,
    );
    assert.ok(
      !reflogSubjects.some((subject) => subject.startsWith("update-ref") || subject.includes("update by push")),
      `no update-ref reflog entry may exist; got ${JSON.stringify(reflogSubjects)}`,
    );
  });
});

const IN_PLACE_RUN_ID = "run-in-place";
const IN_PLACE_TASK_ID = "task-in-place";
const IN_PLACE_BRANCH = "main";

interface InPlaceTestEnv {
  dir: string;
  db: ReturnType<typeof openStore>;
  clock: { now: () => number };
  taskDir: string;
  streamsDir: string;
  destinationSha0: string;
  taskWorkspace: WorkspaceHandle;
}

// The `in-place` counterpart to `withEnv` above: `taskWorkspace.path` is the
// same directory as `projectRoot` (in-place mode's destination is the
// operator's live checkout by construction, every time), and the claim
// set's paths are pre-populated as uncommitted working-tree edits — never
// committed to any branch — mirroring the shape `createInPlaceWorkspace`
// (`git/in-place.ts`) itself hands the engine.
async function withInPlaceEnv(claimedPaths: readonly string[], fn: (env: InPlaceTestEnv) => Promise<void>): Promise<void> {
  await withTempWorkspace(async (dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    commitFile(dir, "seed.txt", "seed\n", "seed");
    runGit(dir, ["branch", "-M", IN_PLACE_BRANCH]);
    const destinationSha0 = runGit(dir, ["rev-parse", "HEAD"]);

    initProject(dir);

    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare("INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)").run(
          IN_PLACE_RUN_ID,
          "board.yaml",
          "running",
          "starting",
          1_000_000,
        );
        db.prepare(
          `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(`claim-${IN_PLACE_TASK_ID}`, IN_PLACE_RUN_ID, IN_PLACE_TASK_ID, "files", JSON.stringify(claimedPaths), 1000);
      });

      for (const claimedPath of claimedPaths) {
        fs.writeFileSync(path.join(dir, claimedPath), `${claimedPath} contents\n`, "utf8");
      }

      const taskWorkspace: WorkspaceHandle = {
        mode: "in-place",
        root: "",
        path: dir,
        branch: IN_PLACE_BRANCH,
        baseCommit: destinationSha0,
        recordedDirt: [],
      };

      // `.orga`-rooted, mirroring `scheduler.ts`'s own `taskEvidenceDir`
      // placement: `.orga/` is gitignored, so the barrier's ledger write
      // (`writeLedger`, run at `verify-candidate` on every attempt) never
      // shows up as untracked content in the operator's own checkout, here
      // the same directory as `projectRoot` in `in-place` mode.
      const taskDir = path.join(dir, ".orga", "task-dir");
      fs.mkdirSync(taskDir, { recursive: true });
      const streamsDir = path.join(dir, "streams");
      fs.mkdirSync(streamsDir, { recursive: true });

      await fn({ dir, db, clock: fakeClock(1_000_000), taskDir, streamsDir, destinationSha0, taskWorkspace });
    } finally {
      db.close();
    }
  });
}

function inPlaceInput(
  env: InPlaceTestEnv,
  adapter: FakeAdapter | ProcessAdapter,
  overrides: Partial<IntegrationStagesInput> = {},
): IntegrationStagesInput {
  return {
    db: env.db,
    adapter,
    runId: IN_PLACE_RUN_ID,
    taskId: IN_PLACE_TASK_ID,
    now: env.clock.now,
    projectRoot: env.dir,
    destinationRef: `refs/heads/${IN_PLACE_BRANCH}`,
    taskWorkspace: env.taskWorkspace,
    candidateRoot: path.join(env.dir, ".orga", "worktrees"),
    taskDir: env.taskDir,
    requiredArtifacts: [],
    checks: {},
    env: process.env,
    ...overrides,
  };
}

function candidateWorktreePath(env: InPlaceTestEnv): string {
  const row = env.db
    .prepare(`SELECT path FROM worktrees WHERE run_id = ? AND task_id = ?`)
    .get(IN_PLACE_RUN_ID, IN_PLACE_TASK_ID) as { path: string } | undefined;
  if (!row) throw new Error("no candidate worktree row recorded yet");
  return row.path;
}

test("acquireDestinationLock: in-place mode skips the live-checkout collision check and acquires the lock even though the destination is the operator's current branch", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const { adapter } = makeAdapter(env.streamsDir);
    assert.ok(
      refIsCurrentCheckout(env.dir, `refs/heads/${IN_PLACE_BRANCH}`),
      "sanity: the destination equals the operator's live checkout, by construction, in in-place mode",
    );

    const ctx = freshCtx(inPlaceInput(env, adapter));
    const verdict = acquireDestinationLock(ctx);

    assert.equal(verdict, "true", "the collision check never fires for in-place mode");
    const rows = env.db
      .prepare(`SELECT id FROM locks WHERE run_id = ? AND resource = ?`)
      .all(IN_PLACE_RUN_ID, `refs/heads/${IN_PLACE_BRANCH}`);
    assert.equal(rows.length, 1, "the lock is actually acquired, proving lock-destination reaches create-candidate next");
  });
});

test("in-place mode: the review candidate carries the claim set's current content, not the destination's pre-task state", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", IN_PLACE_TASK_ID, "pass");
    queue("pass");

    assert.throws(
      () => runGit(env.dir, ["cat-file", "-e", `${env.destinationSha0}:feature.txt`]),
      "sanity: the destination's pre-task state never had feature.txt",
    );

    let candidateContent: string | null = null;
    const outcome = await runIntegrationStages(
      inPlaceInput(env, adapter, {
        beforeAdvanceDestination: () => {
          candidateContent = fs.readFileSync(path.join(candidateWorktreePath(env), "feature.txt"), "utf8");
        },
      }),
    );

    assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);
    assert.equal(candidateContent, "feature.txt contents\n");
  });
});

test("in-place mode: replay-task never cherry-picks; the candidate's history is exactly [destinationSha, reviewSha]", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", IN_PLACE_TASK_ID, "pass");
    queue("pass");

    let candidateHistory: string[] = [];
    const outcome = await runIntegrationStages(
      inPlaceInput(env, adapter, {
        beforeAdvanceDestination: () => {
          candidateHistory = runGit(candidateWorktreePath(env), ["log", "--format=%H"])
            .split("\n")
            .filter((line) => line.length > 0);
        },
      }),
    );

    assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);
    assert.equal(candidateHistory.length, 2, "exactly two commits: the destination, and the manufactured review commit on top of it");
    assert.equal(candidateHistory[1], env.destinationSha0, "the older commit is the destination's own sha, unmodified");
    assert.notEqual(
      candidateHistory[0],
      env.destinationSha0,
      "the newer commit is the manufactured review commit; no cherry-pick-authored commit sits between them",
    );
  });
});

test("in-place mode: advance-destination skips the live-checkout collision check and lands exactly one plain commit; git worktree list is unchanged after a full run", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", IN_PLACE_TASK_ID, "pass");
    queue("pass");

    const worktreePathsBefore = runGit(env.dir, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "));

    const outcome = await runIntegrationStages(inPlaceInput(env, adapter));

    assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);
    assert.ok(outcome.resultCommit);
    assert.equal(runGit(env.dir, ["rev-parse", `refs/heads/${IN_PLACE_BRANCH}`]), outcome.resultCommit);
    assert.equal(
      runGit(env.dir, ["rev-list", "--count", `${env.destinationSha0}..${outcome.resultCommit}`]),
      "1",
      "exactly one commit lands on the destination branch",
    );

    const row = env.db
      .prepare(`SELECT checks FROM integrations WHERE run_id = ? AND task_id = ?`)
      .get(IN_PLACE_RUN_ID, IN_PLACE_TASK_ID) as { checks: string };
    const checks = JSON.parse(row.checks) as { destinationEqualsOperatorCheckout?: boolean };
    assert.equal(
      checks.destinationEqualsOperatorCheckout,
      undefined,
      "the live-checkout collision check never runs for in-place mode, so it never records this evidence",
    );

    const worktreePathsAfter = runGit(env.dir, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    assert.deepEqual(
      worktreePathsAfter,
      worktreePathsBefore,
      "the set of worktree paths (the operator's own checkout, and only it) is unchanged after a full in-place integration",
    );
  });
});

test("in-place mode: cleanup never removes the operator's own checkout as a worktree; a full run leaves git worktree list showing only that checkout", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "pass", IN_PLACE_TASK_ID, "pass");
    queue("pass");

    const outcome = await runIntegrationStages(inPlaceInput(env, adapter));
    assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);

    const entries = runGit(env.dir, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree "));
    assert.equal(entries.length, 1, "only the operator's own checkout remains as a worktree");
    assert.ok(entries[0]?.includes(env.dir), "the sole remaining worktree is the operator's own checkout");

    const taskWorktreeRow = env.db
      .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND path = ?`)
      .get(IN_PLACE_RUN_ID, env.dir) as { n: number };
    assert.equal(
      taskWorktreeRow.n,
      0,
      "no worktrees row is ever inserted for the operator's own checkout, so cleanup never targets it for removal",
    );

    const pendingRows = env.db
      .prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE run_id = ? AND task_id = ? AND cleanup_state != 'cleaned'`)
      .get(IN_PLACE_RUN_ID, IN_PLACE_TASK_ID) as { n: number };
    assert.equal(pendingRows.n, 0, "the review candidate worktree is fully cleaned up");
  });
});

test("in-place mode: cross-task-review runs with the review candidate as its working directory, and observes the claim set's actual content", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const workingDirectories: string[] = [];
    // Reads the claimed path's content from inside the candidate the moment
    // the reviewer attempt starts, before `cleanup` later removes that
    // worktree: `collect`/`classify` would see it gone by the time the whole
    // pipeline (awaited fully below) has already run to completion.
    const observedContents: string[] = [];
    const inner = new FakeAdapter({ terminate: noopTerminate, streamsDir: env.streamsDir, scenarioFor: () => "pass" });
    const capturingAdapter: ProcessAdapter = {
      probe: (configuration) => inner.probe(configuration),
      start: async (attempt, packet, surface) => {
        workingDirectories.push(surface.workingDirectory);
        observedContents.push(fs.readFileSync(path.join(surface.workingDirectory, "feature.txt"), "utf8"));
        return inner.start(attempt, packet, surface);
      },
      observe: (handle) => inner.observe(handle),
      cancel: (handle, gracePeriodMs) => inner.cancel(handle, gracePeriodMs),
      collect: (handle) => inner.collect(handle),
      classify: (artifacts) => inner.classify(artifacts),
    };
    writeReviewerStream(env.streamsDir, "pass", IN_PLACE_TASK_ID, "pass");

    const outcome = await runIntegrationStages(inPlaceInput(env, capturingAdapter));

    assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);
    assert.equal(workingDirectories.length, 1, "cross-task-review dispatches exactly one attempt");
    assert.notEqual(workingDirectories[0], env.dir, "the reviewer never runs directly in the operator's checkout");
    assert.equal(
      observedContents[0],
      "feature.txt contents\n",
      "the reviewer's working directory carries the claim set's actual, current content",
    );
  });
});

test("in-place mode: a failed cross-task-review never resets, checks out, stashes, or reverts the operator's checkout", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeReviewerStream(env.streamsDir, "fail", IN_PLACE_TASK_ID, "fail-with-severity: critical");
    queue("fail");

    const headBefore = runGit(env.dir, ["rev-parse", `refs/heads/${IN_PLACE_BRANCH}`]);
    const branchBefore = runGit(env.dir, ["symbolic-ref", "--short", "HEAD"]);
    const contentBefore = fs.readFileSync(path.join(env.dir, "feature.txt"), "utf8");
    const statusBefore = runGit(env.dir, ["status", "--porcelain"]);

    const outcome = await runIntegrationStages(inPlaceInput(env, adapter));

    assert.equal(outcome.outcome, "ready-to-implement", `expected ready-to-implement; got ${JSON.stringify(outcome)}`);
    assert.equal(
      runGit(env.dir, ["rev-parse", `refs/heads/${IN_PLACE_BRANCH}`]),
      headBefore,
      "the operator's branch gains zero commits on a failed review",
    );
    assert.equal(runGit(env.dir, ["symbolic-ref", "--short", "HEAD"]), branchBefore, "the operator's checkout is never checked out elsewhere");
    assert.equal(
      fs.readFileSync(path.join(env.dir, "feature.txt"), "utf8"),
      contentBefore,
      "the claimed path's content is byte-identical to what the task itself wrote, never reset or reverted",
    );
    assert.equal(
      runGit(env.dir, ["status", "--porcelain"]),
      statusBefore,
      "the operator's working tree and index are byte-identical to their pre-integration state on a failed review",
    );
  });
});

test("in-place mode: an unrelated file staged in the operator's real index is never leaked into the review candidate or the landed commit, and remains staged throughout", async () => {
  await withInPlaceEnv(["feature.txt"], async (env) => {
    fs.writeFileSync(path.join(env.dir, "unrelated.txt"), "unrelated contents\n", "utf8");
    runGit(env.dir, ["add", "--", "unrelated.txt"]);
    const stagedBefore = runGit(env.dir, ["diff", "--cached", "--name-only"]);

    const workingDirectories: string[] = [];
    const candidateUnrelatedPresence: boolean[] = [];
    const inner = new FakeAdapter({ terminate: noopTerminate, streamsDir: env.streamsDir, scenarioFor: () => "pass" });
    const capturingAdapter: ProcessAdapter = {
      probe: (configuration) => inner.probe(configuration),
      start: async (attempt, packet, surface) => {
        workingDirectories.push(surface.workingDirectory);
        candidateUnrelatedPresence.push(fs.existsSync(path.join(surface.workingDirectory, "unrelated.txt")));
        return inner.start(attempt, packet, surface);
      },
      observe: (handle) => inner.observe(handle),
      cancel: (handle, gracePeriodMs) => inner.cancel(handle, gracePeriodMs),
      collect: (handle) => inner.collect(handle),
      classify: (artifacts) => inner.classify(artifacts),
    };
    writeReviewerStream(env.streamsDir, "pass", IN_PLACE_TASK_ID, "pass");

    const outcome = await runIntegrationStages(inPlaceInput(env, capturingAdapter));

    assert.equal(outcome.outcome, "integrated", `expected integrated; got ${JSON.stringify(outcome)}`);
    assert.equal(workingDirectories.length, 1, "cross-task-review dispatches exactly one attempt");
    assert.deepEqual(
      candidateUnrelatedPresence,
      [false],
      "the unrelated staged file never leaks into the review candidate's working directory",
    );

    assert.ok(outcome.resultCommit);
    const landedFiles = runGit(env.dir, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    assert.ok(!landedFiles.includes("unrelated.txt"), "the unrelated staged file is absent from the landed commit's tree");
    assert.ok(landedFiles.includes("feature.txt"), "the claimed file is present in the landed commit's tree");

    assert.equal(
      runGit(env.dir, ["diff", "--cached", "--name-only"]),
      stagedBefore,
      "the unrelated file remains staged, never swept or reset, across the whole integration",
    );
  });
});
