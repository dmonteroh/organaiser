// Live scenario `live-vendor-parity` (goals spec sections 29.6/29.7): drives one
// identical, vendor-independent bounded task through the real production supervisor
// (`createProductionSchedulerTick`, selected via `ORGA_VENDOR`) once under each vendor,
// in a throwaway git repository with a fake application credential, and records each
// run's resting state, CLI version, workflow revision and model so `eval compare --vary
// vendor` can diff the two matched, graded cells. Parity does not mean both vendors
// pass: a vendor that fails is recorded honestly, and the fixture itself never chooses
// which vendor "should" pass.
//
// Every vendor-independent input the run depends on (brief text, board object, task
// row, stage id, grader and timeout budget) comes from one `buildParityInputs` builder,
// hashed for both vendors and compared before `startRun` ever runs: a future
// vendor-specific tweak to any of those inputs fails the fixture rather than silently
// breaking parity.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe
// reports the CLI installed and authenticated; otherwise it returns a stated skip
// reason before any vendor process — including the version/auth probe itself — is
// spawned. Targets no production service: Codex is pointed at a local Ollama model
// server through a fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: three `claude` runs and three `codex` runs on 2026-09-09, all
// resting `blocked`. Each `claude` run (`claude-cli 2.1.245`, model `sonnet`) classified
// `failureClass: "worker-crash"`, `reason: "no-candidate-report"`, `exit_code: 1`, ~2.1s
// wall time. Each `codex` run (`codex-cli 0.46.0` against a local `gpt-oss:20b` Ollama
// model) landed `interrupted`/`worker-timeout` (`firedBudget: "spawn-timeout"`, the
// attempt never produced output within its 30s spawn budget), 30.6s-142.9s wall time. In
// every run, `parityInputsSha256` matched across both vendors, confirming the parity
// inputs are genuinely vendor-independent. No run has yet reached `succeeded`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initProject } from "../../src/store/init.ts";
import { startRun } from "../../src/engine/supervisor-spawn.ts";
import { claudeProbeSpec } from "../../src/adapters/claude-adapter.ts";
import { CODEX_VENDOR_PROBE_SPEC } from "../../src/adapters/codex-adapter.ts";
import { probeVendor } from "../../src/adapters/probe.ts";
import { sha256 } from "../../src/store/evidence.ts";
import {
  withFixtureWorkspace,
  openStore,
  withTransaction,
  readRunRow,
  allRows,
  recordedPgidsForRun,
  waitFor,
  alive,
  groupAlive,
} from "./harness.ts";

export type LiveVendor = "claude" | "codex";

export type LiveVendorParityResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      state: string;
      vendor: LiveVendor;
      model: string;
      cliVersion: string | null;
      workflowRevision: string | null;
      parityInputsSha256: string;
      wallTimeMs: number;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const RUN_TERMINAL_TIMEOUT_MS = 20 * 60 * 1000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const PARITY_TASK_ID = "vendor-parity-task";
const PARITY_TASK_TITLE = "Create a PARITY.md fixture marker file";
const PARITY_BRIEF_PATH = "vendor-parity-brief.md";
const PARITY_MARKER_LINE = "live vendor parity dispatch packet fixture check";
const PARITY_STAGE_ID = "implementation";
const PARITY_GRADER = 'resting run state equals "succeeded"';

const PARITY_TASK_BRIEF = [
  "# live-vendor-parity: create a fixture marker file",
  "",
  "## Objective",
  "",
  "Create a file named `PARITY.md` in the repository root containing exactly the",
  `line \`${PARITY_MARKER_LINE}\`.`,
  "",
  "## Acceptance Criteria",
  "",
  "- A file named `PARITY.md` exists at the repository root.",
  `- \`PARITY.md\` contains the line \`${PARITY_MARKER_LINE}\`.`,
  "",
  "## Verification Commands",
  "",
  "- test -f PARITY.md",
  `- grep -Fq "${PARITY_MARKER_LINE}" PARITY.md`,
  "",
  "## Stop Condition",
  "",
  "Once `PARITY.md` exists with the required line and both verification",
  "commands above pass, the task is complete. Make no other changes.",
  "",
].join("\n");

function buildParityBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "live-vendor-parity-board", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: "vendor-parity-placeholder",
          title: "live-vendor-parity placeholder board entry",
          briefPath: "vendor-parity-placeholder-brief.md",
          entry: { workflowId: "dev-workflow", stageId: "implementation" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          // Disabled deliberately: this fixture seeds its own tasks row via `insertParityTask`, so the board must not materialize it a second time.
          enabled: false,
        },
      ],
    },
  };
}

interface ParityTaskInputs {
  id: string;
  taskKey: string;
  title: string;
  briefPath: string;
  workflowId: string;
  stageId: string;
  priority: number;
  state: string;
}

interface ParityInputs {
  brief: string;
  board: unknown;
  task: ParityTaskInputs;
  stageId: string;
  grader: string;
  timeoutBudgetMs: number;
}

