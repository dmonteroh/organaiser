// Live scenario `live-layer-isolation` (goals spec section 23.1 and 29.6): writes a
// non-default vendor profile into the fixture repository's `orga.yaml` project layer — a
// `toolPolicy` (`allowedTools`/`disallowedTools`), an `environmentAllowlist`, and
// `sandboxMode` — while the `ORGA_`-prefixed environment layer overrides that same
// `sandboxMode` scalar to a different value, drives one task through the real production
// supervisor to a real vendor attempt at the `implement` stage that reaches
// `attempts.status = 'completed'`, and proves the worker's two granted capability layers
// (goals spec section 24's argv builder and environment allowlist; there is no third
// "skill" surface) are exactly what the resolved profile declares. It asserts the
// completed attempt's durable `config_json` profile deep-equals a fresh resolution over
// the same `orga.yaml` text and environment the supervisor was spawned with — so the
// environment layer's value, not the project layer's, appears for the doubly-set scalar —
// and separately asserts the vendor's own command-spec builder, called with a stub
// `VendorCommandContext` over that same resolved profile, returns args carrying the
// profile's model/effort/permission-or-sandbox-mode (and, for Claude, its
// allowedTools/disallowedTools in the profile's order) and an env whose keys are exactly
// the environmentAllowlist names present on the surface, with a deliberately planted
// non-allowlisted variable absent. The disallowed tool is one the seeded task's work never
// uses, so the policy is observable without affecting whether the attempt converges.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe reports
// the CLI installed and authenticated; otherwise it returns a stated skip reason before
// any vendor process — including the version/auth probe itself — is spawned. Targets no
// production service: Codex is pointed at a local Ollama model server through a
// fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: three `codex` runs and three `claude` runs on 2026-09-09, none
// reaching `completed`, all six resting `blocked`. Each `codex` run (`codex-cli 0.46.0`
// against a local `gpt-oss:20b` Ollama model, `ORGA_SPAWN_MS=120000` to clear this
// machine's real Codex startup latency) classified `status: "failed"`, `exit_code: 1` at
// the `implement` stage, ~92-159s each; no candidate report was produced, matching the
// `worker-crash`/`no-candidate-report` pattern already recorded against
// `14-live-single-task.ts`. Each `claude` run (`claude-cli 2.1.245`, model `sonnet`)
// classified `status: "failed"`, `exit_code: 1`, ~1.4-1.6s each, an undiagnosed Claude
// `worker-crash` on this dispatch path. No run has yet reached `completed`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initProject } from "../../src/store/init.ts";
import { startRun } from "../../src/engine/supervisor-spawn.ts";
import { claudeProbeSpec, createClaudeVendorAdapterSpec } from "../../src/adapters/claude-adapter.ts";
import { CODEX_VENDOR_PROBE_SPEC, createCodexVendorSpec } from "../../src/adapters/codex-adapter.ts";
import { probeVendor } from "../../src/adapters/probe.ts";
import { resolveVendorProfile, serializeResolvedProfile } from "../../src/cli/profiles.ts";
import type { AttemptDescriptor, ExecutionSurface } from "../../src/adapters/adapter.ts";
import type { VendorCommandContext } from "../../src/adapters/vendor-adapter.ts";
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
  ProcessRegistry,
} from "./harness.ts";

export type LiveVendor = "claude" | "codex";

export type LiveLayerIsolationResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      vendor: LiveVendor;
      model: string;
      resolvedSandboxMode: string;
      resolvedEffort: string;
      disallowedTools: readonly string[];
      environmentAllowlist: readonly string[];
      wallTimeMs: number;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const RUN_TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const LIVE_TASK_ID = "live-task";
const LIVE_TASK_TITLE = "Create a NOTES.md fixture marker file";
const LIVE_TASK_BRIEF_PATH = "live-task-brief.md";
const LIVE_TASK_MARKER_LINE = "live layer isolation fixture check";

const LIVE_TASK_BRIEF = [
  "# live-layer-isolation: create a fixture marker file",
  "",
  "## Objective",
  "",
  `Create a file named \`NOTES.md\` in the repository root containing exactly the`,
  `line \`${LIVE_TASK_MARKER_LINE}\`.`,
  "",
  "## Acceptance Criteria",
  "",
  "- A file named `NOTES.md` exists at the repository root.",
  `- \`NOTES.md\` contains the line \`${LIVE_TASK_MARKER_LINE}\`.`,
  "",
  "## Verification Commands",
  "",
  "- test -f NOTES.md",
  `- grep -Fq "${LIVE_TASK_MARKER_LINE}" NOTES.md`,
  "",
  "## Stop Condition",
  "",
  "Once `NOTES.md` exists with the required line and both verification",
  "commands above pass, the task is complete. Make no other changes.",
  "",
].join("\n");

function buildLiveBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "live-layer-isolation-board", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: LIVE_TASK_ID,
          title: LIVE_TASK_TITLE,
          briefPath: LIVE_TASK_BRIEF_PATH,
          entry: { workflowId: "dev-workflow", stageId: "implementation" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          // Disabled deliberately: this fixture seeds its own tasks row via `insertLiveTask`, so the board must not materialize it a second time.
          enabled: false,
        },
      ],
    },
  };
}

// The task enters directly at `stage_id: "implementation"` (`task-board`'s own stage id,
// not `dev-workflow`'s `"implement"`), never at `null`: `claims-available`'s admission
// gate (`board-predicates.ts`) requires a real `claims` table row this fixture never
// seeds, so a task admitted from `null` stalls at `acquire-claims` forever and never
// reaches a dispatchable stage. Entering directly at `"implementation"` bypasses that gate
// the same way `27-live-review-repair.ts`/`28-live-blocked-lane.ts` already do.
function insertLiveTask(root: string, runId: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        LIVE_TASK_ID,
        runId,
        LIVE_TASK_ID,
        LIVE_TASK_TITLE,
        LIVE_TASK_BRIEF_PATH,
        "task-board",
        "implementation",
        JSON.stringify([]),
        0,
        "implementing",
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
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-layer-isolation. Not a real project.\n");
  gitCapture(dir, ["add", "--", ".env", "README.md"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);
  initProject(dir);
  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);
}

// The scalar doubly set across layers is `sandboxMode`, never `effort`: Codex's own
// convergence recipe already needs `ORGA_SANDBOX_MODE=danger-full-access` from the
// environment layer regardless of this fixture, so the project layer can carry an
// unrelated, syntactically valid value (`read-only`, one of Codex's own real `--sandbox`
// literals) without changing what the live attempt actually runs under. Claude's own
// command builder never reads `sandboxMode` at all, so the same pair is harmless there
// too; only `config_json`'s resolved-profile snapshot (AC5) observes it.
const PROJECT_SANDBOX_MODE = "read-only";
const ENV_SANDBOX_MODE = "danger-full-access";
const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"] as const;
const DISALLOWED_TOOL = "WebSearch";
const PLANTED_ENV_VAR = "ORGA_LIVE_LAYER_ISOLATION_PLANTED";

function writeLayeredVendorProfile(dir: string, vendor: LiveVendor, environmentAllowlist: readonly string[]): string {
  const orgaYamlPath = path.join(dir, "orga.yaml");
  const existing = fs.readFileSync(orgaYamlPath, "utf8");
  const block = [
    "vendors:",
    `  ${vendor}:`,
    "    default:",
    `      sandboxMode: ${PROJECT_SANDBOX_MODE}`,
    "      allowedTools:",
    ...ALLOWED_TOOLS.map((tool) => `        - ${tool}`),
    "      disallowedTools:",
    `        - ${DISALLOWED_TOOL}`,
    "      environmentAllowlist:",
    ...environmentAllowlist.map((name) => `        - ${name}`),
    "",
  ].join("\n");
  const updated = `${existing}${block}`;
  fs.writeFileSync(orgaYamlPath, updated);
  return updated;
}

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

function diagnostics(root: string, runId: string): string {
  const attempts = allRows(root, `SELECT * FROM attempts WHERE run_id = ?`, runId);
  const workers = allRows(root, `SELECT * FROM workers WHERE run_id = ?`, runId);
  return `attempts=${JSON.stringify(attempts)}; workers=${JSON.stringify(workers)}`;
}

interface AttemptRowShape {
  id: string;
  stage_id: string;
  model: string;
  config_json: string;
  status: string;
}

