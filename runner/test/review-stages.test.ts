import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../src/adapters/adapter.ts";
import {
  DEVELOPMENT_STAGES,
  runDevelopmentStages,
  type DevelopmentStageInput,
} from "../src/engine/workflow-stages.ts";
import {
  buildRepairPacket,
  createReviewerWorkspaceResolver,
  partitionFindings,
  type ReviewFinding,
} from "../src/engine/review-stages.ts";
import { createWorkspace, DEFAULT_BRANCH_PREFIX, DEFAULT_WORKTREE_ROOT } from "../src/git/workspace.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const RUN_ID = "run-1";
const TASK_ID = "task-1";
const TASK_KEY = "task-1";

function fakeClock(startMs: number): { now: () => number } {
  let current = startMs;
  return {
    now: () => {
      current += 1;
      return current;
    },
  };
}

const noopTerminate: TerminateFn = async () => ({
  signalSent: null,
  exitCode: null,
  killedProcessTree: true,
  timedOutWaitingForExit: false,
});

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function initGitProject(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  runGit(dir, ["config", "user.name", "Test User"]);
  runGit(dir, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n", "utf8");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "-m", "seed"]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function commitAll(dir: string, message: string): string {
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "-q", "--allow-empty", "-m", message]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function reviewerWorktreePaths(dir: string): string[] {
  const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    const match = /^worktree (.+)$/.exec(line);
    if (match) paths.push(match[1] as string);
  }
  return paths.filter((p) => p.includes(`${path.sep}${TASK_KEY}-review-`));
}

function implementerReport(stageId: string, status: string): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: RUN_ID,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId: "implementer",
    status,
    summary: `implementer reported ${status}`,
  };
}

function reviewerReport(
  stageId: string,
  roleId: string,
  verdict: string,
  findings?: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    protocolVersion: "1",
    workflowId: "dev-workflow",
    workflowVersion: "2.0.0",
    runId: RUN_ID,
    taskId: TASK_ID,
    attemptId: "attempt-fixture",
    stageId,
    roleId,
    status: "completed",
    verdict,
    summary: `reviewer reported ${verdict}`,
    ...(findings ? { findings } : {}),
  };
}

function writeStreamFile(streamsDir: string, stageId: string, scenario: string, ops: readonly unknown[]): void {
  const filePath = path.join(streamsDir, `${stageId}--${scenario}.jsonl`);
  fs.writeFileSync(filePath, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

function queueImplementerScenario(
  streamsDir: string,
  stageId: string,
  scenario: string,
  status: string,
  writeFile?: { path: string; text: string },
): void {
  const ops: unknown[] = [{ op: "output", text: "working" }];
  if (writeFile) ops.push({ op: "write-file", path: writeFile.path, text: writeFile.text });
  ops.push({ op: "report", report: implementerReport(stageId, status) });
  ops.push({ op: "exit", code: 0 });
  writeStreamFile(streamsDir, stageId, scenario, ops);
}

function queueReviewerScenario(
  streamsDir: string,
  stageId: string,
  roleId: string,
  scenario: string,
  verdict: string,
  findings?: readonly Record<string, unknown>[],
): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(stageId, roleId, verdict, findings) },
    { op: "exit", code: 0 },
  ]);
}

function makeAdapter(streamsDir: string): {
  adapter: FakeAdapter;
  queue: (stageId: string, scenario: string) => void;
  descriptors: AttemptDescriptor[];
} {
  const queues = new Map<string, string[]>();
  const descriptors: AttemptDescriptor[] = [];
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (attempt: AttemptDescriptor) => {
      descriptors.push(attempt);
      const queue = queues.get(attempt.stageId);
      if (queue && queue.length > 0) return queue.shift() as string;
      throw new Error(`no scenario queued for stage ${attempt.stageId}`);
    },
  });
  return {
    adapter,
    queue: (stageId, scenario) => {
      const existing = queues.get(stageId) ?? [];
      existing.push(scenario);
      queues.set(stageId, existing);
    },
    descriptors,
  };
}

interface TestEnv {
  dir: string;
  db: ReturnType<typeof openStore>;
  clock: { now: () => number };
  taskDir: string;
  streamsDir: string;
}

async function withEnv(fn: (env: TestEnv) => Promise<void>): Promise<void> {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(RUN_ID, "board.yaml", "running", "starting", 1_000_000);
      });
      const taskDir = path.join(dir, "task-dir");
      fs.mkdirSync(taskDir, { recursive: true });
      const streamsDir = path.join(dir, "streams");
      fs.mkdirSync(streamsDir, { recursive: true });
      await fn({ dir, db, clock: fakeClock(1_000_000), taskDir, streamsDir });
    } finally {
      db.close();
    }
  });
}

