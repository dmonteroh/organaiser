import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor } from "../src/adapters/adapter.ts";
import {
  DEVELOPMENT_CAPS,
  DEVELOPMENT_ENTRY_STAGE,
  DEVELOPMENT_STAGES,
  DEVELOPMENT_TERMINAL_OUTCOMES,
  runDevelopmentStages,
  type DevelopmentStageInput,
} from "../src/engine/workflow-stages.ts";
import type { WorkspaceHandle } from "../src/git/workspace.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

// A minimal reader for `development.v1.yaml` only, following the pattern and
// rationale at `board-predicates.test.ts`: `test/workflow-parity/static.test.mjs`
// carries a general restricted-YAML reader, but its parse functions are
// local to that script and are not exported for import. This reader
// extracts exactly what these tests need (entry stage, terminal outcomes,
// caps, and each stage's full declared shape) from the fixed two-space
// indentation the manifest is written in.
interface ParsedDevelopmentStage {
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

interface ParsedDevelopmentManifest {
  entryStage: string | null;
  terminalOutcomes: { success: string[]; attention: string[]; neutral: string[] };
  caps: Record<string, number>;
  stages: ParsedDevelopmentStage[];
}

function parseDevelopmentManifest(text: string): ParsedDevelopmentManifest {
  const result: ParsedDevelopmentManifest = {
    entryStage: null,
    terminalOutcomes: { success: [], attention: [], neutral: [] },
    caps: {},
    stages: [],
  };

  let topSection: "none" | "terminalOutcomes" | "caps" | "stages" = "none";
  let outcomesBucket: "success" | "attention" | "neutral" | null = null;
  let stage: ParsedDevelopmentStage | null = null;
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

const manifestPath = fileURLToPath(new URL("../../workflows/manifests/development.v1.yaml", import.meta.url));
const manifest = parseDevelopmentManifest(fs.readFileSync(manifestPath, "utf8"));

test("DEVELOPMENT_ENTRY_STAGE equals the manifest's entryStage", () => {
  assert.equal(manifest.entryStage, "implement");
  assert.equal(DEVELOPMENT_ENTRY_STAGE, manifest.entryStage);
});

test("DEVELOPMENT_CAPS equals the manifest's caps block, cap for cap, in both directions", () => {
  assert.deepEqual(DEVELOPMENT_CAPS, manifest.caps);
});

test("DEVELOPMENT_TERMINAL_OUTCOMES equals the manifest's spec.terminalOutcomes", () => {
  assert.deepEqual(
    {
      success: [...DEVELOPMENT_TERMINAL_OUTCOMES.success],
      attention: [...DEVELOPMENT_TERMINAL_OUTCOMES.attention],
      neutral: [...DEVELOPMENT_TERMINAL_OUTCOMES.neutral],
    },
    manifest.terminalOutcomes,
  );
});

test("DEVELOPMENT_STAGES mirrors the manifest's stages in order, stage for stage", () => {
  assert.deepEqual(
    DEVELOPMENT_STAGES.map((s) => s.id),
    manifest.stages.map((s) => s.id),
  );
});

test("DEVELOPMENT_STAGES mirrors kind, role, predicate, authority, and freshSession per stage", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of DEVELOPMENT_STAGES) {
    const parsed = byId.get(stage.id);
    assert.ok(parsed, `manifest has no stage ${stage.id}`);
    assert.equal(stage.kind, parsed!.kind, `${stage.id} kind`);
    assert.equal(stage.role, parsed!.role, `${stage.id} role`);
    assert.equal(stage.predicate, parsed!.predicate, `${stage.id} predicate`);
    assert.equal(stage.authority, parsed!.authority, `${stage.id} authority`);
    assert.equal(stage.freshSession, parsed!.freshSession, `${stage.id} freshSession`);
  }
});

test("DEVELOPMENT_STAGES mirrors transitions, transition for transition, in both directions", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of DEVELOPMENT_STAGES) {
    const parsed = byId.get(stage.id)!;
    assert.deepEqual(stage.transitions, parsed.transitions, `${stage.id} transitions`);
  }
});

