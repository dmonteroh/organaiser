import test from "node:test";
import assert from "node:assert/strict";

import { extractClaudeStreamText, extractClaudeResultMeta } from "../src/adapters/claude.ts";

// ── extractClaudeStreamText: reconstruct the final answer from stream-json ─────
test("extractClaudeStreamText: returns the result-event text (where the contract lives)", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working…" }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "DONE\n<<<RALPH_CONTRACT{}RALPH_CONTRACT>>>" }),
  ].join("\n");
  assert.equal(extractClaudeStreamText(stream), "DONE\n<<<RALPH_CONTRACT{}RALPH_CONTRACT>>>");
});

test("extractClaudeStreamText: falls back to concatenated assistant text when reaped before the result event", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "part one" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "part two" }] } }),
  ].join("\n");
  assert.equal(extractClaudeStreamText(stream), "part one\npart two");
});

test("extractClaudeStreamText: passes plain (non-stream-json) text through unchanged", () => {
  const text = "plain orchestrator answer\n<<<RALPH_CONTRACT{}RALPH_CONTRACT>>>";
  assert.equal(extractClaudeStreamText(text), text);
});

test("extractClaudeStreamText: skips malformed lines and tolerates empty input", () => {
  assert.equal(extractClaudeStreamText(""), "");
  const stream = ["{ not valid json", JSON.stringify({ type: "result", result: "ok" })].join("\n");
  assert.equal(extractClaudeStreamText(stream), "ok");
});

// ── extractClaudeResultMeta: attempt economics from the stream-json result event ──
test("extractClaudeResultMeta reads duration/cost/usage from the result event", () => {
  const stream = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
    JSON.stringify({
      type: "result",
      result: "done",
      duration_ms: 614519,
      total_cost_usd: 2.3584005,
      usage: {
        input_tokens: 32,
        output_tokens: 18143,
        cache_read_input_tokens: 1984303,
        cache_creation_input_tokens: 63512,
      },
    }),
  ].join("\n");
  const meta = extractClaudeResultMeta(stream);
  assert.equal(meta?.durationMs, 614519);
  assert.equal(meta?.costUsd, 2.3584005);
  assert.equal(meta?.inputTokens, 32);
  assert.equal(meta?.outputTokens, 18143);
  assert.equal(meta?.cacheReadInputTokens, 1984303);
  assert.equal(meta?.cacheCreationInputTokens, 63512);
});

test("extractClaudeResultMeta returns null when there is no result event (reap / text / codex)", () => {
  assert.equal(extractClaudeResultMeta(""), null);
  assert.equal(extractClaudeResultMeta("plain text final answer"), null);
  const reaped = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "was working…" }] } }),
  ].join("\n");
  assert.equal(extractClaudeResultMeta(reaped), null);
  // Malformed lines are skipped, never fatal.
  assert.equal(extractClaudeResultMeta('{"type":"result", broken json'), null);
});
