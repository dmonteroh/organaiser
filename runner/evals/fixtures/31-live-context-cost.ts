// Live scenario `live-context-cost` (goals spec section 29.10: "Context bytes supplied
// per attempt" and "Time to first normalized event"): seeds one task in a throwaway
// repository, compiles its real `implement`/`implementer` dispatch packet exactly once
// (the same builder and the same string the production scheduler spawns a vendor
// process with), and drives that packet through the real vendor adapter directly —
// `selectAdapter`, not the full board pipeline — measuring the packet's UTF-8 byte
// length and the wall time to the first normalized event the adapter observes. The
// measured process is killed as soon as that first event arrives, or after a 5-minute
// wall budget, whichever comes first: neither metric depends on the attempt reaching a
// candidate report, so this scenario never lets one form.
//
// Opt-in: this runs only when `ORGA_LIVE=1` and the vendor's real readiness probe
// reports the CLI installed and authenticated; otherwise it returns a stated skip reason
// before any vendor process — including the version/auth probe itself — is spawned.
// Targets no production service: Codex is pointed at a local Ollama model server through
// a fixture-owned `CODEX_HOME`, never the operator's real one.
//
// Recorded live evidence: one `claude` invocation and three `codex` invocations on
// 2026-09-09, all reporting both measurements (no timeout, no skip). `claude`
// (`claude-cli 2.1.245`, model `sonnet`): startupContextBytes 9786, firstActionLatencyMs
// 1147. `codex` (`codex-cli 0.46.0` against a local `gpt-oss:20b` Ollama model, three
// invocations, never averaged): startupContextBytes 9786 in all three;
// firstActionLatencyMs 37840, 115517, and 39725 respectively — the third run driven
// through the full `orga eval run`/`orga eval grade` pipeline rather than the fixture
// called directly, confirming `metrics.json` carries both numbers end to end. The wide
// codex spread reflects real local-Ollama response-time variance, not a fixture defect.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initProject } from "../../src/store/init.ts";
import { startRun } from "../../src/engine/supervisor-spawn.ts";
import { buildDispatchPacketInput } from "../../src/compile/dispatch-packet-input.ts";
import { claudeProbeSpec } from "../../src/adapters/claude-adapter.ts";
import { CODEX_VENDOR_PROBE_SPEC } from "../../src/adapters/codex-adapter.ts";
import { probeVendor } from "../../src/adapters/probe.ts";
import { terminateGroups } from "../../src/engine/termination.ts";
import { groupAlive } from "../../src/adapters/process-group.ts";
import { selectAdapter } from "../../src/adapters/select.ts";
import { DEFAULT_CANCEL_GRACE_MS } from "../../src/engine/control-commands.ts";
import { resolveVendorProfile } from "../../src/cli/profiles.ts";
import type {
  AttemptDescriptor,
  CapabilityReport,
  ExecutionSurface,
  NormalizedEvent,
  ProcessAdapter,
  ProcessHandle,
} from "../../src/adapters/adapter.ts";
import type { TerminateFn } from "../../src/adapters/vendor-adapter.ts";
import {
  withFixtureWorkspace,
  openStore,
  seedTasks,
  boardWithTasks,
  writeFixtureFiles,
  ProcessRegistry,
  type FixtureTaskSpec,
} from "./harness.ts";

export type LiveVendor = "claude" | "codex";

export type LiveContextCostResult =
  | { skipped: true; reason: string }
  | {
      skipped: false;
      vendor: LiveVendor;
      cliVersion: string | null;
      model: string;
      startupContextBytes: number;
      firstActionLatencyMs: number | null;
    };

const OLLAMA_MODELS_URL = "http://localhost:11434/v1/models";
const CODEX_LIVE_MODEL = "gpt-oss:20b";
const FIRST_EVENT_TIMEOUT_MS = 5 * 60 * 1000;

const CONTEXT_COST_TASK_ID = "context-cost-task";
const CONTEXT_COST_TASK_TITLE = "live-context-cost measurement task";
const CONTEXT_COST_BRIEF_PATH = "brief.md";

