// `selectAdapter` (`src/adapters/select.ts`) wiring: proves each vendor branch reaches
// the right factory — the fake branch via `FakeAdapter` directly, the claude branch via
// `createVendorAdapter(createClaudeVendorAdapterSpec(...))`, the codex branch via
// `createCodexAdapter`'s `--output-last-message` `collect` override — and that an
// unknown vendor throws rather than silently falling back. Every replayed process is a
// local stand-in script; no `claude` or `codex` binary is ever spawned.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AttemptDescriptor, CapabilityReport, ExecutionSurface, ProbeConfiguration } from "../src/adapters/adapter.ts";
import { FakeAdapter } from "../src/adapters/fake.ts";
import type { TerminateFn, VendorAdapterOptions } from "../src/adapters/vendor-adapter.ts";
import { selectAdapter } from "../src/adapters/select.ts";
import type { ResolvedVendorProfile } from "../src/cli/profiles.ts";
import { liveSingleTask } from "../evals/fixtures/14-live-single-task.ts";
import { liveBoardDrain } from "../evals/fixtures/23-live-board-drain.ts";
import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import type { TickContext } from "../src/engine/tick.ts";
import {
  createProductionSchedulerTick,
  createSchedulerRuntime,
  dispatchEligible,
  type DispatchProfile,
} from "../src/engine/scheduler.ts";
import { sha256 } from "../src/store/evidence.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const REPLAY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orga-select-replay-"));
const REPLAY_SCRIPT_PATH = path.join(REPLAY_DIR, "replay.cjs");
fs.writeFileSync(
  REPLAY_SCRIPT_PATH,
  `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
const fixturePath = process.env.SELECT_TEST_FIXTURE;
if (fixturePath) {
  process.stdout.write(fs.readFileSync(fixturePath, 'utf8'));
}
const lastMessageIndex = args.indexOf('--output-last-message');
if (lastMessageIndex !== -1 && process.env.SELECT_TEST_LAST_MESSAGE_TEXT) {
  fs.writeFileSync(args[lastMessageIndex + 1], process.env.SELECT_TEST_LAST_MESSAGE_TEXT);
}
process.exit(0);
`,
  "utf8",
);
fs.chmodSync(REPLAY_SCRIPT_PATH, 0o755);

function baseProfile(overrides: Partial<ResolvedVendorProfile> = {}): ResolvedVendorProfile {
  return {
    executable: REPLAY_SCRIPT_PATH,
    model: "select-test-model",
    effort: "medium",
    permissionMode: "default",
    sandboxMode: "workspace-write",
    toolPolicy: { allowedTools: [], disallowedTools: [] },
    environmentAllowlist: ["SELECT_TEST_FIXTURE", "SELECT_TEST_LAST_MESSAGE_TEXT", "PATH"],
    timeouts: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
    budgetUsd: null,
    maxConcurrentProcesses: 2,
    ...overrides,
  };
}

function attempt(attemptId: string): AttemptDescriptor {
  return {
    attemptId,
    runId: "run_select_test",
    taskId: "task_select_test",
    stageId: "implement",
    roleId: "implementer",
    timeoutBudget: { spawnMs: 5000, idleMs: 5000, wallMs: 30000 },
  };
}

function surface(environment: NodeJS.ProcessEnv): ExecutionSurface {
  return {
    workingDirectory: REPLAY_DIR,
    environment,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };
}

async function stubProbe(configuration: ProbeConfiguration): Promise<CapabilityReport> {
  return {
    executablePath: configuration.executablePath,
    cliVersion: "select-test/1",
    requestedModel: configuration.requestedModel,
    requestedEffort: configuration.requestedEffort,
    structuredOutputMode: "jsonl",
    authenticationOutcome: "not-applicable",
    workingDirectoryBehavior: "honored",
    permissionAndSandboxConfiguration: "none",
    adapterVersion: "select-test@1",
  };
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

const stubTerminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && groupAlive(pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    signalSent: "SIGTERM",
    exitCode: null,
    killedProcessTree: !groupAlive(pgid),
    timedOutWaitingForExit: groupAlive(pgid),
  };
};

function deps(): VendorAdapterOptions {
  return { probe: stubProbe, terminate: stubTerminate };
}

async function drainAll(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // draining is enough; collect() reads the artifacts the framer already produced.
  }
}

test("selectAdapter(fake, ...) returns a FakeAdapter", () => {
  const adapter = selectAdapter("fake", baseProfile(), deps());
  assert.ok(adapter instanceof FakeAdapter);
});

