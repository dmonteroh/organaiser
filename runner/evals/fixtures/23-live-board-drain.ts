// Live scenario `live-board-drain` (goals spec section 29.6; the full Stage D drain
// proof): seeds six `integration`-stage tasks — two dependency-free, four depending on
// both of those two — drives them through the real production supervisor
// (`createProductionSchedulerTick`, selected via `ORGA_VENDOR`) with
// `ORGA_MAX_WORKER_SLOTS=2` and the chosen vendor's slot ceiling raised to 2, and proves
// from durable `tasks`/`attempts`/`workers` rows alone — never from in-memory scheduler
// state — that both dependency-free tasks held a real vendor attempt simultaneously in
// one tick, that the run itself rests `succeeded`, that all six tasks reach an
// acceptable terminal disposition, and that each of the four dependents' earliest
// attempt was genuinely released by its dependencies' completion rather than dispatched
// regardless of them.
//
// Every task this fixture seeds dispatches through the board `integration` stage's
// fallback path, whose role is always `integrator` (`scheduler.ts`'s
// `dispatchEligible`). That role's own contract (`workflows/subagents/integrator-prompt.md`)
// is a read-only, no-op acknowledgment: it forbids file creation, edits, commits, and
// command execution, and declares `status: "completed"` its expected outcome. The six
// brief files this scenario writes are therefore packet content the vendor reads and
// acknowledges, not a work order — each describes the acknowledgment the dispatch
// path actually performs. `status: "completed"` against that packet is what
// `gatherFacts`'s `integration-outcome` case now reads to route a task to `integrated`,
// which is what makes a genuine six-task drain observable on this path.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe
// reports the CLI installed and authenticated; otherwise it returns a stated skip reason
// before any vendor process — including the version/auth probe itself — is spawned.
// Targets no production service: Codex is pointed at a local Ollama model server through
// a fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: three `codex` runs on 2026-09-07 (`codex-cli 0.46.0` against a
// local `gpt-oss:20b` Ollama model) each rested `blocked`, both first-wave `integrator`
// attempts classified `failureClass: "worker-crash"`, `reason: "no-candidate-report"`
// before ever reaching a candidate report to validate. No run has yet reached `succeeded`.

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

export type LiveBoardDrainResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      state: string;
      vendor: LiveVendor;
      wallTimeMs: number;
      taskDispositions: Record<string, string | null>;
      attempts: Array<{ taskId: string; stageId: string; status: string }>;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const RUN_TERMINAL_TIMEOUT_MS = 20 * 60 * 1000;
const SUPERVISOR_EXIT_TIMEOUT_MS = 30000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const FIRST_WAVE_TASK_IDS = ["board-drain-t1", "board-drain-t2"] as const;
const DEPENDENT_TASK_IDS = ["board-drain-t3", "board-drain-t4", "board-drain-t5", "board-drain-t6"] as const;
const ALL_TASK_IDS = [...FIRST_WAVE_TASK_IDS, ...DEPENDENT_TASK_IDS] as const;

const ACCEPTABLE_TERMINAL_DISPOSITIONS = new Set(["integrated", "superseded", "shelved", "cancelled"]);

function buildPlaceholderBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "live-board-drain-board", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: "board-drain-placeholder",
          title: "live-board-drain placeholder board entry",
          briefPath: "board-drain-placeholder-brief.md",
          entry: { workflowId: "dev-workflow", stageId: "implementation" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          // Disabled deliberately: this fixture seeds its own tasks rows via `insertBoardDrainTasks`, so the board must not materialize them a second time.
          enabled: false,
        },
      ],
    },
  };
}

