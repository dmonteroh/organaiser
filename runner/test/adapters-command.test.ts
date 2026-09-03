import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexCommand } from "../src/adapters/codex.ts";
import { buildClaudeCommand } from "../src/adapters/claude.ts";
import type { VendorProfile } from "../src/adapters/codex.ts";

function codexProfile(overrides: Partial<VendorProfile> = {}): VendorProfile {
  return {
    runner: "codex",
    codexModel: "gpt-5.4-mini",
    codexEffort: "medium",
    codexBypass: true,
    sandboxMode: "danger-full-access",
    claudeModel: "claude-sonnet-4-6",
    claudeEffort: "medium",
    claudeStreamJson: true,
    claudeBypass: true,
    allowedTools: "Read,Write,Edit,Bash,Glob,Grep",
    workdir: "/repo",
    home: null,
    ...overrides,
  };
}

function claudeProfile(overrides: Partial<VendorProfile> = {}): VendorProfile {
  return codexProfile({ runner: "claude", ...overrides });
}

// ── command building: codex delivers via stdin, claude now also delivers via stdin ──
test("buildCodexCommand: codex reads the packet from stdin (input)", () => {
  const cmd = buildCodexCommand(codexProfile(), "PACKET");
  assert.equal(cmd.command, "codex");
  assert.equal(cmd.input, "PACKET", "codex packet is delivered via stdin");
  assert.deepEqual(cmd.args.slice(0, 2), ["exec", "-m"]);
  assert.ok(cmd.args.includes("gpt-5.4-mini"));
  // Last arg is `-` (read prompt from stdin); sandbox flag present (no bypass).
  assert.equal(cmd.args.at(-1), "-");
  // Bypass defaults ON (v1 parity) so the agent can act non-interactively.
  assert.ok(cmd.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!cmd.args.includes("-s"), "default bypass removes the -s sandbox flag");
  assert.equal(cmd.cwd, "/repo");
});

test("buildCodexCommand: codexBypass=false restores the -s sandbox flag", () => {
  const cmd = buildCodexCommand(codexProfile({ codexBypass: false }), "P");
  assert.ok(!cmd.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(cmd.args.includes("-s"), "with bypass off the sandbox flag returns");
  assert.ok(cmd.args.includes("danger-full-access"));
});

test("buildClaudeCommand: claude carries the packet on stdin, not in argv", () => {
  const cmd = buildClaudeCommand(claudeProfile(), "PACKET");
  assert.equal(cmd.command, "claude");
  assert.equal(cmd.input, "PACKET", "claude packet is delivered via stdin");
  assert.ok(!cmd.args.includes("-p"), "claude no longer takes -p");
  for (const arg of cmd.args) {
    assert.ok(!arg.includes("PACKET"), "the packet must not appear anywhere in args");
  }
  assert.ok(cmd.args.includes("claude-sonnet-4-6"));
  // Default: stream the run's output live as JSON events. stream-json requires --verbose
  // (the CLI errors otherwise).
  const ofIdx = cmd.args.indexOf("--output-format");
  assert.ok(ofIdx >= 0 && cmd.args[ofIdx + 1] === "stream-json", "defaults to stream-json output");
  assert.ok(cmd.args.includes("--verbose"), "stream-json requires --verbose");
});

test("buildClaudeCommand: claudeStreamJson=false restores buffered text output", () => {
  const cmd = buildClaudeCommand(claudeProfile({ claudeStreamJson: false }), "P");
  const ofIdx = cmd.args.indexOf("--output-format");
  assert.ok(ofIdx >= 0 && cmd.args[ofIdx + 1] === "text", "text output when stream-json disabled");
  assert.ok(!cmd.args.includes("--verbose"), "no --verbose without stream-json");
});

test("buildCodexCommand: HOME override is applied to the child env only when set", () => {
  const base = { PATH: "/usr/bin" };
  const noHome = codexProfile({ home: null });
  assert.equal(buildCodexCommand(noHome, "P", base).env, undefined);

  const withHome = codexProfile({ home: "/tmp/h" });
  const cmd = buildCodexCommand(withHome, "P", base);
  assert.equal(cmd.env?.HOME, "/tmp/h");
  assert.equal(cmd.env?.PATH, "/usr/bin", "base env is preserved under the HOME override");
});

test("buildCodexCommand / buildClaudeCommand: an unknown vendor throws (defends the enum)", () => {
  assert.throws(
    () => buildCodexCommand({ ...codexProfile(), runner: "gemini" }, "P"),
    /unknown vendor/,
  );
  assert.throws(
    () => buildClaudeCommand({ ...claudeProfile(), runner: "gemini" }, "P"),
    /unknown vendor/,
  );
  // Neither builder accepts the other vendor's id.
  assert.throws(
    () => buildCodexCommand(claudeProfile(), "P"),
    /unknown vendor/,
    "codex builder must not accept the claude vendor id",
  );
  assert.throws(
    () => buildClaudeCommand(codexProfile(), "P"),
    /unknown vendor/,
    "claude builder must not accept the codex vendor id",
  );
});
