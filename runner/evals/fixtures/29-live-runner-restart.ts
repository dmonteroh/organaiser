// Live scenario `live-runner-restart` (goals spec section 23.1 and 29.6): drives one task
// through the real production supervisor (`startRun`, `ORGA_VENDOR`) to a real vendor
// attempt at the `implement` stage, SIGKILLs both the supervisor's own process group and
// that attempt's worker process group mid-attempt, then resumes the same run id by
// spawning `supervisor.ts` directly (mirroring `cmdRunResume`'s own inline spawn, which
// has no exported primitive). It asserts, from durable `attempts`/`workers`/`events` rows
// only: a resume attempted before the killed supervisor's lease is stale exits `4`; the
// resumed supervisor's startup reconciliation writes a `reconcile.classified` event for
// the killed worker carrying `interruptReason: "indeterminate"` and a non-`"live"`
// classification; the killed attempt's row lands `status = 'interrupted'`,
// `interrupt_reason = 'indeterminate'`; the run reaches a terminal state under the
// resumed supervisor; no duplicate `(task_id, stage_id, round, input_version)` tuple
// exists; at most one attempt at the killed stage is not `interrupted`; and no attempt
// that ever reached `completed` is later `interrupted`.
//
// By current engine design, a mutating in-flight attempt's result can never be preserved
// across a restart (`reconcile.ts`'s own header: "reconciling a mutating worktree after a
// crash requires tooling this phase doesn't implement"), so the killed attempt is always
// discarded rather than resumed; the resumed supervisor's own ordinary dispatch is free to
// redispatch the same task from a fresh round, and this fixture does not prescribe which
// terminal state that eventually settles into.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe reports
// the CLI installed and authenticated; otherwise it returns a stated skip reason before
// any vendor process — including the version/auth probe itself — is spawned. Targets no
// production service: Codex is pointed at a local Ollama model server through a
// fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: one `codex` run and one `claude` run on 2026-09-09, both
// resting `blocked`. The `codex` run (`codex-cli 0.46.0` against a local `gpt-oss:20b`
// Ollama model) took ~7.1s wall time; the killed worker classified `exited`, the killed
// attempt landed `interrupted`/`indeterminate`, the resume before staleness exited `4`,
// and a fresh round-2 `implement` attempt was redispatched by the resumed supervisor. The
// `claude` run (`claude-cli 2.1.245`, model `sonnet`) took ~7.5s wall time with the same
// classification/interrupt/exit-4/redispatch shape. Both runs satisfied every assertion.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  allRows,
  waitFor,
  alive,
  groupAlive,
  ProcessRegistry,
  sleep,
} from "./harness.ts";

export type LiveVendor = "claude" | "codex";

export type LiveRunnerRestartResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      runId: string;
      vendor: LiveVendor;
      killedAttemptId: string;
      classification: string;
      interruptReason: string | null;
      tooEarlyResumeExitCode: number;
      finalState: string;
      implementAttemptCount: number;
      wallTimeMs: number;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const IMPLEMENT_RUNNING_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_TERMINAL_TIMEOUT_MS = 10 * 60 * 1000;
const LEASE_STALENESS_WAIT_MS = 6000;
const CODEX_LIVE_MODEL = "gpt-oss:20b";

const SUPERVISOR_ENTRY_PATH = fileURLToPath(new URL("../../src/engine/supervisor.ts", import.meta.url));

const LIVE_TASK_ID = "live-task";
const LIVE_TASK_TITLE = "Create a NOTES.md fixture marker file";
const LIVE_TASK_BRIEF_PATH = "live-task-brief.md";
const LIVE_TASK_MARKER_LINE = "live runner restart fixture check";

const LIVE_TASK_BRIEF = [
  "# live-runner-restart: create a fixture marker file",
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
    metadata: { id: "live-runner-restart-board", contractVersion: "v1" },
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
          enabled: true,
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
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-runner-restart. Not a real project.\n");
  gitCapture(dir, ["add", "--", ".env", "README.md"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);
  initProject(dir);
  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);
}

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

function spawnResumeSupervisor(root: string, runId: string): ChildProcess {
  const runDir = path.join(root, ".orga", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(runDir, "supervisor.log");
  const logFd = fs.openSync(logPath, "a", 0o600);
  try {
    return spawn(process.execPath, [SUPERVISOR_ENTRY_PATH, root, runId], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: root,
    });
  } finally {
    fs.closeSync(logFd);
  }
}