export async function liveLayerIsolation(vendor: LiveVendor): Promise<LiveLayerIsolationResult> {
  const reason = await skipReason(vendor);
  if (reason) return { skipped: true, reason };

  return withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
    const root = path.join(dir, "repo");
    fs.mkdirSync(root);
    createThrowawayRepo(root);

    const environmentAllowlist = vendor === "codex" ? ["HOME", "PATH", "CODEX_HOME"] : ["HOME", "PATH"];
    let codexHome: string | undefined;
    if (vendor === "codex") codexHome = buildCodexHome();
    const orgaYamlText = writeLayeredVendorProfile(root, vendor, environmentAllowlist);

    try {
      fs.writeFileSync(path.join(root, LIVE_TASK_BRIEF_PATH), LIVE_TASK_BRIEF);
      const boardPath = path.join(root, "board.json");
      const workflowPath = path.join(root, "workflow.md");
      const templatePath = path.join(root, "template.md");
      const board = buildLiveBoard();
      fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
      fs.writeFileSync(workflowPath, "# workflow\n");
      fs.writeFileSync(templatePath, "# template\n");

      const restoreEnv = patchEnv({
        ORGA_VENDOR: vendor,
        ORGA_SANDBOX_MODE: ENV_SANDBOX_MODE,
        ...(vendor === "codex"
          ? {
              ORGA_MODEL: CODEX_LIVE_MODEL,
              CODEX_HOME: codexHome as string,
              ORGA_EFFORT: "low",
              ORGA_SPAWN_MS: "120000",
            }
          : {}),
      });
      const capturedEnv: NodeJS.ProcessEnv = { ...process.env };

      const startedAt = Date.now();
      let runId: string;
      let supervisorPid: number;
      try {
        const result = startRun({ root, boardPath, board, workflowPath, templatePath });
        if (result.supervisorPid === null) {
          throw new Error("liveLayerIsolation: startRun did not spawn a supervisor");
        }
        runId = result.runId;
        supervisorPid = result.supervisorPid;
        registry.track(supervisorPid);
      } finally {
        restoreEnv();
      }
      insertLiveTask(root, runId, startedAt);

      try {
        const reachedTerminal = await waitFor(() => {
          const run = readRunRow(root, runId);
          return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
        }, RUN_TERMINAL_TIMEOUT_MS, 500);
        const run = readRunRow(root, runId);

        for (const worker of allRows<{ pgid: number }>(root, `SELECT DISTINCT pgid FROM workers WHERE run_id = ?`, runId)) {
          registry.track(worker.pgid);
        }

        if (!reachedTerminal) {
          throw new Error(
            `live-layer-isolation (${vendor}): run did not reach a terminal state; runId ${runId}; ${diagnostics(root, runId)}`,
          );
        }

        const attempts = allRows<AttemptRowShape>(
          root,
          `SELECT id, stage_id, model, config_json, status FROM attempts WHERE run_id = ? ORDER BY created_at ASC`,
          runId,
        );
        const implementCompleted = attempts.find((a) => a.stage_id === "implement" && a.status === "completed");
        if (!implementCompleted) {
          throw new Error(
            `live-layer-isolation (${vendor}): no attempt at stage_id "implement" reached status "completed"; runId ${runId}; run reached terminal state ${JSON.stringify(run.state)}; ${diagnostics(root, runId)}`,
          );
        }

        const recordedConfig = JSON.parse(implementCompleted.config_json) as {
          profile: unknown;
          cliVersion: string | null;
          workflowRevision: string | null;
        };
        const expectedProfile = resolveVendorProfile("default", {
          vendor,
          env: capturedEnv,
          project: { path: path.join(root, "orga.yaml"), text: orgaYamlText },
        });
        const expectedSerializedProfile = JSON.parse(serializeResolvedProfile(expectedProfile)) as unknown;

        assert.deepEqual(
          recordedConfig.profile,
          expectedSerializedProfile,
          `live-layer-isolation (${vendor}): recorded config_json profile must deep-equal a fresh resolution over the captured orga.yaml text and environment; runId ${runId}; recorded=${JSON.stringify(recordedConfig.profile)}; expected=${JSON.stringify(expectedSerializedProfile)}`,
        );
        assert.equal(
          expectedProfile.sandboxMode,
          ENV_SANDBOX_MODE,
          `live-layer-isolation (${vendor}): the environment layer's sandboxMode must win over the project layer's; runId ${runId}`,
        );

        const stubEnvironment: NodeJS.ProcessEnv = {
          ...Object.fromEntries(expectedProfile.environmentAllowlist.map((name) => [name, `stub-${name}`])),
          [PLANTED_ENV_VAR]: "should-not-leak-into-vendor-env",
        };
        const stubSurface: ExecutionSurface = {
          workingDirectory: root,
          environment: stubEnvironment,
          sandboxMode: null,
          permissionMode: null,
          allowedTools: [],
          disallowedTools: [],
        };
        const stubAttempt: AttemptDescriptor = {
          attemptId: "stub-attempt",
          runId,
          taskId: LIVE_TASK_ID,
          stageId: "implement",
          roleId: "implementer",
          timeoutBudget: expectedProfile.timeouts,
        };
        const stubContext: VendorCommandContext = {
          attempt: stubAttempt,
          packet: "stub packet",
          surface: stubSurface,
          schemaPath: path.join(root, "stub-schema.json"),
          schemaText: "{}",
        };

        const spec =
          vendor === "claude" ? createClaudeVendorAdapterSpec(expectedProfile) : createCodexVendorSpec(expectedProfile);
        const command = spec.buildCommand(stubContext);

        const modelIndex = command.args.indexOf("--model");
        assert.ok(
          modelIndex >= 0 && command.args[modelIndex + 1] === expectedProfile.model,
          `live-layer-isolation (${vendor}): args must carry the profile's model; runId ${runId}; args=${JSON.stringify(command.args)}`,
        );

        if (vendor === "claude") {
          const effortIndex = command.args.indexOf("--effort");
          assert.equal(command.args[effortIndex + 1], expectedProfile.effort, `runId ${runId}`);
          const permissionIndex = command.args.indexOf("--permission-mode");
          assert.equal(command.args[permissionIndex + 1], expectedProfile.permissionMode, `runId ${runId}`);
          const allowedIndex = command.args.indexOf("--allowedTools");
          assert.deepEqual(
            command.args.slice(allowedIndex + 1, allowedIndex + 1 + expectedProfile.toolPolicy.allowedTools.length),
            [...expectedProfile.toolPolicy.allowedTools],
            `live-layer-isolation (${vendor}): --allowedTools must carry the profile's tools in order; runId ${runId}`,
          );
          const disallowedIndex = command.args.indexOf("--disallowedTools");
          assert.deepEqual(
            command.args.slice(
              disallowedIndex + 1,
              disallowedIndex + 1 + expectedProfile.toolPolicy.disallowedTools.length,
            ),
            [...expectedProfile.toolPolicy.disallowedTools],
            `live-layer-isolation (${vendor}): --disallowedTools must carry the profile's tools in order; runId ${runId}`,
          );
        } else {
          const effortArg = command.args.find((a) => a.startsWith("model_reasoning_effort="));
          assert.equal(
            effortArg,
            `model_reasoning_effort=${expectedProfile.effort}`,
            `live-layer-isolation (${vendor}): args must carry the profile's effort; runId ${runId}`,
          );
          const sandboxIndex = command.args.indexOf("--sandbox");
          assert.equal(
            command.args[sandboxIndex + 1],
            expectedProfile.sandboxMode,
            `live-layer-isolation (${vendor}): args must carry the profile's sandboxMode; runId ${runId}`,
          );
        }

        const expectedEnvKeys = new Set(expectedProfile.environmentAllowlist);
        assert.deepEqual(
          new Set(Object.keys(command.env)),
          expectedEnvKeys,
          `live-layer-isolation (${vendor}): the command's env keys must equal exactly the environmentAllowlist names present on the surface; runId ${runId}; env=${JSON.stringify(command.env)}`,
        );
        assert.equal(
          command.env[PLANTED_ENV_VAR],
          undefined,
          `live-layer-isolation (${vendor}): a non-allowlisted variable must never leak into the vendor's environment; runId ${runId}`,
        );

        await waitFor(() => !alive(supervisorPid), 10000);
        const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
        if (survivors.length > 0) {
          throw new Error(`live-layer-isolation (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
        }

        return {
          skipped: false,
          runId,
          vendor,
          model: implementCompleted.model,
          resolvedSandboxMode: expectedProfile.sandboxMode,
          resolvedEffort: expectedProfile.effort,
          disallowedTools: [...expectedProfile.toolPolicy.disallowedTools],
          environmentAllowlist: [...expectedProfile.environmentAllowlist],
          wallTimeMs: Date.now() - startedAt,
        };
      } finally {
        registry.killAll();
        await registry.allDead();
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