function boardDrainBriefContent(taskId: string): string {
  return [
    `# live-board-drain acknowledgment: ${taskId}`,
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

const BOARD_DRAIN_BRIEFS: Readonly<Record<string, string>> = Object.fromEntries(
  ALL_TASK_IDS.map((taskId) => [taskId, boardDrainBriefContent(taskId)]),
);

function insertBoardDrainTasks(root: string, runId: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      const insert = db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const taskId of ALL_TASK_IDS) {
        const dependsOn = FIRST_WAVE_TASK_IDS.includes(taskId as (typeof FIRST_WAVE_TASK_IDS)[number])
          ? []
          : [...FIRST_WAVE_TASK_IDS];
        insert.run(
          taskId,
          runId,
          taskId,
          `live-board-drain task ${taskId}`,
          `${taskId}-brief.md`,
          "task-board",
          "integration",
          JSON.stringify(dependsOn),
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
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-board-drain. Not a real project.\n");
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

interface AttemptRowShape {
  task_id: string;
  stage_id: string;
  status: string;
}

interface AttemptWorkerRow {
  task_id: string;
  attempt_id: string;
  started_at: number;
  ended_at: number | null;
}

export async function liveBoardDrain(vendor: LiveVendor): Promise<LiveBoardDrainResult> {
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
        fs.writeFileSync(path.join(root, `${taskId}-brief.md`), BOARD_DRAIN_BRIEFS[taskId]);
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
          throw new Error("liveBoardDrain: startRun did not spawn a supervisor");
        }
        runId = result.runId;
        supervisorPid = result.supervisorPid;
      } finally {
        restoreEnv();
      }
      insertBoardDrainTasks(root, runId, startedAt);

      try {
        const reachedTerminal = await waitFor(() => {
          const run = readRunRow(root, runId);
          return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
        }, RUN_TERMINAL_TIMEOUT_MS, 500);

        const run = readRunRow(root, runId);
        if (!reachedTerminal) {
          throw new Error(
            `live-board-drain (${vendor}): run did not reach a resting state within ${RUN_TERMINAL_TIMEOUT_MS}ms; last state: ${JSON.stringify(run)}`,
          );
        }

        const firstWaveRows = allRows<AttemptWorkerRow>(
          root,
          `SELECT a.task_id AS task_id, a.id AS attempt_id, w.started_at AS started_at, w.ended_at AS ended_at
             FROM attempts a JOIN workers w ON w.attempt_id = a.id
            WHERE a.run_id = ? AND a.stage_id = 'integration' AND a.task_id IN (?, ?)`,
          runId,
          FIRST_WAVE_TASK_IDS[0],
          FIRST_WAVE_TASK_IDS[1],
        );

        const rowsByTask = new Map<string, AttemptWorkerRow[]>();
        for (const row of firstWaveRows) {
          const bucket = rowsByTask.get(row.task_id) ?? [];
          bucket.push(row);
          rowsByTask.set(row.task_id, bucket);
        }
        for (const taskId of FIRST_WAVE_TASK_IDS) {
          const bucket = rowsByTask.get(taskId) ?? [];
          if (bucket.length !== 1) {
            throw new Error(
              `live-board-drain (${vendor}): expected exactly one integration attempt for task ${taskId}, found ${bucket.length}; runId ${runId}`,
            );
          }
        }

        const w1 = rowsByTask.get(FIRST_WAVE_TASK_IDS[0])![0];
        const w2 = rowsByTask.get(FIRST_WAVE_TASK_IDS[1])![0];
        if (w1.attempt_id === w2.attempt_id) {
          throw new Error(
            `live-board-drain (${vendor}): the two first-wave tasks share one attempt id ${w1.attempt_id}; runId ${runId}`,
          );
        }
        const readTimeMs = Date.now();
        const w1EndsBy = w1.ended_at ?? readTimeMs;
        const w2EndsBy = w2.ended_at ?? readTimeMs;
        const overlaps = w1.started_at < w2EndsBy && w2.started_at < w1EndsBy;
        if (!overlaps) {
          throw new Error(
            `live-board-drain (${vendor}): the two first-wave workers' live intervals do not overlap; w1=${JSON.stringify(w1)} w2=${JSON.stringify(w2)}; runId ${runId}`,
          );
        }

        const restingTaskRows: Record<string, Record<string, unknown> | undefined> = {};
        for (const taskId of ALL_TASK_IDS) {
          restingTaskRows[taskId] = readTaskRow(root, taskId);
        }

        const allAttempts = allRows<AttemptRowShape>(
          root,
          `SELECT task_id, stage_id, status FROM attempts WHERE run_id = ? ORDER BY created_at ASC`,
          runId,
        );

        const unacceptable = ALL_TASK_IDS.filter((taskId) => {
          const disposition = restingTaskRows[taskId]?.disposition as string | null | undefined;
          return typeof disposition !== "string" || !ACCEPTABLE_TERMINAL_DISPOSITIONS.has(disposition);
        });
        if (unacceptable.length > 0) {
          throw new Error(
            `live-board-drain (${vendor}): task(s) not at an acceptable terminal disposition: ${unacceptable
              .map((taskId) => `${taskId}=${JSON.stringify(restingTaskRows[taskId]?.disposition ?? null)}`)
              .join(", ")}; attempts=${JSON.stringify(allAttempts)}; runId ${runId}`,
          );
        }

        if (run.state !== "succeeded") {
          throw new Error(
            `live-board-drain (${vendor}): run did not rest succeeded; run=${JSON.stringify(run)}; dispositions=${JSON.stringify(
              Object.fromEntries(ALL_TASK_IDS.map((taskId) => [taskId, restingTaskRows[taskId]?.disposition ?? null])),
            )}`,
          );
        }

        for (const taskId of DEPENDENT_TASK_IDS) {
          const firstAttemptRows = allRows<{ first_attempt: number | null }>(
            root,
            `SELECT MIN(created_at) AS first_attempt FROM attempts WHERE run_id = ? AND task_id = ?`,
            runId,
            taskId,
          );
          const firstAttempt = firstAttemptRows[0]?.first_attempt ?? null;
          if (firstAttempt === null) {
            throw new Error(
              `live-board-drain (${vendor}): dependent task ${taskId} has zero attempts; runId ${runId}`,
            );
          }
          for (const dependencyId of FIRST_WAVE_TASK_IDS) {
            const dependencyUpdatedAt = restingTaskRows[dependencyId]?.updated_at as number | undefined;
            if (dependencyUpdatedAt === undefined) {
              throw new Error(
                `live-board-drain (${vendor}): dependency ${dependencyId} row missing updated_at; runId ${runId}`,
              );
            }
            if (firstAttempt < dependencyUpdatedAt) {
              throw new Error(
                `live-board-drain (${vendor}): dependent ${taskId}'s earliest attempt (${firstAttempt}) precedes dependency ${dependencyId}'s updated_at (${dependencyUpdatedAt}); runId ${runId}`,
              );
            }
          }
        }

        const supervisorExited = await waitFor(() => !alive(supervisorPid), SUPERVISOR_EXIT_TIMEOUT_MS);
        if (!supervisorExited) {
          throw new Error(
            `live-board-drain (${vendor}): supervisor pid ${supervisorPid} did not exit within ${SUPERVISOR_EXIT_TIMEOUT_MS}ms; runId ${runId}`,
          );
        }
        const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
        if (survivors.length > 0) {
          throw new Error(`live-board-drain (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
        }

        const taskDispositions: Record<string, string | null> = {};
        for (const taskId of ALL_TASK_IDS) {
          taskDispositions[taskId] = (restingTaskRows[taskId]?.disposition as string | null | undefined) ?? null;
        }

        return {
          skipped: false,
          runId,
          state: run.state as string,
          vendor,
          wallTimeMs: Date.now() - startedAt,
          taskDispositions,
          attempts: allAttempts.map((a) => ({ taskId: a.task_id, stageId: a.stage_id, status: a.status })),
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