function seedFilesClaim(db: ReturnType<typeof openStore>, runId: string, taskId: string, paths: string[]): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO claims (id, run_id, task_id, dimension, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`claim-${taskId}`, runId, taskId, "files", JSON.stringify(paths), 1000);
  });
}

function baseInput(env: TestEnv, adapter: FakeAdapter, overrides: Partial<DevelopmentStageInput> = {}): DevelopmentStageInput {
  return {
    db: env.db,
    adapter,
    runId: RUN_ID,
    taskId: TASK_ID,
    now: env.clock.now,
    taskDir: env.taskDir,
    executionRoot: env.dir,
    requiredArtifacts: [],
    checks: {},
    env: process.env,
    ...overrides,
  };
}

// ── a fail-then-repair round's two review-spec rounds each run fresh, in
// their own worktree, and both are cleaned up ──

test("two review-spec rounds run in distinct fresh worktrees with distinct attempts, pids, and authority, and both worktrees are cleaned up", async () => {
  await withEnv(async (env) => {
    const mainBaseCommit = initGitProject(env.dir);
    const mainWorkspace = await createWorkspace({
      mode: "worktree",
      db: env.db,
      projectRoot: env.dir,
      runId: RUN_ID,
      taskId: TASK_ID,
      taskKey: TASK_KEY,
      ref: mainBaseCommit,
      root: DEFAULT_WORKTREE_ROOT,
      branchPrefix: DEFAULT_BRANCH_PREFIX,
    });
    seedFilesClaim(env.db, RUN_ID, TASK_ID, ["output.txt"]);

    const { adapter, queue, descriptors } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed", {
      path: "output.txt",
      text: "first\n",
    });
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail", "fail");
    queue("review-spec", "fail");
    queueImplementerScenario(env.streamsDir, "fix-spec", "completed", "completed", {
      path: "output.txt",
      text: "fixed\n",
    });
    queue("fix-spec", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    let reviewedRef = mainBaseCommit;
    const reviewSpecRefs: string[] = [];
    const reviewerWorkspace = createReviewerWorkspaceResolver({
      db: env.db,
      projectRoot: env.dir,
      root: DEFAULT_WORKTREE_ROOT,
      branchPrefix: DEFAULT_BRANCH_PREFIX,
      taskKey: TASK_KEY,
      reviewedRef: () => reviewedRef,
    });

    const outcome = await runDevelopmentStages(
      baseInput(env, adapter, {
        workspace: mainWorkspace,
        reviewerWorkspace,
        packet: (stageId) => {
          if (stageId === "review-spec" || stageId === "review-quality") {
            reviewedRef = commitAll(mainWorkspace.path, `snapshot for ${stageId}`);
          }
          if (stageId === "review-spec") reviewSpecRefs.push(reviewedRef);
          return `packet ${stageId}`;
        },
      }),
    );

    assert.equal(outcome.outcome, "integrating");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      [
        "implement",
        "collect-implementation-artifacts",
        "verify-task",
        "review-spec",
        "fix-spec",
        "collect-implementation-artifacts",
        "verify-task",
        "review-spec",
        "review-quality",
        "record-minors",
        "ready-to-integrate",
      ],
    );

    // every review-spec/review-quality descriptor's stage maps to
    // `authority: read-only` in the mirrored table; every implement/fix-spec
    // descriptor maps to `workspace-write`.
    const authorityById = new Map(DEVELOPMENT_STAGES.map((s) => [s.id, s.authority]));
    for (const descriptor of descriptors) {
      const expected = descriptor.stageId === "review-spec" || descriptor.stageId === "review-quality"
        ? "read-only"
        : "workspace-write";
      assert.equal(authorityById.get(descriptor.stageId), expected, `${descriptor.stageId} authority`);
    }

    const reviewSpecAttempts = env.db
      .prepare(
        `SELECT id FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'review-spec' ORDER BY round ASC`,
      )
      .all(RUN_ID, TASK_ID) as Array<{ id: string }>;
    assert.equal(reviewSpecAttempts.length, 2);
    assert.notEqual(reviewSpecAttempts[0]!.id, reviewSpecAttempts[1]!.id);

    // two distinct attempts.id values, two distinct pids.
    const pids = reviewSpecAttempts.map((attempt) => {
      const worker = env.db
        .prepare(`SELECT pid FROM workers WHERE attempt_id = ?`)
        .get(attempt.id) as { pid: number };
      return worker.pid;
    });
    assert.notEqual(pids[0], pids[1]);

    // two distinct reviewer worktree paths, one per round, on branches
    // that were never merged or pushed (both checks below only see local
    // state, so "never pushed" holds vacuously in a fixture with no remote).
    const reviewSpecWorktrees = env.db
      .prepare(
        `SELECT path, branch, cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ? AND branch LIKE ? ORDER BY created_at ASC`,
      )
      .all(RUN_ID, TASK_ID, `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-spec-r%`) as Array<{
      path: string;
      branch: string;
      cleanup_state: string;
    }>;
    assert.equal(reviewSpecWorktrees.length, 2);
    assert.notEqual(reviewSpecWorktrees[0]!.path, reviewSpecWorktrees[1]!.path);
    assert.equal(reviewSpecWorktrees[0]!.branch, `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-spec-r1`);
    assert.equal(reviewSpecWorktrees[1]!.branch, `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-spec-r2`);

    // every reviewer worktree's row reached cleanup_state = 'cleaned',
    // and none of them remain in `git worktree list`.
    const allReviewerWorktrees = env.db
      .prepare(
        `SELECT path, cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ? AND (branch LIKE ? OR branch LIKE ?)`,
      )
      .all(
        RUN_ID,
        TASK_ID,
        `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-spec-r%`,
        `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-quality-r%`,
      ) as Array<{ path: string; cleanup_state: string }>;
    assert.equal(allReviewerWorktrees.length, 3);
    for (const row of allReviewerWorktrees) {
      assert.equal(row.cleanup_state, "cleaned", row.path);
    }
    assert.deepEqual(reviewerWorktreePaths(env.dir), []);

    // Each round's ref genuinely reflects that round's own state, checked
    // with `git show <ref>:<path>` against the repository's own object
    // store (still readable after the reviewer worktrees themselves are
    // removed, since the commit objects persist) rather than trusting that
    // a distinct sha necessarily carries distinct content.
    assert.equal(reviewSpecRefs.length, 2);
    assert.notEqual(reviewSpecRefs[0], reviewSpecRefs[1]);
    const round1Content = execFileSync("git", ["show", `${reviewSpecRefs[0]}:output.txt`], {
      cwd: env.dir,
      encoding: "utf8",
    });
    assert.equal(round1Content, "first\n");
    const round2Content = execFileSync("git", ["show", `${reviewSpecRefs[1]}:output.txt`], {
      cwd: env.dir,
      encoding: "utf8",
    });
    assert.equal(round2Content, "fixed\n");
  });
});

