import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url));
const text = fs.readFileSync(WORKFLOW_PATH, "utf8");

test("ci workflow", async (t) => {
  await t.test("carries no secrets. reference", () => {
    assert.ok(!/secrets\./.test(text));
  });

  await t.test("sets no vendor credential environment variable", () => {
    assert.ok(!/\b(ANTHROPIC_API_KEY|CLAUDE_[A-Z0-9_]+|OPENAI_API_KEY|CODEX_[A-Z0-9_]+)\b/.test(text));
  });
});
