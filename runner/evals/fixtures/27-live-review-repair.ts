// Live scenario `live-review-repair` (goals spec section 29.6: "reviewer finds a planted
// defect and a fresh fixer repairs it"): seeds one `implementation`-stage task in a
// throwaway repository, drives it through the real production supervisor
// (`createProductionSchedulerTick`, selected via `ORGA_VENDOR`) with the real vendor CLI,
// and proves from durable `gates`/`attempts`/`workers` rows alone — never from in-memory
// scheduler state — that a real `spec-reviewer` session found the planted defect, that a
// real, distinct `fix-spec` session (a different attempt, a different process group) then
// repaired it, and that the repaired candidate passed the second `spec-reviewer` round.
//
// The task's brief states an `## Objective` phrased colloquially ("stays under budget")
// alongside an `## Acceptance Criteria` bullet that states the same requirement precisely
// (spending exactly at the budget boundary is still within budget, not over): a common
// off-by-one gap between a plain-language objective and its precise boundary condition,
// planted for a real `spec-reviewer` to find by reading the code against the stated
// requirement, not by any fixture-side patch to the reviewed code itself.
//
// The task enters at `stage_id: "implementation"` (`task-board`'s own stage id, not
// `dev-workflow`'s `"implement"`), so `dispatchEligible` routes it to
// `runDevelopmentStages` and the whole `DEVELOPMENT_STAGES` pipeline — `implement`,
// `collect-implementation-artifacts`, `verify-task`, `review-spec`, `fix-spec`,
// `review-quality`, `record-minors`, `ready-to-integrate` — runs inside that one tick
// (`dispatchEligible` passes `requiredArtifacts: []` and `checks: {}`, so the runner's own
// barrier never itself inspects the planted defect; only the real `spec-reviewer` session
// does). `finalizeGate`/`discardPendingGate` (`workflow-stages.ts`) only ever finalizes a
// gate's counted-failure edge; a passing round is discarded rather than recorded, so a
// second `review-spec` round returning `pass` leaves no round-2 `gates` row — the
// `review-quality` attempt row that stage's own dispatch creates is the only durable proof
// of it.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe reports
// the CLI installed and authenticated; otherwise it returns a stated skip reason before any
// vendor process — including the version/auth probe itself — is spawned. Targets no
// production service: Codex is pointed at a local Ollama model server through a
// fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: one `codex` run on 2026-09-09 (`codex-cli 0.46.0` against a local
// `gpt-oss:20b` Ollama model) reached a resting run state but recorded zero `specReviewGate`
// rows where exactly one round-1 `fail` row was expected; the ephemeral fixture workspace
// was already torn down by the time this assertion failure surfaced, so whether the
// implementer's own candidate actually satisfied the boundary requirement or an earlier
// stage failed before ever reaching `review-spec` was not preserved for inspection. One
// `claude` run on 2026-09-09 (`claude-cli 2.1.245`) failed the readiness probe itself
// (`claude auth status --json`'s 8-second budget) under this environment's heavy
// concurrent load — confirmed by a direct, non-fixture invocation of the same command also
// exceeding 8 seconds — so no vendor process for the fixture's own attempt was ever spawned.
// No run has yet reached the asserted round-1-fail/fix-spec/review-quality evidence set.

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

export type LiveReviewRepairResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      state: string;
      vendor: LiveVendor;
      wallTimeMs: number;
      taskDisposition: string | null;
      reviewGateFindingsCount: number;
      fixSpecAttemptId: string;
      reviewQualityAttemptId: string;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const RUN_TERMINAL_TIMEOUT_MS = 30 * 60 * 1000;
const SUPERVISOR_EXIT_TIMEOUT_MS = 30000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const REVIEW_REPAIR_TASK_ID = "review-repair-task";
const REVIEW_REPAIR_TASK_TITLE = "Add a budget boundary check to src/budget.ts";
const REVIEW_REPAIR_BRIEF_PATH = "review-repair-task-brief.md";