// ── the reviewer worktree is removed on the throw path too ─────────

test("a review-spec attempt that throws before dispatch still removes its reviewer worktree", async () => {
  await withEnv(async (env) => {
    const mainBaseCommit = initGitProject(env.dir);
    const mainWorkspace = await createWorkspace({
      mode: "worktree",
      db: env.db,
      projectRoot: env.dir,
      runId: RUN_ID,
      taskId: TASK_ID,
      taskKey: TASK_KEY,
      ref: mainBaseCommit,
      root: DEFAULT_WORKTREE_ROOT,
      branchPrefix: DEFAULT_BRANCH_PREFIX,
    });

    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    // No `review-spec` scenario is queued: `FakeAdapter`'s `scenarioFor`
    // throws synchronously inside `adapter.start`, before any process spawns.

    const reviewerWorkspace = createReviewerWorkspaceResolver({
      db: env.db,
      projectRoot: env.dir,
      root: DEFAULT_WORKTREE_ROOT,
      branchPrefix: DEFAULT_BRANCH_PREFIX,
      taskKey: TASK_KEY,
      reviewedRef: () => mainBaseCommit,
    });

    await assert.rejects(
      () => runDevelopmentStages(baseInput(env, adapter, { workspace: mainWorkspace, reviewerWorkspace })),
      /no scenario queued for stage review-spec/,
    );

    const row = env.db
      .prepare(
        `SELECT path, cleanup_state FROM worktrees WHERE run_id = ? AND task_id = ? AND branch LIKE ?`,
      )
      .get(RUN_ID, TASK_ID, `${DEFAULT_BRANCH_PREFIX}${TASK_KEY}-review-spec-r%`) as
      | { path: string; cleanup_state: string }
      | undefined;
    assert.ok(row, "the reviewer worktree row must exist even though dispatch threw");
    assert.equal(row!.cleanup_state, "cleaned");
    assert.deepEqual(reviewerWorktreePaths(env.dir), []);
  });
});

// ── schema validation rejects a critical/important finding lacking
// proof, and accepts one that carries it ─────────────────────────────────