function gitCapture(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
}

function createThrowawayRepo(dir: string): void {
  gitCapture(dir, ["init", "-q"]);
  gitCapture(dir, ["config", "commit.gpgsign", "false"]);
  gitCapture(dir, ["config", "user.name", "Live Fixture Operator"]);
  gitCapture(dir, ["config", "user.email", "live-fixture@example.com"]);
  fs.writeFileSync(path.join(dir, ".env"), "APP_API_KEY=fake-not-a-real-credential\n");
  fs.writeFileSync(path.join(dir, "README.md"), "Throwaway repository for live-context-cost. Not a real project.\n");
  gitCapture(dir, ["add", "--", ".env", "README.md"]);
  gitCapture(dir, ["commit", "-q", "-m", "seed"]);
  initProject(dir);
  gitCapture(dir, ["add", "--", "orga.yaml", "orgaw", ".gitignore"]);
  gitCapture(dir, ["commit", "-q", "-m", "init orga project"]);
}

// Arrays are configurable only through project/user YAML files (`profiles.ts`'s own
// design note), so `environmentAllowlist` cannot ride an `ORGA_`-prefixed environment
// variable; this appends the block `resolveVendorProfile` reads for a vendor's default
// capability class to the `orga.yaml` `initProject` already wrote. The built-in default
// allowlist is empty, and the spawned process's environment is built solely from that
// list intersected with the surface's own `environment`, so every vendor branch here
// allowlists at least `HOME` and `PATH`.
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

interface SkipCheck {
  reason: string | null;
  report: CapabilityReport | null;
}

// Probes at most once: the returned `CapabilityReport` (when non-null) is reused for
// the result's `cliVersion` rather than probing a second time.
async function skipReason(vendor: LiveVendor): Promise<SkipCheck> {
  if (process.env.ORGA_LIVE !== "1") return { reason: 'ORGA_LIVE is not set to "1"', report: null };
  if (vendor === "codex") {
    const reason = await ollamaReachable();
    if (reason) return { reason, report: null };
  }
  const spec = vendor === "claude" ? claudeProbeSpec : CODEX_VENDOR_PROBE_SPEC;
  const report = await probeVendor(spec, {
    executablePath: spec.defaultExecutable,
    requestedModel: "default",
    requestedEffort: "default",
    workingDirectory: process.cwd(),
    environment: process.env,
  });
  if (report.executablePath === "unknown") {
    return { reason: `${vendor} CLI is not installed (not found on PATH)`, report };
  }
  if (report.authenticationOutcome !== "authenticated") {
    return { reason: `${vendor} CLI is not authenticated (probe outcome: ${report.authenticationOutcome})`, report };
  }
  return { reason: null, report };
}

// Races the adapter's own unbounded event stream against a wall-clock timer: `observe()`
// has no timeout of its own (it awaits a waiter indefinitely once the process has
// produced nothing and has not finished), so a timed-out wait here must be treated the
// same as "no non-exit event arrived" rather than left to hang.
async function firstNonExitLatencyMs(adapter: ProcessAdapter, handle: ProcessHandle): Promise<number | null> {
  const iterator = adapter.observe(handle)[Symbol.asyncIterator]();
  const deadline = Date.now() + FIRST_EVENT_TIMEOUT_MS;
  const timedOut = Symbol("timed-out");
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    // The losing side of this race is never awaited again, so its own timer must be
    // cleared explicitly here — an uncleared `setTimeout` otherwise keeps the event loop
    // alive for the rest of `remaining`, well after this function has already returned.
    let timer: NodeJS.Timeout;
    const next = await Promise.race([
      iterator.next(),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), remaining);
      }),
    ]);
    clearTimeout(timer!);
    if (next === timedOut) return null;
    const step = next as IteratorResult<NormalizedEvent>;
    if (step.done) return null;
    if (step.value.type !== "exit") {
      return Date.parse(step.value.timestamp) - Date.parse(handle.startedAt);
    }
  }
}

