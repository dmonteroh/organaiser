// Live scenario `live-single-task` (goals spec section 29.6, narrowed for this child to
// one bounded task dispatched once through a real vendor adapter): creates a throwaway
// git repository in a temporary directory with a fake application credential, drives
// one task through the real production supervisor (`createProductionSchedulerTick`,
// selected via `ORGA_VENDOR`) with the real vendor CLI, and asserts the run reaches
// `succeeded` with no surviving process group. Schema validity is proved durably rather
// than by re-reading vendor output: `classifyAttempt` (`src/adapters/classify.ts`) only
// marks an attempt `completed` once its candidate report has passed schema validation,
// so a `completed` attempt row is proof the report was schema-valid.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe
// reports the CLI installed and authenticated; otherwise it returns a stated skip
// reason before any vendor process — including the version/auth probe itself — is
// spawned. Targets no production service: Codex is pointed at a local Ollama model
// server through a fixture-owned `CODEX_HOME`, never the operator's real one.

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
  writeFixtureFiles,
  boardWithTasks,
  seedTasks,
  readRunRow,
  allRows,
  recordedPgidsForRun,
  waitFor,
  alive,
  groupAlive,
  type FixtureTaskSpec,
} from "./harness.ts";

export type LiveVendor = "claude" | "codex";

export type LiveSingleTaskResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      state: string;
      vendor: LiveVendor;
      model: string;
      effort: string;
      cliVersion: string | null;
      workflowRevision: string | null;
      wallTimeMs: number;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const RUN_TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

function gitCapture(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function createThrowawayRepo(dir: string): void {
  gitCapture(dir, ["init", "-q"]);
  gitCapture(dir, ["config", "commit.gpgsign", "false"]);
  gitCapture(dir, ["config", "user.name", "Live Fixture Operator"]);
  gitCapture(dir, ["config", "user.email", "live-fixture@example.com"]);
  fs.writeFileSync(path.join(dir, ".env"), "APP_API_KEY=fake-not-a-real-credential\n");
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-single-task. Not a real project.\n");
  gitCapture(dir, ["add", "--", ".env", "README.md"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);
  initProject(dir);
  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);
}

// Arrays are configurable only through project/user YAML files (`profiles.ts`'s own
// design note), so `environmentAllowlist` cannot ride an `ORGA_`-prefixed environment
// variable; this appends the block `resolveVendorProfile` reads for a vendor's
// default capability class to the `orga.yaml` `initProject` already wrote.
// `resolveVendorProfile`'s built-in default allowlist is empty, and the spawned
// attempt's environment is built solely from that list (`buildClaudeAttemptCommand`,
// `buildCodexAttemptCommand`): with nothing allowlisted, the child process would
// receive no `PATH` to resolve its own executable by and no `HOME` to find its
// credentials, so every vendor branch here allowlists at least those two.
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

// The Codex live-run recipe: a fixture-owned `CODEX_HOME` selects a custom
// `wire_api = "responses"` provider against the local Ollama server (Ollama's
// `/v1/chat/completions` route rejects `--output-schema`, which the shipped adapter
// always emits) without ever writing to the operator's real `~/.codex/`. `auth.json` is
// a symlink, never a copy, to the operator's real credential file.
//
// `CODEX_HOME` gets its own, independent temporary directory rather than nesting under
// the git project root's own temporary parent: `codex-home/sessions/` accumulates this
// same agent's own rollout transcripts as the attempt runs, and a `danger-full-access`
// sandbox lets the model read anything it can reach by a relative path — nesting the two
// would let a `..`-relative read fold the agent's own growing transcript back into its
// own context, observed to cascade into unbounded turns and a mid-stream disconnect.
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
  vendor: string;
  model: string;
  config_json: string;
  status: string;
}

interface AttemptConfigJson {
  profile?: { effort?: string };
  cliVersion?: string | null;
  workflowRevision?: string | null;
}

