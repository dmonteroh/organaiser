import assert from "node:assert/strict";
import test from "node:test";

import {
  boolFlag,
  enumVal,
  loadConfig,
  nonNegativeInt,
  NO_PROGRESS_SECS_DEFAULT,
  positiveInt,
  stringVal,
  type Layer,
  type Read,
} from "../src/cli/config.ts";
import { DEFAULT_BUDGETS } from "../src/adapters/process-supervisor.ts";
import { DEFAULT_WORKTREE_ROOT, DEFAULT_BRANCH_PREFIX } from "../src/git/workspace.ts";

function readerFor(value: string | undefined): Read {
  return (name: string): string | undefined => (name === "X" ? value : undefined);
}

// ── positiveInt: accept and reject paths ─────────────────────────────────────
test("positiveInt falls back when unset", () => {
  assert.equal(positiveInt(readerFor(undefined), "X", 7), 7);
});

test("positiveInt accepts a positive base-10 integer", () => {
  assert.equal(positiveInt(readerFor("42"), "X", 7), 42);
});

test("positiveInt rejects zero", () => {
  assert.throws(() => positiveInt(readerFor("0"), "X", 7), /invalid X: 0 \(must be an integer > 0\)/);
});

test("positiveInt rejects a non-digit string", () => {
  assert.throws(() => positiveInt(readerFor("abc"), "X", 7), /invalid X: abc \(must be an integer > 0\)/);
});

// ── nonNegativeInt: accept and reject paths ──────────────────────────────────
test("nonNegativeInt falls back when unset", () => {
  assert.equal(nonNegativeInt(readerFor(undefined), "X", 3), 3);
});

test("nonNegativeInt accepts zero", () => {
  assert.equal(nonNegativeInt(readerFor("0"), "X", 3), 0);
});

test("nonNegativeInt rejects a non-digit string", () => {
  assert.throws(() => nonNegativeInt(readerFor("abc"), "X", 3), /invalid X: abc \(must be an integer >= 0\)/);
});

// ── boolFlag: accept and reject paths ────────────────────────────────────────
test("boolFlag falls back when unset", () => {
  assert.equal(boolFlag(readerFor(undefined), "X", false), false);
});

for (const truthy of ["1", "true", "yes", "y", "on"]) {
  test(`boolFlag accepts ${truthy} as true`, () => {
    assert.equal(boolFlag(readerFor(truthy), "X", false), true);
  });
}

for (const falsy of ["0", "false", "no", "n", "off"]) {
  test(`boolFlag accepts ${falsy} as false`, () => {
    assert.equal(boolFlag(readerFor(falsy), "X", true), false);
  });
}

test("boolFlag rejects a non-boolean string", () => {
  assert.throws(() => boolFlag(readerFor("maybe"), "X", false), /invalid X: maybe \(must be a boolean flag\)/);
});

// ── stringVal: accept and reject (fallback) paths ────────────────────────────
test("stringVal falls back when unset", () => {
  assert.equal(stringVal(readerFor(undefined), "X", "default"), "default");
});

test("stringVal passes the raw value through untrimmed", () => {
  assert.equal(stringVal(readerFor("  spaced  "), "X", "default"), "  spaced  ");
});

// ── enumVal: accept and reject paths ─────────────────────────────────────────
test("enumVal falls back when unset", () => {
  assert.equal(enumVal(readerFor(undefined), "X", ["a", "b"], "a"), "a");
});

test("enumVal accepts a listed value", () => {
  assert.equal(enumVal(readerFor("b"), "X", ["a", "b"], "a"), "b");
});

test("enumVal rejects a value outside the allowed list", () => {
  assert.throws(() => enumVal(readerFor("c"), "X", ["a", "b"], "a"), /invalid X: c \(must be one of a\|b\)/);
});

// ── loadConfig: exports, defaults, and freezing ──────────────────────────────
test("loadConfig with no sources resolves defaults and reads no file path it was not given", () => {
  const config = loadConfig();
  assert.equal(config.runner, "codex");
  assert.deepEqual(config.budgets, DEFAULT_BUDGETS);
  assert.equal(config.budgets.HARD_CEILING_SECS, 2400);
  assert.equal(config.budgets.NO_PROGRESS_SECS, NO_PROGRESS_SECS_DEFAULT);
});

test("loadConfig returns a frozen object", () => {
  const config = loadConfig();
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.budgets), true);
});

// ── loadConfig: precedence, one case per layer boundary ──────────────────────
test("environment overrides both file layers (env/user boundary)", () => {
  const project: Layer = { POLL_SECS: "10" };
  const user: Layer = { POLL_SECS: "20" };
  const env: Layer = { ORGA_POLL_SECS: "30" };
  assert.equal(loadConfig({ project, user, env }).budgets.POLL_SECS, 30);
});

test("the user file overrides the project file when the environment is silent (user/project boundary)", () => {
  const project: Layer = { POLL_SECS: "10" };
  const user: Layer = { POLL_SECS: "20" };
  assert.equal(loadConfig({ project, user }).budgets.POLL_SECS, 20);
});

test("an unset or empty value at a higher layer falls back to the next layer", () => {
  const project: Layer = { POLL_SECS: "10" };
  const user: Layer = { POLL_SECS: "" };
  const env: Layer = { ORGA_POLL_SECS: "" };
  assert.equal(loadConfig({ project, user, env }).budgets.POLL_SECS, 10);
});

