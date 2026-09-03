// Claude vendor command construction and stream-json extraction: builds the argv shape
// supervised as { command, args, input, cwd, env } for `superviseProcess`, and reads
// claude's `--output-format stream-json` output back into a final answer plus economics.

import type { VendorProfile, VendorCommand } from "./codex.ts";

// Claude's packet is delivered on stdin (`input`), never in argv, so the packet stays
// out of the process list and off the argument-length ceiling.
export function buildClaudeCommand(
  profile: VendorProfile,
  packet: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): VendorCommand {
  if (profile.runner !== "claude") {
    throw new Error(`unknown vendor: ${profile.runner} (must be claude)`);
  }

  const env = profile.home ? { ...baseEnv, HOME: profile.home } : undefined;

  const args = ["--model", profile.claudeModel, "--effort", profile.claudeEffort];
  // `--output-format stream-json` requires `--verbose` or the CLI errors; keep them
  // pushed together so this pairing cannot drift apart.
  if (profile.claudeStreamJson) {
    args.push("--output-format", "stream-json", "--verbose");
  } else {
    args.push("--output-format", "text");
  }
  args.push("--allowedTools", profile.allowedTools);
  if (profile.claudeBypass) args.push("--dangerously-skip-permissions");

  return { command: "claude", args, input: packet, cwd: profile.workdir, env };
}

// Reconstruct claude's final answer text from `stream-json` output. Under
// `--output-format stream-json --verbose` every stdout line is a JSON event; the
// terminal `result` event's `.result` field is the complete final answer (identical to
// what `--output-format text` prints). If the run was reaped before the `result` event,
// fall back to concatenating the streamed `assistant` text blocks in order. When the
// input has no recognizable stream-json events (plain `text` output, a codex run, or an
// early plain-text error) it is returned unchanged, so this is a safe no-op on every
// non-stream-json path. Never throws: a partial or non-JSON line is skipped, not fatal.
export function extractClaudeStreamText(raw: string): string {
  if (typeof raw !== "string" || raw === "") return raw;
  let sawStreamJson = false;
  let resultText: string | null = null;
  const assistantTexts: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const event = ev as { type?: unknown; result?: unknown; message?: { content?: unknown } };
    if (event.type === "result" && typeof event.result === "string") {
      sawStreamJson = true;
      resultText = event.result;
    } else if (event.type === "assistant" && Array.isArray(event.message?.content)) {
      sawStreamJson = true;
      for (const block of event.message.content as unknown[]) {
        if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
          const text = (block as { text?: unknown }).text;
          if (typeof text === "string") assistantTexts.push(text);
        }
      }
    }
  }
  if (!sawStreamJson) return raw;
  if (resultText !== null) return resultText;
  return assistantTexts.join("\n");
}

export interface ClaudeResultMeta {
  durationMs: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

// Extract the run's economics from claude's `stream-json` output: the terminal `result`
// event carries duration_ms, total_cost_usd, and token usage. Returns a compact meta
// object, or null when there is no result event: a reaped attempt, `text` output, or a
// codex run.
// Observability only: no gate or acceptance decision may consume these numbers.
export function extractClaudeResultMeta(raw: string): ClaudeResultMeta | null {
  if (typeof raw !== "string" || raw === "") return null;
  let meta: ClaudeResultMeta | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed[0] !== "{") continue;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object" || (ev as { type?: unknown }).type !== "result") continue;
    const event = ev as {
      duration_ms?: unknown;
      total_cost_usd?: unknown;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cache_read_input_tokens?: unknown;
        cache_creation_input_tokens?: unknown;
      };
    };
    const usage = event.usage ?? {};
    meta = {
      durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
      costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
      inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      cacheReadInputTokens:
        typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null,
      cacheCreationInputTokens:
        typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : null,
    };
  }
  return meta;
}
