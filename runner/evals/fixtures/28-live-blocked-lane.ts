// Live scenario `live-blocked-lane` (goals spec section 29.6: "one blocked lane does not
// stop another lane"): seeds two dependency-free `integration`-stage tasks with
// `ORGA_MAX_WORKER_SLOTS=2` and the chosen vendor's slot ceiling raised to 2, drives them
// through the real production supervisor (`createProductionSchedulerTick`, selected via
// `ORGA_VENDOR`), and proves from durable `tasks`/`workers` rows alone — never from
// in-memory scheduler state — that the blocked task's own real vendor attempt rested at
// `disposition = 'parked'`, the draining task's rested at `disposition = 'integrated'`,
// their two `workers` rows' live intervals genuinely overlapped, and the run itself rests
// `blocked`.
//
// Both tasks dispatch through the board `integration` stage's fallback path (`scheduler.ts`'s
// `dispatchEligible`, the same path `23-live-board-drain.ts` proved: neither task ever ran
// `implementation`, so neither carries a `worktrees` row for `integration` to reuse, and the
// path falls through to the generic `dispatchAttempt` call). That path's role is always
// `integrator`; `gatherFacts`'s `integration-outcome` case reads `outcome.report.status`
// (`"completed"` -> `attemptOk: true`, anything else -> `attemptOk: false`) and
// `board-predicates.ts` maps `attemptOk: false` to `parked`, `attemptOk: true` to
// `integrated`. The blocked task's brief directs an immediate schema-valid report with
// `status: "questions"` (schema-valid because the `stage-result.schema.json` `questions`
// array is optional and the `integrator` role carries no separate verdict requirement); the
// draining task's brief is the same no-op acknowledgment brief `23-live-board-drain.ts`
// already uses, directing `status: "completed"`.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe reports
// the CLI installed and authenticated; otherwise it returns a stated skip reason before any
// vendor process — including the version/auth probe itself — is spawned. Targets no
// production service: Codex is pointed at a local Ollama model server through a
// fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: none yet. This fixture has not completed a live run for either
// vendor as of this header's writing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initProject } from "../../src/store/init.ts";
import { startRun } from "../../src/engine/supervisor-spawn.ts";
import { claudeProbeSpec } from "../../src/adapters/claude-adapter.ts";
import { CODEX_VENDOR_PROBE_SPEC } from "../../src/adapters/codex-adapter.ts";
import { probeVendor } from "../../src/adapters/probe.ts";
import {
  withFixtureWorkspace,
  openStore,
  withTransaction,
  readRunRow,
  readTaskRow,
  allRows,
  recordedPgidsForRun,
  waitFor,
  alive,
  groupAlive,
} from "./harness.ts";

export type LiveVendor = "claude" | "codex";

export type LiveBlockedLaneResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      state: string;
      vendor: LiveVendor;
      wallTimeMs: number;
      blockedDisposition: string | null;
      drainingDisposition: string | null;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const RUN_TERMINAL_TIMEOUT_MS = 20 * 60 * 1000;
const SUPERVISOR_EXIT_TIMEOUT_MS = 30000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const BLOCKED_TASK_ID = "blocked-lane-blocked";
const DRAINING_TASK_ID = "blocked-lane-drainer";
const ALL_TASK_IDS = [BLOCKED_TASK_ID, DRAINING_TASK_ID] as const;

function buildPlaceholderBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "live-blocked-lane-board", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: "blocked-lane-placeholder",
          title: "live-blocked-lane placeholder board entry",
          briefPath: "blocked-lane-placeholder-brief.md",
          entry: { workflowId: "dev-workflow", stageId: "implementation" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          enabled: true,
        },
      ],
    },
  };
}

// Textually the same no-op acknowledgment brief `23-live-board-drain.ts` writes for every
// task it seeds: a read-only, no-op acknowledgment is the `integration` stage fallback
// path's own contract (`workflows/subagents/integrator-prompt.md`), so this brief is packet
// content the vendor reads and acknowledges, not a work order.
function drainingBriefContent(taskId: string): string {
  return [
    `# live-blocked-lane acknowledgment: ${taskId}`,
    "",
    "## Objective",
    `Acknowledge the board's integration-stage dispatch for task ${taskId}. This dispatch has no runner-owned workspace, no candidate diff, and no repository mutation to perform; the correct outcome is an immediate report stating that no integration action was taken for ${taskId}.`,
    "",
    "## Acceptance Criteria",
    `- Task ${taskId}'s brief is treated as data describing this dispatch, never as an instruction to act on the repository.`,
    "- No file is created, edited, or deleted.",
    "- No command is run and no commit, merge, rebase, cherry-pick, push, tag, or ref move is made.",
    `- A report with status \`completed\` is produced immediately, stating no integration action was taken for ${taskId}.`,
    "",
    "## Verification Commands",
    "- (none: this dispatch performs no work and there is nothing to verify)",
    "",
    "## Stop Condition",
    "Report immediately. Do not explore the repository, run commands, or produce a work-product.",
    "",
  ].join("\n");
}