export async function liveSingleTask(vendor: LiveVendor): Promise<LiveSingleTaskResult> {
  const reason = await skipReason(vendor);
  if (reason) return { skipped: true, reason };

  return withFixtureWorkspace(async (dir) => {
    // The git project root is nested one level inside the fixture's own temporary
    // directory, not placed at it directly: `sandboxMode: "workspace-write"` restricts
    // writes but not reads, so a real vendor agent's own filesystem exploration reading
    // one level above its working directory finds only this fixture's own small
    // subtree, never the shared system temporary directory `withFixtureWorkspace` uses.
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

    const tasks: FixtureTaskSpec[] = [{ id: "live-task", title: "live-single-task" }];
    const { boardPath, workflowPath, templatePath } = writeFixtureFiles(root, tasks);
    const board = boardWithTasks(tasks);

    // A vague, unbounded packet (`dispatchEligible`'s own fixed placeholder, not this
    // fixture's to change) left to a real agentic CLI's default `workspace-write`
    // sandbox and its default reasoning effort produced two observed failure modes on
    // this machine: sandbox-denied tool calls the model attempted anyway
    // (`failureClass: "permission-denied"`), and, once denials were removed, a
    // multi-minute exploration whose eventual reply never arrived
    // (`failureClass: "worker-crash"`, `no-candidate-report`). `danger-full-access` and
    // a low reasoning effort are this fixture's own choice of profile overrides to make
    // one bounded live turn actually converge; they are not part of the shipped
    // production default for either vendor.
    const restoreEnv = patchEnv({
      ORGA_VENDOR: vendor,
      ...(vendor === "codex"
        ? {
            ORGA_MODEL: CODEX_LIVE_MODEL,
            CODEX_HOME: codexHome as string,
            ORGA_SANDBOX_MODE: "danger-full-access",
            ORGA_EFFORT: "low",
          }
        : {}),
    });

    const startedAt = Date.now();
    let runId: string;
    let supervisorPid: number;
    try {
      const result = startRun({ root, boardPath, board, workflowPath, templatePath });
      if (result.supervisorPid === null) {
        throw new Error("liveSingleTask: startRun did not spawn a supervisor");
      }
      runId = result.runId;
      supervisorPid = result.supervisorPid;
    } finally {
      restoreEnv();
    }
    seedTasks(root, runId, tasks, startedAt);

    try {
      const reachedTerminal = await waitFor(() => {
        const run = readRunRow(root, runId);
        return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
      }, RUN_TERMINAL_TIMEOUT_MS, 500);

      const run = readRunRow(root, runId);
      if (!reachedTerminal) {
        throw new Error(
          `live-single-task (${vendor}): run did not reach a terminal state within ${RUN_TERMINAL_TIMEOUT_MS}ms; last state: ${JSON.stringify(run)}`,
        );
      }
      if (run.state !== "succeeded") {
        throw new Error(
          `live-single-task (${vendor}): run reached terminal state ${JSON.stringify(run.state)}, expected "succeeded"; reason: ${JSON.stringify(run.terminal_reason)}`,
        );
      }

      const attempts = allRows<AttemptRowShape>(
        root,
        `SELECT vendor, model, config_json, status FROM attempts WHERE run_id = ?`,
        runId,
      );
      const completed = attempts.find((a) => a.status === "completed");
      if (!completed) {
        throw new Error(
          `live-single-task (${vendor}): no attempt reached status "completed"; attempts: ${JSON.stringify(attempts)}`,
        );
      }
      const config = JSON.parse(completed.config_json) as AttemptConfigJson;

      await waitFor(() => !alive(supervisorPid), 10000);
      const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
      if (survivors.length > 0) {
        throw new Error(`live-single-task (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
      }

      return {
        skipped: false,
        runId,
        state: run.state as string,
        vendor,
        model: completed.model,
        effort: config.profile?.effort ?? "unknown",
        cliVersion: config.cliVersion ?? null,
        workflowRevision: config.workflowRevision ?? null,
        wallTimeMs: Date.now() - startedAt,
      };
    } finally {
      if (alive(supervisorPid)) {
        try {
          process.kill(-supervisorPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
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