test("DEVELOPMENT_STAGES mirrors each agent stage's declared verdicts list, verdict for verdict", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of DEVELOPMENT_STAGES) {
    if (stage.kind !== "agent") continue;
    const parsed = byId.get(stage.id)!;
    assert.deepEqual([...stage.verdicts], parsed.verdicts, `${stage.id} verdicts`);
  }
});

test("DEVELOPMENT_STAGES mirrors each agent stage's retry policy", () => {
  const byId = new Map(manifest.stages.map((s) => [s.id, s]));
  for (const stage of DEVELOPMENT_STAGES) {
    if (stage.kind !== "agent") continue;
    const parsed = byId.get(stage.id)!;
    assert.deepEqual(stage.retry, parsed.retry, `${stage.id} retry`);
  }
});

// ── Driver test fixtures ────────────────────────────────────────────────

const RUN_ID = "run-1";
const TASK_ID = "task-1";

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

function writeStreamFile(streamsDir: string, stageId: string, scenario: string, ops: readonly unknown[]): void {
  const filePath = path.join(streamsDir, `${stageId}--${scenario}.jsonl`);
  fs.writeFileSync(filePath, `${ops.map((op) => JSON.stringify(op)).join("\n")}\n`, "utf8");
}

function implementerReport(
  stageId: string,
  status: string,
  questions?: readonly unknown[],
): Record<string, unknown> {
  const report: Record<string, unknown> = {
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
  if (questions !== undefined) report.questions = questions;
  return report;
}

function reviewerReport(stageId: string, roleId: string, verdict: string): Record<string, unknown> {
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
  };
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

function queueReviewerScenario(streamsDir: string, stageId: string, roleId: string, scenario: string, verdict: string): void {
  writeStreamFile(streamsDir, stageId, scenario, [
    { op: "output", text: "reviewing" },
    { op: "report", report: reviewerReport(stageId, roleId, verdict) },
    { op: "exit", code: 0 },
  ]);
}

// Scenario resolution is queue-based rather than round-based: `AttemptDescriptor`
// (what `FakeAdapter`'s `scenarioFor` receives) carries no round number, so
// each test enqueues, per stage id, the exact ordered sequence of scenario
// names it expects the driver to dispatch.
function makeAdapter(streamsDir: string): { adapter: FakeAdapter; queue: (stageId: string, scenario: string) => void } {
  const queues = new Map<string, string[]>();
  const adapter = new FakeAdapter({
    terminate: noopTerminate,
    streamsDir,
    scenarioFor: (attempt: AttemptDescriptor) => {
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

// Mirrors `claims.test.ts:11-54`'s own git and `WorkspaceHandle` fixtures:
// a real repo, seeded with one commit, so `observedPaths` has a
// `baseCommit` to diff against.
function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function initGitWorkspace(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n", "utf8");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["-c", "user.name=Test User", "-c", "user.email=test@example.com", "commit", "-q", "-m", "seed"]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function handleFor(dir: string, baseCommit: string): WorkspaceHandle {
  return {
    mode: "worktree",
    root: ".orga/worktrees",
    path: dir,
    branch: "orga/task/task-1",
    baseCommit,
    recordedDirt: [],
  };
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

const ALL_GATES = ["specReviewGate", "qualityReviewGate", "questionsLoop", "artifactRepair", "taskChecksGate"] as const;

function assertOneHotGates(gateRounds: Readonly<Record<string, number>>, expectedGate: string): void {
  for (const gate of ALL_GATES) {
    assert.equal(gateRounds[gate], gate === expectedGate ? 1 : 0, `gate ${gate}`);
  }
}

// ── Verdicts outside the declared list park with `schema-invalid` ───────

test("an unlisted implement status parks with schema-invalid on implement", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "bogus-status", "bogus");
    queue("implement", "bogus-status");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.equal(outcome.schemaInvalid?.stageId, "implement");
    assert.equal(outcome.stages.at(-1)?.stageId, "implement");
    assert.equal(outcome.stages.at(-1)?.verdict, "schema-invalid");
  });
});

test("an unlisted review-spec verdict parks with schema-invalid on review-spec", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "unlisted", "maybe");
    queue("review-spec", "unlisted");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.equal(outcome.schemaInvalid?.stageId, "review-spec");
  });
});