const REVIEW_REPAIR_BRIEF = [
  "# live-review-repair: budget boundary check",
  "",
  "## Objective",
  "",
  "Implement a budget-tracking helper in `src/budget.ts`, exporting a function",
  "`isWithinBudget(spentCents, budgetCents)` that reports whether the given spend",
  "stays under budget.",
  "",
  "## Acceptance Criteria",
  "",
  "- `isWithinBudget` is exported from `src/budget.ts` and accepts two integer",
  "  arguments, `spentCents` and `budgetCents`.",
  "- `isWithinBudget` returns `true` when `spentCents` is strictly less than",
  "  `budgetCents`.",
  "- `isWithinBudget` returns `true` when `spentCents` equals `budgetCents`",
  "  exactly: spending exactly the full budget is within budget, not over.",
  "- `isWithinBudget` returns `false` when `spentCents` is strictly greater than",
  "  `budgetCents`.",
  "- `isWithinBudget` returns `true` when `spentCents` is `0`, for any",
  "  non-negative `budgetCents`.",
  "",
  "## Verification Commands",
  "",
  '- node --input-type=module -e "import { isWithinBudget } from \'./src/budget.ts\'; if (isWithinBudget(100, 100) !== true) throw new Error(\'boundary case failed\');"',
  "",
  "## Stop Condition",
  "",
  "Once `src/budget.ts` exports `isWithinBudget` satisfying every Acceptance",
  "Criteria bullet above, report completion. Make no other changes.",
  "",
].join("\n");

function buildPlaceholderBoard(): unknown {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "live-review-repair-board", contractVersion: "v1" },
    spec: {
      tasks: [
        {
          id: "review-repair-placeholder",
          title: "live-review-repair placeholder board entry",
          briefPath: "review-repair-placeholder-brief.md",
          entry: { workflowId: "dev-workflow", stageId: "implementation" },
          dependencies: [],
          priority: 0,
          requiredWorkflowVersions: {},
          claims: "unknown",
          verification: [],
          // Disabled deliberately: this fixture seeds its own tasks row via `insertReviewRepairTask`, so the board must not materialize it a second time.
          enabled: false,
        },
      ],
    },
  };
}