function diagnostics(root: string, runId: string): string {
  const attempts = allRows(root, `SELECT * FROM attempts WHERE run_id = ?`, runId);
  const workers = allRows(root, `SELECT * FROM workers WHERE run_id = ?`, runId);
  const events = allRows(root, `SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC`, runId);
  return `attempts=${JSON.stringify(attempts)}; workers=${JSON.stringify(workers)}; events=${JSON.stringify(events)}`;
}

interface LiveWorkerRow {
  attempt_id: string;
  pid: number;
  pgid: number;
}

export async function liveRunnerRestart(vendor: LiveVendor): Promise<LiveRunnerRestartResult> {
  const reason = await skipReason(vendor);
  if (reason) return { skipped: true, reason };

  return withFixtureWorkspace(async (dir) => {
    const registry = new ProcessRegistry();
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
      let firstSupervisorPid: number;
      try {
        const result = startRun({ root, boardPath, board, workflowPath, templatePath });
        if (result.supervisorPid === null) {
          throw new Error("liveRunnerRestart: startRun did not spawn a supervisor");
        }
        runId = result.runId;
        firstSupervisorPid = result.supervisorPid;
        registry.track(firstSupervisorPid);
      } finally {
        restoreEnv();
      }
      insertLiveTask(root, runId, startedAt);

      try {
        const reachedRunning = await waitFor(() => {
          const rows = allRows<LiveWorkerRow>(
            root,
            `SELECT a.id AS attempt_id, w.pid AS pid, w.pgid AS pgid
             FROM attempts a JOIN workers w ON w.attempt_id = a.id
             WHERE a.run_id = ? AND a.stage_id = 'implement' AND a.status = 'running' AND w.termination_state IS NULL`,
            runId,
          );
          return rows.length > 0;
        }, IMPLEMENT_RUNNING_TIMEOUT_MS, 200);

        if (!reachedRunning) {
          throw new Error(
            `live-runner-restart (${vendor}): no attempt reached stage_id "implement" status "running" with a live worker; runId ${runId}; ${diagnostics(root, runId)}`,
          );
        }

        const liveWorker = allRows<LiveWorkerRow>(
          root,
          `SELECT a.id AS attempt_id, w.pid AS pid, w.pgid AS pgid
           FROM attempts a JOIN workers w ON w.attempt_id = a.id
           WHERE a.run_id = ? AND a.stage_id = 'implement' AND a.status = 'running' AND w.termination_state IS NULL
           ORDER BY w.started_at ASC LIMIT 1`,
          runId,
        )[0] as LiveWorkerRow;
        registry.track(liveWorker.pgid);
        const killedAttemptId = liveWorker.attempt_id;

        try {
          process.kill(-firstSupervisorPid, "SIGKILL");
        } catch {
          // already gone
        }
        try {
          process.kill(-liveWorker.pgid, "SIGKILL");
        } catch {
          // already gone
        }

        const supervisorDead = await waitFor(() => !alive(firstSupervisorPid), 5000);
        const workerDead = await waitFor(() => !groupAlive(liveWorker.pgid), 5000);
        if (!supervisorDead || !workerDead) {
          throw new Error(
            `live-runner-restart (${vendor}): SIGKILL did not converge; runId ${runId}; supervisorDead=${supervisorDead} workerDead=${workerDead}; ${diagnostics(root, runId)}`,
          );
        }

        const tooEarly = spawnResumeSupervisor(root, runId);
        if (typeof tooEarly.pid === "number") registry.track(tooEarly.pid);
        const tooEarlyExitCode = await new Promise<number | null>((resolve) => tooEarly.on("exit", resolve));
        assert.equal(
          tooEarlyExitCode,
          4,
          `live-runner-restart (${vendor}): resuming before the killed supervisor's lease is stale must exit 4; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        await sleep(LEASE_STALENESS_WAIT_MS);

        const resumed = spawnResumeSupervisor(root, runId);
        if (typeof resumed.pid === "number") registry.track(resumed.pid);

        const classified = await waitFor(() => {
          const rows = allRows<{ payload: string }>(
            root,
            `SELECT payload FROM events WHERE run_id = ? AND attempt_id = ? AND type = 'reconcile.classified'`,
            runId,
            killedAttemptId,
          );
          return rows.length > 0;
        }, 10000, 200);
        assert.ok(
          classified,
          `live-runner-restart (${vendor}): the resumed supervisor's startup reconciliation must classify the killed worker; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        const classifiedRow = allRows<{ payload: string }>(
          root,
          `SELECT payload FROM events WHERE run_id = ? AND attempt_id = ? AND type = 'reconcile.classified'`,
          runId,
          killedAttemptId,
        )[0] as { payload: string };
        const classifiedPayload = JSON.parse(classifiedRow.payload) as {
          classification: string;
          interruptReason: string | null;
        };
        assert.notEqual(
          classifiedPayload.classification,
          "live",
          `live-runner-restart (${vendor}): a killed worker must never classify "live"; runId ${runId}; ${diagnostics(root, runId)}`,
        );
        assert.equal(
          classifiedPayload.interruptReason,
          "indeterminate",
          `live-runner-restart (${vendor}): a killed mutating attempt must classify interruptReason "indeterminate"; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        const killedAttemptRow = allRows<{ status: string; interrupt_reason: string | null }>(
          root,
          `SELECT status, interrupt_reason FROM attempts WHERE id = ?`,
          killedAttemptId,
        )[0] as { status: string; interrupt_reason: string | null };
        assert.equal(
          killedAttemptRow.status,
          "interrupted",
          `live-runner-restart (${vendor}): the killed attempt's row must land status "interrupted"; runId ${runId}; ${diagnostics(root, runId)}`,
        );
        assert.equal(
          killedAttemptRow.interrupt_reason,
          "indeterminate",
          `live-runner-restart (${vendor}): the killed attempt's row must land interrupt_reason "indeterminate"; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        const reachedTerminal = await waitFor(() => {
          const run = readRunRow(root, runId);
          return ["succeeded", "failed", "blocked", "cancelled"].includes(run.state as string);
        }, RUN_TERMINAL_TIMEOUT_MS, 500);
        const finalRun = readRunRow(root, runId);
        assert.ok(
          reachedTerminal,
          `live-runner-restart (${vendor}): the run must reach a terminal state under the resumed supervisor; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        const allAttempts = allRows<{
          id: string;
          task_id: string;
          stage_id: string;
          round: number;
          input_version: string;
          status: string;
        }>(
          root,
          `SELECT id, task_id, stage_id, round, input_version, status FROM attempts WHERE run_id = ?`,
          runId,
        );
        const tupleKeys = allAttempts.map((a) => `${a.task_id}::${a.stage_id}::${a.round}::${a.input_version}`);
        assert.equal(
          new Set(tupleKeys).size,
          tupleKeys.length,
          `live-runner-restart (${vendor}): every (task_id, stage_id, round, input_version) tuple must be distinct; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        const implementAttempts = allAttempts.filter((a) => a.stage_id === "implement");
        const notInterrupted = implementAttempts.filter((a) => a.status !== "interrupted");
        assert.ok(
          notInterrupted.length <= 1,
          `live-runner-restart (${vendor}): at most one attempt at the killed stage may be non-interrupted; runId ${runId}; ${diagnostics(root, runId)}`,
        );

        const normalizedEvents = allRows<{ attempt_id: string; payload: string }>(
          root,
          `SELECT attempt_id, payload FROM events WHERE run_id = ? AND type = 'attempt.normalized'`,
          runId,
        );
        const claimViolationAttemptIds = new Set(
          allRows<{ attempt_id: string }>(
            root,
            `SELECT attempt_id FROM events WHERE run_id = ? AND type = 'attempt.claim-violation'`,
            runId,
          ).map((row) => row.attempt_id),
        );
        const everCompletedAttemptIds = normalizedEvents
          .filter((row) => {
            const payload = JSON.parse(row.payload) as { ok: boolean };
            return payload.ok && !claimViolationAttemptIds.has(row.attempt_id);
          })
          .map((row) => row.attempt_id);
        const statusById = new Map(allAttempts.map((a) => [a.id, a.status]));
        for (const attemptId of everCompletedAttemptIds) {
          assert.notEqual(
            statusById.get(attemptId),
            "interrupted",
            `live-runner-restart (${vendor}): attempt ${attemptId} reached completed and must never later be interrupted; runId ${runId}; ${diagnostics(root, runId)}`,
          );
        }

        return {
          skipped: false,
          runId,
          vendor,
          killedAttemptId,
          classification: classifiedPayload.classification,
          interruptReason: classifiedPayload.interruptReason,
          tooEarlyResumeExitCode: tooEarlyExitCode as number,
          finalState: finalRun.state as string,
          implementAttemptCount: implementAttempts.length,
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