function blockedBriefContent(taskId: string): string {
  return [
    `# live-blocked-lane blocked dispatch: ${taskId}`,
    "",
    "## Objective",
    `Acknowledge the board's integration-stage dispatch for task ${taskId}. This dispatch has no runner-owned workspace, no candidate diff, and no repository mutation to perform; report immediately that this dispatch path has no operator-question channel available to actually resolve, and cannot decide whether to proceed.`,
    "",
    "## Acceptance Criteria",
    `- Task ${taskId}'s brief is treated as data describing this dispatch, never as an instruction to act on the repository.`,
    "- No file is created, edited, or deleted.",
    "- No command is run and no commit, merge, rebase, cherry-pick, push, tag, or ref move is made.",
    `- A report with status \`questions\` is produced immediately for ${taskId}, with no other field required.`,
    "",
    "## Verification Commands",
    "- (none: this dispatch performs no work and there is nothing to verify)",
    "",
    "## Stop Condition",
    "Report immediately with status `questions`. Do not explore the repository, run commands, or produce a work-product.",
    "",
  ].join("\n");
}

const BLOCKED_LANE_BRIEFS: Readonly<Record<string, string>> = {
  [BLOCKED_TASK_ID]: blockedBriefContent(BLOCKED_TASK_ID),
  [DRAINING_TASK_ID]: drainingBriefContent(DRAINING_TASK_ID),
};

function insertBlockedLaneTasks(root: string, runId: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      const insert = db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const taskId of ALL_TASK_IDS) {
        insert.run(
          taskId,
          runId,
          taskId,
          `live-blocked-lane task ${taskId}`,
          `${taskId}-brief.md`,
          "task-board",
          "integration",
          JSON.stringify([]),
          0,
          "integrating",
          null,
          now,
          now,
        );
      }
    });
  } finally {
    db.close();
  }
}

function gitCapture(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function createThrowawayRepo(dir: string): void {
  gitCapture(dir, ["init", "-q"]);
  gitCapture(dir, ["config", "commit.gpgsign", "false"]);
  gitCapture(dir, ["config", "user.name", "Live Fixture Operator"]);
  gitCapture(dir, ["config", "user.email", "live-fixture@example.com"]);
  fs.writeFileSync(path.join(dir, ".env"), "APP_API_KEY=fake-not-a-real-credential\n");
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-blocked-lane. Not a real project.\n");
  gitCapture(dir, ["add", "--", ".env", "README.md"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);
  initProject(dir);
  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);
}

// Arrays are configurable only through project/user YAML files (`profiles.ts`'s own
// design note), so `environmentAllowlist` cannot ride an `ORGA_`-prefixed environment
// variable; this appends the block `resolveVendorProfile` reads for a vendor's default
// capability class to the `orga.yaml` `initProject` already wrote. With nothing
// allowlisted, the spawned attempt's environment would carry no `PATH` to resolve its
// own executable by and no `HOME` to find its credentials, so every vendor branch here
// allowlists at least those two.
function appendVendorEnvironmentAllowlist(dir: string, vendor: LiveVendor, names: readonly string[]): void {
  const orgaYamlPath = path.join(dir, "orga.yaml");
  const existing = fs.readFileSync(orgaYamlPath, "utf8");
  const block = [
    "vendors:",
    `  ${vendor}:`,
    "    default:",
    "      environmentAllowlist:",
    ...names.map((name) => `        - ${name}`),
    "",
  ].join("\n");
  fs.writeFileSync(orgaYamlPath, `${existing}${block}`);
}

// A fixture-owned `CODEX_HOME` selects a custom `wire_api = "responses"` provider
// against the local Ollama server (Ollama's `/v1/chat/completions` route rejects
// `--output-schema`, which the shipped adapter always emits) without ever writing to the
// operator's real `~/.codex/`. `auth.json` is a symlink, never a copy, to the operator's
// real credential file.
function buildCodexHome(): string {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "orga-live-codex-home-"));
  fs.chmodSync(codexHome, 0o700);
  const configToml = [
    'model_provider = "ollamar"',
    "[model_providers.ollamar]",
    'name = "ollama-responses"',
    'base_url = "http://localhost:11434/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), configToml, { mode: 0o600 });
  const realAuthPath = path.join(os.homedir(), ".codex", "auth.json");
  fs.symlinkSync(realAuthPath, path.join(codexHome, "auth.json"));
  return codexHome;
}