test("partitionFindings rejects a critical/important finding lacking proof", () => {
  const noProofImportant = {
    id: "f-1",
    severity: "important",
    summary: "missing proof",
    path: "src/example.ts",
  };
  const partition = partitionFindings([noProofImportant]);
  assert.deepEqual(partition.blocking, []);
  assert.deepEqual(partition.minor, []);
  assert.equal(partition.rejected.length, 1);
  assert.equal(partition.rejected[0]!.raw, noProofImportant);
  assert.ok(
    partition.rejected[0]!.errors.some((e) => /proof/.test(e.message) || /proof/.test(e.path)),
    JSON.stringify(partition.rejected[0]!.errors),
  );
});

test("partitionFindings accepts a critical finding that carries proof", () => {
  const withProof = {
    id: "f-2",
    severity: "critical",
    summary: "has proof",
    path: "src/example.ts",
    proof: { path: "src/example.ts", line: 10, snippet: "const x = 1;" },
  };
  const partition = partitionFindings([withProof]);
  assert.equal(partition.rejected.length, 0);
  assert.equal(partition.blocking.length, 1);
  assert.equal((partition.blocking[0] as ReviewFinding).id, "f-2");
});

// ── fix-spec/fix-quality receive only accepted critical/important
// findings; a minor finding is never in a repair packet ─────────────────

test("a repair packet built from a mixed-severity round carries only the blocking findings", () => {
  const critical = {
    id: "f-critical",
    severity: "critical",
    summary: "critical issue",
    path: "src/a.ts",
    proof: { path: "src/a.ts", line: 1, snippet: "bug" },
  };
  const important = {
    id: "f-important",
    severity: "important",
    summary: "important issue",
    path: "src/b.ts",
    proof: { path: "src/b.ts", line: 2, snippet: "bug" },
  };
  const minor = {
    id: "f-minor",
    severity: "minor",
    summary: "minor issue",
    path: "src/c.ts",
  };

  const partition = partitionFindings([critical, important, minor]);
  assert.equal(partition.blocking.length, 2);
  assert.equal(partition.minor.length, 1);
  assert.equal(partition.rejected.length, 0);

  const packet = JSON.parse(buildRepairPacket(partition.blocking)) as { findings: ReviewFinding[] };
  const packetIds = packet.findings.map((f) => f.id).sort();
  assert.deepEqual(packetIds, ["f-critical", "f-important"]);
  assert.ok(!packet.findings.some((f) => f.id === "f-minor"));
});

test("fix-spec's own packet, built by a real 3-arg packet callback from review-spec's prior report, carries only the accepted blocking findings", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail", "fail", [
      {
        id: "f-critical",
        severity: "critical",
        summary: "critical issue",
        path: "src/a.ts",
        proof: { path: "src/a.ts", line: 1, snippet: "bug" },
      },
      {
        id: "f-important",
        severity: "important",
        summary: "important issue",
        path: "src/b.ts",
        proof: { path: "src/b.ts", line: 2, snippet: "bug" },
      },
      { id: "f-minor", severity: "minor", summary: "minor issue", path: "src/c.ts" },
    ]);
    queue("review-spec", "fail");
    queueImplementerScenario(env.streamsDir, "fix-spec", "completed", "completed");
    queue("fix-spec", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    let fixSpecPacket: string | null = null;
    const outcome = await runDevelopmentStages(
      baseInput(env, adapter, {
        packet: (stageId, _role, priorReport) => {
          if (stageId === "fix-spec" && priorReport) {
            const partition = partitionFindings(priorReport.findings as readonly unknown[] | undefined);
            fixSpecPacket = buildRepairPacket(partition.blocking);
            return fixSpecPacket;
          }
          return `packet ${stageId}`;
        },
      }),
    );

    assert.equal(outcome.outcome, "integrating");
    assert.ok(fixSpecPacket, "fix-spec must have received a packet built from review-spec's prior report");
    const packet = JSON.parse(fixSpecPacket as string) as { findings: ReviewFinding[] };
    const packetIds = packet.findings.map((f) => f.id).sort();
    assert.deepEqual(packetIds, ["f-critical", "f-important"]);
    assert.ok(!packet.findings.some((f) => f.id === "f-minor"));
  });
});

// ── the `blockingFindingRequiresProof` shape, proven directly on the
// driver: a proof-less important finding fails the whole report's schema
// validation, so the driver parks with schema-invalid rather than routing
// to fix-quality ─────────────────────────────────────────────────────────

test("a review-quality report carrying a proof-less important finding parks with schema-invalid, never reaching fix-quality", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "fail-no-proof", "fail-with-severity: important", [
      { id: "f-1", severity: "important", summary: "no proof", path: "src/example.ts" },
    ]);
    queue("review-quality", "fail-no-proof");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.equal(outcome.schemaInvalid?.stageId, "review-quality");
    assert.ok(!outcome.stages.some((s) => s.stageId === "fix-quality"));
  });
});