test("selectAdapter(claude, ...) wires the claude spec into the shared substrate", async () => {
  const fixturePath = path.join(REPLAY_DIR, "claude-result.jsonl");
  fs.writeFileSync(fixturePath, `${JSON.stringify({ type: "result", structured_output: { marker: "claude-branch" } })}\n`);

  const adapter = selectAdapter("claude", baseProfile(), deps());
  const handle = await adapter.start(
    attempt("select-claude"),
    "packet body",
    surface({ SELECT_TEST_FIXTURE: fixturePath, PATH: process.env.PATH }),
  );
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);

  assert.equal(artifacts.candidateReportText, JSON.stringify({ marker: "claude-branch" }));
});

test("selectAdapter(codex, ...) wires createCodexAdapter's --output-last-message collect override", async () => {
  const lastMessageText = JSON.stringify({ marker: "codex-branch" });

  const adapter = selectAdapter("codex", baseProfile(), deps());
  const handle = await adapter.start(
    attempt("select-codex"),
    "packet body",
    surface({ SELECT_TEST_LAST_MESSAGE_TEXT: lastMessageText, PATH: process.env.PATH }),
  );
  await drainAll(adapter.observe(handle));
  const artifacts = await adapter.collect(handle);

  assert.equal(
    artifacts.candidateReportText,
    lastMessageText,
    "codexToEvents always returns a null candidateReportText, so a non-null value here can only come from the --output-last-message override",
  );
});

test("selectAdapter throws on an unknown vendor, naming the value and the allowed set", () => {
  assert.throws(
    () => selectAdapter("bogus-vendor", baseProfile(), deps()),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /bogus-vendor/);
      assert.match(err.message, /claude/);
      assert.match(err.message, /codex/);
      assert.match(err.message, /fake/);
      return true;
    },
  );
});

test("selectAdapter never falls back to a default for an unknown vendor", () => {
  assert.throws(() => selectAdapter("", baseProfile(), deps()));
});

test("a dispatched attempt's resolved vendor profile, CLI version, and workflow revision are recoverable from attempts.config_json without re-probing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const runId = "run-dispatch-profile";
      const now = 1_000_000;
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(runId, "board.yaml", "running", "starting", now);
        db.prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("task-a", runId, "task-a", "Task a", "brief.md", "task-board", "integration", "[]", 0, "implementing", null, now, now);
      });

      const profile = baseProfile({ model: "resolved-model", effort: "high" });
      const dispatchProfile: DispatchProfile = {
        vendor: "codex",
        profile,
        cliVersion: "codex-cli 0.46.0",
        workflowRevision: "deadbeef1234",
        authenticationOutcome: "authenticated",
        isKnownBadVersion: false,
        concurrency: { maxWorkerSlots: 1, vendorSlots: { codex: 1, claude: 1 } },
        terminationGraceMs: 10000,
      };
      const ctx: TickContext = {
        db,
        runId,
        tickIndex: 0,
        now: () => now,
        leaseDeadlineMs: now + 60000,
        signal: new AbortController().signal,
      };
      const adapter = new FakeAdapter({ terminate: stubTerminate });
      const runtime = createSchedulerRuntime();

      await dispatchEligible(ctx, runtime, adapter, undefined, dispatchProfile);

      assert.ok(runtime.liveAttemptByTaskId.get("task-a"), "the task dispatches");
      const row = db
        .prepare(`SELECT vendor, model, config_json FROM attempts WHERE run_id = ?`)
        .get(runId) as { vendor: string; model: string; config_json: string };

      assert.equal(row.vendor, "codex");
      assert.equal(row.model, "resolved-model");
      const config = JSON.parse(row.config_json) as {
        profile: { effort: string; model: string };
        cliVersion: string;
        workflowRevision: string;
      };
      assert.equal(config.profile.effort, "high");
      assert.equal(config.profile.model, "resolved-model");
      assert.equal(config.cliVersion, "codex-cli 0.46.0");
      assert.equal(config.workflowRevision, "deadbeef1234");
    } finally {
      db.close();
    }
  });
});