test("an unlisted review-quality verdict parks with schema-invalid on review-quality", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "unlisted", "nope");
    queue("review-quality", "unlisted");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "parked");
    assert.equal(outcome.schemaInvalid?.stageId, "review-quality");
  });
});

// ── End-to-end driver behavior ────────────────────────────────────────────

test("the manifest's happy path reaches integrating through all nine stages in order", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "integrating");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      [
        "implement",
        "collect-implementation-artifacts",
        "verify-task",
        "review-spec",
        "review-quality",
        "record-minors",
        "ready-to-integrate",
      ],
    );
    for (const gate of ALL_GATES) assert.equal(outcome.gateRounds[gate], 0, `gate ${gate}`);
  });
});

test("a fail at review-spec reaches fix-spec and returns through collect-implementation-artifacts and verify-task, never straight to a review stage", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail", "fail");
    queue("review-spec", "fail");
    queueImplementerScenario(env.streamsDir, "fix-spec", "completed", "completed");
    queue("fix-spec", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

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
    assertOneHotGates(outcome.gateRounds, "specReviewGate");
  });
});

test("questions at an agent stage reaches waiting-operator", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "questions", "questions");
    queue("implement", "questions");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));

    assert.equal(outcome.outcome, "waiting-operator");
    assertOneHotGates(outcome.gateRounds, "questionsLoop");
  });
});

test("a status: questions report's questions[] is persisted to the questions table on the waiting-operator edge", async () => {
  await withEnv(async (env) => {
    withTransaction(env.db, () => {
      env.db
        .prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(TASK_ID, RUN_ID, TASK_ID, "Task 1", "brief.md", "task-board", null, "[]", 0, "implementing", null, 1000, 1000);
    });

    const openQuestion = {
      id: "oq-1",
      taskId: TASK_ID,
      owner: "operator",
      question: "which direction?",
      context: "some context",
      impact: "some impact",
      safeDefault: { summary: "go with A" },
      blocks: [],
    };

    const { adapter, queue } = makeAdapter(env.streamsDir);
    writeStreamFile(env.streamsDir, "implement", "with-question", [
      { op: "output", text: "working" },
      { op: "report", report: implementerReport("implement", "questions", [openQuestion]) },
      { op: "exit", code: 0 },
    ]);
    queue("implement", "with-question");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));
    assert.equal(outcome.outcome, "waiting-operator");

    const rows = env.db
      .prepare(`SELECT * FROM questions WHERE run_id = ?`)
      .all(RUN_ID) as Array<{ id: string; task_id: string | null; owner: string; prompt: string; status: string; payload: string | null }>;
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.id, `${RUN_ID}#oq-1#${TASK_ID}`);
    assert.equal(row.task_id, TASK_ID);
    assert.equal(row.owner, "operator");
    assert.equal(row.prompt, "which direction?");
    assert.equal(row.status, "open");
    assert.deepEqual(JSON.parse(row.payload as string), openQuestion);
  });
});

// ── Gate-to-edge mapping, one edge at a time ──────────────────────────────

test("review-spec fail -> fix-spec counts only specReviewGate", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail", "fail");
    queue("review-spec", "fail");
    queueImplementerScenario(env.streamsDir, "fix-spec", "completed", "completed");
    queue("fix-spec", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));
    assertOneHotGates(outcome.gateRounds, "specReviewGate");
  });
});