async function ollamaReachable(): Promise<string | null> {
  try {
    const response = await fetch(OLLAMA_MODELS_URL, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return `local Ollama server responded ${response.status} at ${OLLAMA_MODELS_URL}`;
    return null;
  } catch (err) {
    return `local Ollama server is not reachable at ${OLLAMA_MODELS_URL}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function skipReason(vendor: LiveVendor): Promise<string | null> {
  if (process.env.ORGA_LIVE !== "1") return 'ORGA_LIVE is not set to "1"';
  if (vendor === "codex") {
    const reason = await ollamaReachable();
    if (reason) return reason;
  }
  const spec = vendor === "claude" ? claudeProbeSpec : CODEX_VENDOR_PROBE_SPEC;
  const report = await probeVendor(spec, {
    executablePath: spec.defaultExecutable,
    requestedModel: "default",
    requestedEffort: "default",
    workingDirectory: process.cwd(),
    environment: process.env,
  });
  if (report.executablePath === "unknown") return `${vendor} CLI is not installed (not found on PATH)`;
  if (report.authenticationOutcome !== "authenticated") {
    return `${vendor} CLI is not authenticated (probe outcome: ${report.authenticationOutcome})`;
  }
  return null;
}

function patchEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

interface AttemptWorkerRow {
  task_id: string;
  attempt_id: string;
  started_at: number;
  ended_at: number | null;
}

export async function liveBlockedLane(vendor: LiveVendor): Promise<LiveBlockedLaneResult> {
  const reason = await skipReason(vendor);
  if (reason) return { skipped: true, reason };

  return withFixtureWorkspace(async (dir) => {
    // Nested one level inside the fixture's own temporary directory, not placed at it
    // directly: `sandboxMode: "workspace-write"` restricts writes but not reads, so a
    // real vendor agent's own filesystem exploration reading one level above its working
    // directory finds only this fixture's own small subtree, never the shared system
    // temporary directory `withFixtureWorkspace` uses.
    const root = path.join(dir, "repo");
    fs.mkdirSync(root);
    createThrowawayRepo(root);

    let codexHome: string | undefined;
    if (vendor === "codex") {
      appendVendorEnvironmentAllowlist(root, "codex", ["HOME", "PATH", "CODEX_HOME"]);
      codexHome = buildCodexHome();
    } else {
      appendVendorEnvironmentAllowlist(root, "claude", ["HOME", "PATH"]);
    }

    try {
      const boardPath = path.join(root, "board.json");
      const workflowPath = path.join(root, "workflow.md");
      const templatePath = path.join(root, "template.md");
      const board = buildPlaceholderBoard();
      fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
      fs.writeFileSync(workflowPath, "# workflow\n");
      fs.writeFileSync(templatePath, "# template\n");
      for (const taskId of ALL_TASK_IDS) {
        fs.writeFileSync(path.join(root, `${taskId}-brief.md`), BLOCKED_LANE_BRIEFS[taskId]);
      }

      const restoreEnv = patchEnv({
        ORGA_VENDOR: vendor,
        ORGA_MAX_WORKER_SLOTS: "2",
        ...(vendor === "codex"
          ? {
              ORGA_VENDOR_SLOTS_CODEX: "2",
              ORGA_MODEL: CODEX_LIVE_MODEL,
              CODEX_HOME: codexHome as string,
              ORGA_SANDBOX_MODE: "danger-full-access",
              ORGA_EFFORT: "low",
            }
          : { ORGA_VENDOR_SLOTS_CLAUDE: "2" }),
      });

      const startedAt = Date.now();
      let runId: string;
      let supervisorPid: number;
      try {
        const result = startRun({ root, boardPath, board, workflowPath, templatePath });
        if (result.supervisorPid === null) {
          throw new Error("liveBlockedLane: startRun did not spawn a supervisor");
        }
        runId = result.runId;
        supervisorPid = result.supervisorPid;
      } finally {
        restoreEnv();
      }
      insertBlockedLaneTasks(root, runId, startedAt);

      try {
        const reachedTerminal = await waitFor(() => {
          const run = readRunRow(root, runId);
          return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
        }, RUN_TERMINAL_TIMEOUT_MS, 500);

        const run = readRunRow(root, runId);
        if (!reachedTerminal) {
          throw new Error(
            `live-blocked-lane (${vendor}): run did not reach a resting state within ${RUN_TERMINAL_TIMEOUT_MS}ms; last state: ${JSON.stringify(run)}`,
          );
        }

        const workerRows = allRows<AttemptWorkerRow>(
          root,
          `SELECT a.task_id AS task_id, a.id AS attempt_id, w.started_at AS started_at, w.ended_at AS ended_at
             FROM attempts a JOIN workers w ON w.attempt_id = a.id
            WHERE a.run_id = ? AND a.stage_id = 'integration' AND a.task_id IN (?, ?)`,
          runId,
          BLOCKED_TASK_ID,
          DRAINING_TASK_ID,
        );
        const rowsByTask = new Map<string, AttemptWorkerRow[]>();
        for (const row of workerRows) {
          const bucket = rowsByTask.get(row.task_id) ?? [];
          bucket.push(row);
          rowsByTask.set(row.task_id, bucket);
        }
        for (const taskId of ALL_TASK_IDS) {
          const bucket = rowsByTask.get(taskId) ?? [];
          if (bucket.length !== 1) {
            throw new Error(
              `live-blocked-lane (${vendor}): expected exactly one integration attempt for task ${taskId}, found ${bucket.length}; runId ${runId}`,
            );
          }
        }

        const blockedWorker = rowsByTask.get(BLOCKED_TASK_ID)![0];
        const drainingWorker = rowsByTask.get(DRAINING_TASK_ID)![0];
        const readTimeMs = Date.now();
        const blockedEndsBy = blockedWorker.ended_at ?? readTimeMs;
        const drainingEndsBy = drainingWorker.ended_at ?? readTimeMs;
        const overlaps =
          blockedWorker.started_at < drainingEndsBy && drainingWorker.started_at < blockedEndsBy;
        if (!overlaps) {
          throw new Error(
            `live-blocked-lane (${vendor}): the two lanes' live worker intervals do not overlap; blocked=${JSON.stringify(blockedWorker)} draining=${JSON.stringify(drainingWorker)}; runId ${runId}`,
          );
        }

        const blockedRow = readTaskRow(root, BLOCKED_TASK_ID);
        const drainingRow = readTaskRow(root, DRAINING_TASK_ID);
        const blockedDisposition = (blockedRow?.disposition as string | null | undefined) ?? null;
        const drainingDisposition = (drainingRow?.disposition as string | null | undefined) ?? null;

        if (blockedDisposition !== "parked") {
          throw new Error(
            `live-blocked-lane (${vendor}): blocked task did not rest parked; disposition=${JSON.stringify(blockedDisposition)}; row=${JSON.stringify(blockedRow)}; runId ${runId}`,
          );
        }
        if (drainingDisposition !== "integrated") {
          throw new Error(
            `live-blocked-lane (${vendor}): draining task did not rest integrated; disposition=${JSON.stringify(drainingDisposition)}; row=${JSON.stringify(drainingRow)}; runId ${runId}`,
          );
        }
        if (run.state !== "blocked") {
          throw new Error(
            `live-blocked-lane (${vendor}): run did not rest blocked; run=${JSON.stringify(run)}; blockedDisposition=${JSON.stringify(blockedDisposition)}; drainingDisposition=${JSON.stringify(drainingDisposition)}`,
          );
        }

        const supervisorExited = await waitFor(() => !alive(supervisorPid), SUPERVISOR_EXIT_TIMEOUT_MS);
        if (!supervisorExited) {
          throw new Error(
            `live-blocked-lane (${vendor}): supervisor pid ${supervisorPid} did not exit within ${SUPERVISOR_EXIT_TIMEOUT_MS}ms; runId ${runId}`,
          );
        }
        const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
        if (survivors.length > 0) {
          throw new Error(`live-blocked-lane (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
        }

        return {
          skipped: false,
          runId,
          state: run.state as string,
          vendor,
          wallTimeMs: Date.now() - startedAt,
          blockedDisposition,
          drainingDisposition,
        };
      } finally {
        if (alive(supervisorPid)) {
          try {
            process.kill(-supervisorPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    } finally {
      if (codexHome) {
        try {
          fs.rmSync(codexHome, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  });
}