// `vendor` is accepted but a correct implementation ignores it: the parameter exists so
// this signature could carry a vendor-conditional branch, and the parity assertion below
// (`digestFor` hashing both vendors' output and comparing) proves it does not.
function buildParityInputs(vendor: LiveVendor): ParityInputs {
  return {
    brief: PARITY_TASK_BRIEF,
    board: buildParityBoard(),
    task: {
      id: PARITY_TASK_ID,
      taskKey: PARITY_TASK_ID,
      title: PARITY_TASK_TITLE,
      briefPath: PARITY_BRIEF_PATH,
      workflowId: "task-board",
      stageId: PARITY_STAGE_ID,
      priority: 0,
      state: "implementing",
    },
    stageId: PARITY_STAGE_ID,
    grader: PARITY_GRADER,
    timeoutBudgetMs: RUN_TERMINAL_TIMEOUT_MS,
  };
}

const digestFor = (v: LiveVendor) => sha256(JSON.stringify(buildParityInputs(v)));

function assertParityInputs(): string {
  const parityInputsSha256 = digestFor("claude");
  const codexDigest = digestFor("codex");
  if (parityInputsSha256 !== codexDigest) {
    throw new Error(
      `live-vendor-parity: inputs differ across vendors (claude=${parityInputsSha256}, codex=${codexDigest})`,
    );
  }
  return parityInputsSha256;
}

// Task rows seeded at `stage_id: null` progress through `admit-task` ->
// `release-dependencies` -> `acquire-claims` -> `admit-to-batch` before ever reaching
// `implementation`; `acquire-claims` requires a `claims` row nothing here creates, so
// this task is seeded directly at `stage_id: "implementation"` (state `"implementing"`,
// `STAGE_TASK_STATE`'s own mapping for that stage), skipping that progression entirely.
function insertParityTask(root: string, runId: string, now: number, task: ParityTaskInputs): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        task.id,
        runId,
        task.taskKey,
        task.title,
        task.briefPath,
        task.workflowId,
        task.stageId,
        JSON.stringify([]),
        task.priority,
        task.state,
        null,
        now,
        now,
      );
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
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-vendor-parity. Not a real project.\n");
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
  try {
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
  } catch (err) {
    // The directory exists from `mkdtempSync` onward, so any later throw leaves it
    // behind. No caller-side `finally` can remove it: the caller's `codexHome` is
    // still unassigned while the throw propagates, so its `if (codexHome)` is false.
    try {
      fs.rmSync(codexHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    throw err;
  }
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
  stage_id: string;
  vendor: string;
  model: string;
  config_json: string;
  status: string;
  exit_code: number | null;
}

interface AttemptConfigJson {
  profile?: { effort?: string };
  cliVersion?: string | null;
  workflowRevision?: string | null;
}

export async function liveVendorParity(vendor: LiveVendor): Promise<LiveVendorParityResult> {
  const parityInputsSha256 = assertParityInputs();

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

    try {
      const inputs = buildParityInputs(vendor);
      fs.writeFileSync(path.join(root, PARITY_BRIEF_PATH), inputs.brief);
      const boardPath = path.join(root, "board.json");
      const workflowPath = path.join(root, "workflow.md");
      const templatePath = path.join(root, "template.md");
      fs.writeFileSync(boardPath, JSON.stringify(inputs.board, null, 2));
      fs.writeFileSync(workflowPath, "# workflow\n");
      fs.writeFileSync(templatePath, "# template\n");

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
        const result = startRun({ root, boardPath, board: inputs.board, workflowPath, templatePath });
        if (result.supervisorPid === null) {
          throw new Error("liveVendorParity: startRun did not spawn a supervisor");
        }
        runId = result.runId;
        supervisorPid = result.supervisorPid;
      } finally {
        restoreEnv();
      }

      try {
        insertParityTask(root, runId, startedAt, inputs.task);
        const reachedTerminal = await waitFor(() => {
          const run = readRunRow(root, runId);
          return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
        }, inputs.timeoutBudgetMs, 500);

        const run = readRunRow(root, runId);
        if (!reachedTerminal) {
          throw new Error(
            `live-vendor-parity (${vendor}): run did not reach a terminal state within ${inputs.timeoutBudgetMs}ms; last state: ${JSON.stringify(run)}`,
          );
        }

        const attempts = allRows<AttemptRowShape>(
          root,
          `SELECT stage_id, vendor, model, config_json, status, exit_code FROM attempts WHERE run_id = ? ORDER BY created_at ASC`,
          runId,
        );
        const implementAttempt = attempts.find((a) => a.stage_id === "implement");
        const config: AttemptConfigJson = implementAttempt ? (JSON.parse(implementAttempt.config_json) as AttemptConfigJson) : {};

        await waitFor(() => !alive(supervisorPid), 10000);
        const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
        if (survivors.length > 0) {
          throw new Error(`live-vendor-parity (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
        }

        return {
          skipped: false,
          runId,
          state: run.state as string,
          vendor,
          model: implementAttempt?.model ?? "unknown",
          cliVersion: config.cliVersion ?? null,
          workflowRevision: config.workflowRevision ?? null,
          parityInputsSha256,
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