test("an invalid value at the winning layer is an error, never a fallback to the next layer", () => {
  const project: Layer = { POLL_SECS: "10" };
  const env: Layer = { ORGA_POLL_SECS: "not-a-number" };
  assert.throws(() => loadConfig({ project, env }), /invalid POLL_SECS: not-a-number/);
});

// ── loadConfig: aggregated-error naming more than one problem at once ────────
test("loadConfig aggregates every invalid value into one thrown error", () => {
  const env: Layer = { ORGA_RUNNER: "gemini", ORGA_POLL_SECS: "not-a-number" };
  assert.throws(() => loadConfig({ env }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /invalid RUNNER: gemini \(must be one of codex\|claude\)/);
    assert.match(err.message, /invalid POLL_SECS: not-a-number \(must be an integer > 0\)/);
    return true;
  });
});

// ── loadConfig.runner: watchdog budgets default from DEFAULT_BUDGETS ─────────
test("loadConfig.budgets defaults every field from DEFAULT_BUDGETS", () => {
  const config = loadConfig();
  assert.equal(config.budgets.POLL_SECS, DEFAULT_BUDGETS.POLL_SECS);
  assert.equal(config.budgets.GRACE_SECS, DEFAULT_BUDGETS.GRACE_SECS);
  assert.equal(config.budgets.HARD_CEILING_SECS, DEFAULT_BUDGETS.HARD_CEILING_SECS);
});

test("loadConfig fails loudly on an invalid RUNNER", () => {
  assert.throws(
    () => loadConfig({ env: { ORGA_RUNNER: "gemini" } }),
    /invalid RUNNER: gemini \(must be one of codex\|claude\)/,
  );
});

// ── loadConfig.workspace: defaults, env overrides, and freezing ──────────────
test("loadConfig.workspace defaults to workspace.ts's exported constants when unset", () => {
  const config = loadConfig();
  assert.equal(config.workspace.root, DEFAULT_WORKTREE_ROOT);
  assert.equal(config.workspace.branchPrefix, DEFAULT_BRANCH_PREFIX);
});

test("ORGA_WORKTREE_ROOT in the env layer overrides the default worktree root", () => {
  const env: Layer = { ORGA_WORKTREE_ROOT: "custom/worktrees" };
  assert.equal(loadConfig({ env }).workspace.root, "custom/worktrees");
});

test("ORGA_BRANCH_PREFIX in the env layer overrides the default branch prefix", () => {
  const env: Layer = { ORGA_BRANCH_PREFIX: "custom/prefix/" };
  assert.equal(loadConfig({ env }).workspace.branchPrefix, "custom/prefix/");
});

test("loadConfig freezes config.workspace", () => {
  const config = loadConfig();
  assert.equal(Object.isFrozen(config.workspace), true);
});

// ── loadConfig.workspace.mode: default, env override, and aggregated error ──
test("loadConfig.workspace.mode defaults to worktree when unset", () => {
  const config = loadConfig();
  assert.equal(config.workspace.mode, "worktree");
});

test("ORGA_WORKSPACE_MODE in the env layer overrides the default workspace mode", () => {
  const env: Layer = { ORGA_WORKSPACE_MODE: "in-place" };
  assert.equal(loadConfig({ env }).workspace.mode, "in-place");
});

test("loadConfig aggregates an invalid ORGA_WORKSPACE_MODE into the aggregated error", () => {
  const env: Layer = { ORGA_WORKSPACE_MODE: "bogus" };
  assert.throws(
    () => loadConfig({ env }),
    /invalid WORKSPACE_MODE: bogus \(must be one of worktree\|in-place\)/,
  );
});

// ── loadConfig.concurrency: defaults of 1, env overrides, and freezing ──────
test("loadConfig.concurrency defaults maxWorkerSlots and both vendorSlots to 1 when unset", () => {
  const config = loadConfig();
  assert.equal(config.concurrency.maxWorkerSlots, 1);
  assert.equal(config.concurrency.vendorSlots.codex, 1);
  assert.equal(config.concurrency.vendorSlots.claude, 1);
});

test("ORGA_MAX_WORKER_SLOTS in the env layer overrides the default max worker slots", () => {
  const env: Layer = { ORGA_MAX_WORKER_SLOTS: "4" };
  assert.equal(loadConfig({ env }).concurrency.maxWorkerSlots, 4);
});

test("ORGA_VENDOR_SLOTS_CODEX and ORGA_VENDOR_SLOTS_CLAUDE in the env layer override their respective defaults independently", () => {
  const env: Layer = { ORGA_VENDOR_SLOTS_CODEX: "3", ORGA_VENDOR_SLOTS_CLAUDE: "2" };
  const config = loadConfig({ env });
  assert.equal(config.concurrency.vendorSlots.codex, 3);
  assert.equal(config.concurrency.vendorSlots.claude, 2);
});

test("loadConfig aggregates an invalid ORGA_MAX_WORKER_SLOTS into the aggregated error", () => {
  const env: Layer = { ORGA_MAX_WORKER_SLOTS: "0" };
  assert.throws(() => loadConfig({ env }), /invalid MAX_WORKER_SLOTS: 0 \(must be an integer > 0\)/);
});

test("loadConfig freezes config.concurrency and its vendorSlots map", () => {
  const config = loadConfig();
  assert.equal(Object.isFrozen(config.concurrency), true);
  assert.equal(Object.isFrozen(config.concurrency.vendorSlots), true);
});