function insertReviewRepairTask(root: string, runId: string, now: number): void {
  const db = openStore(root);
  try {
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        REVIEW_REPAIR_TASK_ID,
        runId,
        REVIEW_REPAIR_TASK_ID,
        REVIEW_REPAIR_TASK_TITLE,
        REVIEW_REPAIR_BRIEF_PATH,
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
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-review-repair. Not a real project.\n");
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

interface GateRow {
  round: number;
  verdict: string | null;
  evidence_ref: string | null;
}

interface AttemptRow {
  id: string;
  stage_id: string;
  round: number;
  status: string;
}

interface WorkerPgidRow {
  attempt_id: string;
  pgid: number;
}

export async function liveReviewRepair(vendor: LiveVendor): Promise<LiveReviewRepairResult> {
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
      fs.writeFileSync(path.join(root, REVIEW_REPAIR_BRIEF_PATH), REVIEW_REPAIR_BRIEF);

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
          throw new Error("liveReviewRepair: startRun did not spawn a supervisor");
        }
        runId = result.runId;
        supervisorPid = result.supervisorPid;
      } finally {
        restoreEnv();
      }
      insertReviewRepairTask(root, runId, startedAt);

      try {
        const reachedTerminal = await waitFor(() => {
          const run = readRunRow(root, runId);
          return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
        }, RUN_TERMINAL_TIMEOUT_MS, 500);

        const run = readRunRow(root, runId);
        if (!reachedTerminal) {
          throw new Error(
            `live-review-repair (${vendor}): run did not reach a resting state within ${RUN_TERMINAL_TIMEOUT_MS}ms; last state: ${JSON.stringify(run)}`,
          );
        }

        const gateRows = allRows<GateRow>(
          root,
          `SELECT round, verdict, evidence_ref FROM gates
             WHERE run_id = ? AND task_id = ? AND gate_type = 'specReviewGate'
             ORDER BY round ASC`,
          runId,
          REVIEW_REPAIR_TASK_ID,
        );
        if (gateRows.length !== 1) {
          throw new Error(
            `live-review-repair (${vendor}): expected exactly one specReviewGate row, found ${gateRows.length}; rows=${JSON.stringify(gateRows)}; runId ${runId}`,
          );
        }
        const gateRow = gateRows[0]!;
        if (gateRow.round !== 1 || gateRow.verdict !== "fail") {
          throw new Error(
            `live-review-repair (${vendor}): the sole specReviewGate row is not round 1 verdict fail; row=${JSON.stringify(gateRow)}; runId ${runId}`,
          );
        }
        if (!gateRow.evidence_ref) {
          throw new Error(
            `live-review-repair (${vendor}): the round-1 specReviewGate row carries no evidence_ref; runId ${runId}`,
          );
        }
        let parsedEvidence: { findings?: unknown };
        try {
          parsedEvidence = JSON.parse(gateRow.evidence_ref) as { findings?: unknown };
        } catch (err) {
          throw new Error(
            `live-review-repair (${vendor}): round-1 specReviewGate evidence_ref is not valid JSON: ${err instanceof Error ? err.message : String(err)}; evidence_ref=${gateRow.evidence_ref}; runId ${runId}`,
          );
        }
        const findings = Array.isArray(parsedEvidence.findings) ? parsedEvidence.findings : [];
        if (findings.length < 1) {
          throw new Error(
            `live-review-repair (${vendor}): round-1 specReviewGate evidence_ref carries no findings; evidence_ref=${gateRow.evidence_ref}; runId ${runId}`,
          );
        }

        const attemptRows = allRows<AttemptRow>(
          root,
          `SELECT id, stage_id, round, status FROM attempts WHERE run_id = ? AND task_id = ? ORDER BY created_at ASC`,
          runId,
          REVIEW_REPAIR_TASK_ID,
        );
        const roundOneReviewSpec = attemptRows.find((a) => a.stage_id === "review-spec" && a.round === 1);
        if (!roundOneReviewSpec) {
          throw new Error(
            `live-review-repair (${vendor}): no round-1 review-spec attempt row found; attempts=${JSON.stringify(attemptRows)}; runId ${runId}`,
          );
        }
        const fixSpecCompleted = attemptRows.find((a) => a.stage_id === "fix-spec" && a.status === "completed");
        if (!fixSpecCompleted) {
          throw new Error(
            `live-review-repair (${vendor}): no completed fix-spec attempt row found; attempts=${JSON.stringify(attemptRows)}; runId ${runId}`,
          );
        }
        if (fixSpecCompleted.id === roundOneReviewSpec.id) {
          throw new Error(
            `live-review-repair (${vendor}): fix-spec attempt shares its id with the round-1 review-spec attempt: ${fixSpecCompleted.id}; runId ${runId}`,
          );
        }
        const reviewQuality = attemptRows.find((a) => a.stage_id === "review-quality");
        if (!reviewQuality) {
          throw new Error(
            `live-review-repair (${vendor}): no review-quality attempt row found (the only durable proof the second review-spec round returned pass); attempts=${JSON.stringify(attemptRows)}; runId ${runId}`,
          );
        }

        const workerPgidRows = allRows<WorkerPgidRow>(
          root,
          `SELECT attempt_id, pgid FROM workers WHERE run_id = ? AND attempt_id IN (?, ?)`,
          runId,
          roundOneReviewSpec.id,
          fixSpecCompleted.id,
        );
        const pgidByAttemptId = new Map(workerPgidRows.map((row) => [row.attempt_id, row.pgid]));
        const roundOneReviewSpecPgid = pgidByAttemptId.get(roundOneReviewSpec.id);
        const fixSpecPgid = pgidByAttemptId.get(fixSpecCompleted.id);
        if (roundOneReviewSpecPgid === undefined || fixSpecPgid === undefined) {
          throw new Error(
            `live-review-repair (${vendor}): missing a recorded workers.pgid for the round-1 review-spec or fix-spec attempt; rows=${JSON.stringify(workerPgidRows)}; runId ${runId}`,
          );
        }
        if (roundOneReviewSpecPgid === fixSpecPgid) {
          throw new Error(
            `live-review-repair (${vendor}): fix-spec attempt shares its worker pgid ${fixSpecPgid} with the round-1 review-spec attempt; runId ${runId}`,
          );
        }

        const taskRow = readTaskRow(root, REVIEW_REPAIR_TASK_ID);
        const taskDisposition = (taskRow?.disposition as string | null | undefined) ?? null;

        const supervisorExited = await waitFor(() => !alive(supervisorPid), SUPERVISOR_EXIT_TIMEOUT_MS);
        if (!supervisorExited) {
          throw new Error(
            `live-review-repair (${vendor}): supervisor pid ${supervisorPid} did not exit within ${SUPERVISOR_EXIT_TIMEOUT_MS}ms; runId ${runId}`,
          );
        }
        const survivors = recordedPgidsForRun(root, runId).filter((pgid) => groupAlive(pgid));
        if (survivors.length > 0) {
          throw new Error(`live-review-repair (${vendor}): process group(s) survived: ${JSON.stringify(survivors)}`);
        }

        return {
          skipped: false,
          runId,
          state: run.state as string,
          vendor,
          wallTimeMs: Date.now() - startedAt,
          taskDisposition,
          reviewGateFindingsCount: findings.length,
          fixSpecAttemptId: fixSpecCompleted.id,
          reviewQualityAttemptId: reviewQuality.id,
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