test("review-quality fail-with-severity: critical -> fix-quality counts only qualityReviewGate", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "critical", "fail-with-severity: critical");
    queue("review-quality", "critical");
    queueImplementerScenario(env.streamsDir, "fix-quality", "completed", "completed");
    queue("fix-quality", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass-2", "pass");
    queue("review-spec", "pass-2");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));
    assertOneHotGates(outcome.gateRounds, "qualityReviewGate");
  });
});

test("questions at implement -> waiting-operator counts only questionsLoop", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "questions", "questions");
    queue("implement", "questions");

    const outcome = await runDevelopmentStages(baseInput(env, adapter));
    assertOneHotGates(outcome.gateRounds, "questionsLoop");
  });
});

test("collect-implementation-artifacts false -> implement counts only artifactRepair", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "missing-artifact", "completed");
    queue("implement", "missing-artifact");
    queueImplementerScenario(env.streamsDir, "implement", "with-artifact", "completed", {
      path: "output.txt",
      text: "done\n",
    });
    queue("implement", "with-artifact");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    const outcome = await runDevelopmentStages(
      baseInput(env, adapter, { requiredArtifacts: ["output.txt"] }),
    );

    assertOneHotGates(outcome.gateRounds, "artifactRepair");
    assert.equal(outcome.outcome, "integrating");
  });
});

test("verify-task false -> implement counts only taskChecksGate", async () => {
  await withEnv(async (env) => {
    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "failing-checks", "completed");
    queue("implement", "failing-checks");
    queueImplementerScenario(env.streamsDir, "implement", "passing-checks", "completed");
    queue("implement", "passing-checks");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    // The first `implement` round's checks fail, the second's pass: the
    // declared check tests for a marker file that the second `implement`
    // round's dispatch (via the `packet` hook, called just before spawn)
    // creates but the first round's dispatch does not.
    const markerPath = path.join(env.dir, "checks-marker");
    const checks: Record<string, unknown> = {
      "marker-check": { id: "marker-check", shell: true, command: `test -f ${JSON.stringify(markerPath)}` },
    };

    let attempt = 0;
    const outcome = await runDevelopmentStages(
      baseInput(env, adapter, {
        checks,
        packet: (stageId) => {
          attempt += 1;
          if (stageId === "implement" && attempt === 2) {
            fs.writeFileSync(markerPath, "ready\n", "utf8");
          }
          return `packet ${stageId} ${attempt}`;
        },
      }),
    );

    assertOneHotGates(outcome.gateRounds, "taskChecksGate");
    assert.equal(outcome.outcome, "integrating");
  });
});

// ── The driver reads DEVELOPMENT_CAPS live, not a baked-in literal ───────

test("mutating DEVELOPMENT_CAPS.specReviewGate changes the round count the driver parks at", async () => {
  const mutableCaps = DEVELOPMENT_CAPS as Record<string, number>;
  const originalSpecReviewGate = mutableCaps.specReviewGate;
  assert.equal(originalSpecReviewGate, 3);

  mutableCaps.specReviewGate = 1;
  try {
    await withEnv(async (env) => {
      const { adapter, queue } = makeAdapter(env.streamsDir);
      queueImplementerScenario(env.streamsDir, "implement", "completed", "completed");
      queue("implement", "completed");
      queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "fail", "fail");
      queue("review-spec", "fail");

      const outcome = await runDevelopmentStages(baseInput(env, adapter));

      assert.equal(outcome.outcome, "parked");
      assert.deepEqual(
        outcome.stages.map((s) => s.stageId),
        ["implement", "collect-implementation-artifacts", "verify-task", "review-spec"],
      );
      assert.equal(outcome.gateRounds.specReviewGate, 1);
      assert.equal(outcome.schemaInvalid, undefined);
    });
  } finally {
    mutableCaps.specReviewGate = originalSpecReviewGate as number;
  }

  assert.equal(DEVELOPMENT_CAPS.specReviewGate, 3);
});

// ── Claim validation on `authority: workspace-write` stages ─────────────