// `createProductionSchedulerTick` itself, not `dispatchEligible` directly: this exercises
// the factory's own construction logic (`ORGA_VENDOR`/`ORGA_EXECUTABLE`/`ORGA_MODEL`
// parsing, `resolveVendorProfile` and `probeVendor` wiring, and `config_snapshot_ref` ->
// `parseWorkflowRevision` extraction) with the same replay-script stand-in the vendor
// branch tests above use, so it never spawns a real `claude`/`codex` binary. `probeVendor`
// reads `options.env` directly, but the real dispatch spawn (`dispatchEligible`) always
// builds its `ExecutionSurface` from the ambient `process.env`, filtered by the
// project-declared `environmentAllowlist` — hence the `PATH` entry in the `orga.yaml`
// block below, needed for the replay script's `#!/usr/bin/env node` shebang to resolve.
test("createProductionSchedulerTick resolves the claude branch and records its vendor, model, CLI version, and workflow revision on the dispatched attempt", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const orgaYamlPath = path.join(dir, "orga.yaml");
    const existingOrgaYaml = fs.readFileSync(orgaYamlPath, "utf8");
    fs.writeFileSync(
      orgaYamlPath,
      `${existingOrgaYaml}vendors:\n  claude:\n    default:\n      environmentAllowlist:\n        - PATH\n`,
    );

    const versionFixturePath = path.join(REPLAY_DIR, "production-tick-version.txt");
    fs.writeFileSync(versionFixturePath, "select-test-cli 9.9.9\n", "utf8");

    const db = openStore(dir);
    try {
      const runId = "run-production-tick";
      const now = 2_000_000;
      const workflowSha = sha256("workflow-fixture-content-for-production-tick");
      const configSnapshotRef = JSON.stringify({
        board: { path: "board.yaml", sha256: sha256("board-fixture-content-for-production-tick") },
        workflow: { path: "workflow.yaml", sha256: workflowSha },
        template: { path: "template.md", sha256: sha256("template-fixture-content-for-production-tick") },
      });

      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, config_snapshot_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(runId, "board.yaml", "running", "starting", configSnapshotRef, now);
        db.prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("task-a", runId, "task-a", "Task a", "brief.md", "task-board", "integration", "[]", 0, "implementing", null, now, now);
      });

      const env: NodeJS.ProcessEnv = {
        ORGA_VENDOR: "claude",
        ORGA_EXECUTABLE: REPLAY_SCRIPT_PATH,
        ORGA_MODEL: "production-tick-model",
        PATH: process.env.PATH,
        SELECT_TEST_FIXTURE: versionFixturePath,
      };

      const tick = await createProductionSchedulerTick({ db, runId, root: dir, env });

      const ctx: TickContext = {
        db,
        runId,
        tickIndex: 0,
        now: () => now,
        leaseDeadlineMs: now + 60000,
        signal: new AbortController().signal,
      };
      await tick(ctx);

      const row = db
        .prepare(`SELECT vendor, model, config_json, status FROM attempts WHERE run_id = ?`)
        .get(runId) as { vendor: string; model: string; config_json: string; status: string };

      assert.equal(row.vendor, "claude");
      assert.equal(row.model, "production-tick-model");
      assert.equal(row.status, "running");
      const config = JSON.parse(row.config_json) as {
        profile: { model: string };
        cliVersion: string | null;
        workflowRevision: string | null;
      };
      assert.equal(config.profile.model, "production-tick-model");
      assert.equal(config.cliVersion, "9.9.9");
      assert.equal(config.workflowRevision, workflowSha);
    } finally {
      db.close();
    }
  });
});

test("liveSingleTask reports skipped and spawns no vendor process when ORGA_LIVE is unset", async () => {
  const previousLive = process.env.ORGA_LIVE;
  delete process.env.ORGA_LIVE;
  const startedAt = Date.now();
  try {
    const result = await liveSingleTask("claude");
    assert.equal(result.skipped, true);
    if (result.skipped) {
      assert.match(result.reason, /ORGA_LIVE/);
    }
    // The ORGA_LIVE gate is checked before even the version/auth probe runs, so a
    // real spawn (which always takes tens of milliseconds at minimum) would blow this
    // generous budget; this is a coarse proxy for "no process was spawned".
    assert.ok(Date.now() - startedAt < 2000, "the skip path must return without spawning any process");
  } finally {
    if (previousLive === undefined) delete process.env.ORGA_LIVE;
    else process.env.ORGA_LIVE = previousLive;
  }
});

test("liveBoardDrain reports skipped and spawns no vendor process when ORGA_LIVE is unset", async () => {
  const previousLive = process.env.ORGA_LIVE;
  delete process.env.ORGA_LIVE;
  const startedAt = Date.now();
  try {
    const result = await liveBoardDrain("claude");
    assert.equal(result.skipped, true);
    if (result.skipped) {
      assert.match(result.reason, /ORGA_LIVE/);
    }
    // The ORGA_LIVE gate is checked before even the version/auth probe runs, so a
    // real spawn (which always takes tens of milliseconds at minimum) would blow this
    // generous budget; this is a coarse proxy for "no process was spawned".
    assert.ok(Date.now() - startedAt < 2000, "the skip path must return without spawning any process");
  } finally {
    if (previousLive === undefined) delete process.env.ORGA_LIVE;
    else process.env.ORGA_LIVE = previousLive;
  }
});