export async function liveContextCost(vendor: LiveVendor): Promise<LiveContextCostResult> {
  const check = await skipReason(vendor);
  if (check.reason) return { skipped: true, reason: check.reason };
  const cliVersion = check.report && check.report.cliVersion !== "unknown" ? check.report.cliVersion : null;

  return withFixtureWorkspace(async (dir) => {
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

    const registry = new ProcessRegistry();

    try {
      const taskSpec: FixtureTaskSpec = {
        id: CONTEXT_COST_TASK_ID,
        title: CONTEXT_COST_TASK_TITLE,
        briefPath: CONTEXT_COST_BRIEF_PATH,
      };
      const { boardPath, workflowPath, templatePath } = writeFixtureFiles(root, [taskSpec]);
      const board = boardWithTasks([taskSpec]);
      const { runId } = startRun({ root, boardPath, board, workflowPath, templatePath, spawn: false });
      seedTasks(root, runId, [taskSpec], Date.now());

      // Compiled exactly once: the packet header embeds an attempt-round counter read
      // from the `attempts` table, so a packet recompiled after an attempt row exists is
      // a different string than the one this fixture is about to spawn.
      const db = openStore(root);
      const packet = buildDispatchPacketInput(
        { id: taskSpec.id, title: CONTEXT_COST_TASK_TITLE, briefPath: CONTEXT_COST_BRIEF_PATH },
        { db, runId, projectRoot: root },
      )("implement", "implementer");
      db.close();
      const startupContextBytes = Buffer.byteLength(packet, "utf8");

      const orgaYamlPath = path.join(root, "orga.yaml");
      const project = { path: orgaYamlPath, text: fs.readFileSync(orgaYamlPath, "utf8") };
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...(vendor === "codex"
          ? {
              CODEX_HOME: codexHome as string,
              ORGA_MODEL: CODEX_LIVE_MODEL,
              ORGA_SANDBOX_MODE: "danger-full-access",
              ORGA_EFFORT: "low",
            }
          : {}),
      };
      const profile = resolveVendorProfile("default", { vendor, env, project });
      const surface: ExecutionSurface = {
        workingDirectory: root,
        environment: env,
        sandboxMode: null,
        permissionMode: null,
        allowedTools: [],
        disallowedTools: [],
      };

      const probeSpec = vendor === "claude" ? claudeProbeSpec : CODEX_VENDOR_PROBE_SPEC;

      // Hand-built here because scheduler.ts's own terminator is module-local and
      // `runner/src/` is out of scope for this fixture; same body, same semantics.
      const terminate: TerminateFn = async (info, gracePeriodMs) => {
        const [report] = await terminateGroups([info.pgid], { graceMs: gracePeriodMs });
        const stillAlive = groupAlive(info.pgid);
        return {
          signalSent: report?.signalled ? "SIGTERM" : null,
          exitCode: null,
          killedProcessTree: !stillAlive,
          timedOutWaitingForExit: stillAlive,
        };
      };

      const adapter = selectAdapter(vendor, profile, {
        probe: (configuration) => probeVendor(probeSpec, configuration),
        terminate,
      });

      const descriptor: AttemptDescriptor = {
        attemptId: `${taskSpec.id}:implement:1`,
        runId,
        taskId: taskSpec.id,
        stageId: "implement",
        roleId: "implementer",
        timeoutBudget: profile.timeouts,
      };

      const handle = await adapter.start(descriptor, packet, surface);
      registry.track(handle.pgid);

      let firstActionLatencyMs: number | null;
      try {
        firstActionLatencyMs = await firstNonExitLatencyMs(adapter, handle);
      } finally {
        // `collect` awaits the attempt's own completion, which hangs forever against a
        // still-live process; cancel must run first regardless of which branch above ran.
        await adapter.cancel(handle, DEFAULT_CANCEL_GRACE_MS);
        await adapter.collect(handle);
      }

      return {
        skipped: false,
        vendor,
        cliVersion,
        model: profile.model,
        startupContextBytes,
        firstActionLatencyMs,
      };
    } finally {
      registry.killAll();
      await registry.allDead();
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
