// Live scenario `live-board-drain` (goals spec section 29.6; the provable half of the
// two-lane/detachment claim): seeds six `integration`-stage tasks — two dependency-free,
// four depending on both of those two — drives them through the real production
// supervisor (`createProductionSchedulerTick`, selected via `ORGA_VENDOR`) with
// `ORGA_MAX_WORKER_SLOTS=2` and the chosen vendor's slot ceiling raised to 2, and proves
// from durable `attempts`/`workers` rows alone — never from in-memory scheduler state —
// that both dependency-free tasks held a real vendor attempt simultaneously in one tick
// and that none of the four dependents ever dispatched while their dependencies were
// unresolved.
//
// This scenario asserts nothing about attempt status, task disposition, or whether the
// run ever drains to success. The fallback dispatch path every `integration`-stage task
// takes in production sends a fixed placeholder packet, not a real brief, so a real
// vendor's attempt here has no instructions to converge against; and outcome
// classification for that path is derived purely from schema validity, not from a
// report's own declared status, so a schema-valid failure report would be recorded as
// `integrated` without this scenario ever having proved real task completion. Asserting
// dispositions would either encode a fragile expectation, or launder a schema-validity
// pass as a task-completion proof. The run's terminal state and every task's disposition
// are recorded on the returned result for the operator to read, not asserted here.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe
// reports the CLI installed and authenticated; otherwise it returns a stated skip reason
// before any vendor process — including the version/auth probe itself — is spawned.
// Targets no production service: Codex is pointed at a local Ollama model server through
// a fixture-owned `CODEX_HOME`, never the operator's real one.

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
const RUN_TERMINAL_TIMEOUT_MS = 15 * 60 * 1000;
const SUPERVISOR_EXIT_TIMEOUT_MS = 30000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const FIRST_WAVE_TASK_IDS = ["board-drain-t1", "board-drain-t2"] as const;
const DEPENDENT_TASK_IDS = ["board-drain-t3", "board-drain-t4", "board-drain-t5", "board-drain-t6"] as const;
const ALL_TASK_IDS = [...FIRST_WAVE_TASK_IDS, ...DEPENDENT_TASK_IDS] as const;

// The one disposition set that would silently invalidate this scenario's dependency-gate
// proof: `dispatchDependenciesSatisfied` releases a dependent only once every dependency
// carries one of these three, so if either first-wave task reached one, the four
// dependents becoming eligible to dispatch is the board scheduler working correctly, not
// a gating failure. The guard below fails loudly with that diagnosis — naming which
// first-wave task reached which unexpected disposition — so this scenario can neither
// pass on a silent coincidence nor fail as a confusing bare gate violation.
const DEPENDENCY_RELEASING_DISPOSITIONS = new Set(["integrated", "superseded", "shelved"]);

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
          enabled: true,
        },
      ],
    },
  };
}

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

        for (const taskId of FIRST_WAVE_TASK_IDS) {
          const task = readTaskRow(root, taskId);
          const disposition = task?.disposition as string | null | undefined;
          if (typeof disposition === "string" && DEPENDENCY_RELEASING_DISPOSITIONS.has(disposition)) {
            throw new Error(
              `live-board-drain (${vendor}): invalid scenario instance — first-wave task ${taskId} reached disposition "${disposition}", which releases its dependents and makes the dependency-gate proof below meaningless; runId ${runId}`,
            );
          }
        }

        const dependentAttemptCounts = allRows<{ n: number }>(
          root,
          `SELECT COUNT(*) AS n FROM attempts WHERE run_id = ? AND task_id IN (?, ?, ?, ?)`,
          runId,
          DEPENDENT_TASK_IDS[0],
          DEPENDENT_TASK_IDS[1],
          DEPENDENT_TASK_IDS[2],
          DEPENDENT_TASK_IDS[3],
        );
        const dependentAttemptCount = dependentAttemptCounts[0]?.n ?? 0;
        if (dependentAttemptCount !== 0) {
          throw new Error(
            `live-board-drain (${vendor}): expected zero attempts for the four dependent tasks, found ${dependentAttemptCount}; runId ${runId}`,
          );
        }

        await waitFor(() => !alive(supervisorPid), SUPERVISOR_EXIT_TIMEOUT_MS);
        const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
        if (survivors.length > 0) {
          throw new Error(`live-board-drain (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
        }

        const allAttempts = allRows<AttemptRowShape>(
          root,
          `SELECT task_id, stage_id, status FROM attempts WHERE run_id = ? ORDER BY created_at ASC`,
          runId,
        );
        const taskDispositions: Record<string, string | null> = {};
        for (const taskId of ALL_TASK_IDS) {
          const task = readTaskRow(root, taskId);
          taskDispositions[taskId] = (task?.disposition as string | null | undefined) ?? null;
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