test("an implement attempt whose write stays inside the recorded claim proceeds past implement normally", async () => {
  await withEnv(async (env) => {
    seedFilesClaim(env.db, RUN_ID, TASK_ID, ["output.txt"]);

    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed", {
      path: "output.txt",
      text: "done\n",
    });
    queue("implement", "completed");
    queueReviewerScenario(env.streamsDir, "review-spec", "spec-reviewer", "pass", "pass");
    queue("review-spec", "pass");
    queueReviewerScenario(env.streamsDir, "review-quality", "code-quality-reviewer", "pass", "pass");
    queue("review-quality", "pass");

    // A dedicated directory, separate from `env.taskDir` and
    // `env.streamsDir`, so the barrier's own ledger writes under `taskDir`
    // and the queued scenario files under `streamsDir` never land inside
    // the git repo `observedPaths` diffs.
    const workspaceDir = path.join(env.dir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const baseCommit = initGitWorkspace(workspaceDir);
    const workspace = handleFor(workspaceDir, baseCommit);

    const outcome = await runDevelopmentStages(baseInput(env, adapter, { workspace }));

    assert.equal(outcome.outcome, "integrating");
    assert.deepEqual(
      outcome.stages.map((s) => s.stageId),
      [
        "implement",
        "collect-implementation-artifacts",
        "verify-task",
        "review-spec",
        "review-quality",
        "record-minors",
        "ready-to-integrate",
      ],
    );

    const implementAttempt = env.db
      .prepare(`SELECT status FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'implement'`)
      .get(RUN_ID, TASK_ID) as { status: string };
    assert.equal(implementAttempt.status, "completed");

    const violationEvents = env.db
      .prepare(`SELECT id FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`)
      .all(RUN_ID);
    assert.equal(violationEvents.length, 0);
  });
});

test("an implement attempt that writes an out-of-claim file is failed and routed to parked regardless of its own verdict", async () => {
  await withEnv(async (env) => {
    seedFilesClaim(env.db, RUN_ID, TASK_ID, ["claimed.txt"]);

    const { adapter, queue } = makeAdapter(env.streamsDir);
    queueImplementerScenario(env.streamsDir, "implement", "completed", "completed", {
      path: "unclaimed.txt",
      text: "surprise\n",
    });
    queue("implement", "completed");

    // See the sibling test above: a dedicated workspace directory keeps
    // `taskDir`'s barrier ledger and `streamsDir`'s scenario files out of
    // what `observedPaths` diffs.
    const workspaceDir = path.join(env.dir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const baseCommit = initGitWorkspace(workspaceDir);
    const workspace = handleFor(workspaceDir, baseCommit);

    const outcome = await runDevelopmentStages(baseInput(env, adapter, { workspace }));

    assert.equal(outcome.outcome, "parked");
    assert.deepEqual(outcome.stages, [{ stageId: "implement", verdict: "failed" }]);
    assert.equal(outcome.schemaInvalid, undefined);

    const implementAttempt = env.db
      .prepare(`SELECT status FROM attempts WHERE run_id = ? AND task_id = ? AND stage_id = 'implement'`)
      .get(RUN_ID, TASK_ID) as { status: string };
    assert.equal(
      implementAttempt.status,
      "failed",
      "the claim violation overrides the adapter's own completed verdict",
    );

    const normalizedEvents = env.db
      .prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.normalized'`)
      .all(RUN_ID) as Array<{ payload: string }>;
    assert.equal(normalizedEvents.length, 1);
    assert.equal(
      (JSON.parse(normalizedEvents[0]!.payload) as { ok: boolean }).ok,
      true,
      "the adapter's own classification is unaffected; only the recorded attempt status is overridden",
    );

    const violationEvents = env.db
      .prepare(`SELECT payload FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`)
      .all(RUN_ID) as Array<{ payload: string }>;
    assert.equal(violationEvents.length, 1);
    const payload = JSON.parse(violationEvents[0]!.payload) as { outOfClaim: string[] };
    assert.deepEqual(payload.outOfClaim, ["unclaimed.txt"]);
  });
});
