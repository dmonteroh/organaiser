// An incremental line-delimited-JSON framer. Generalizes the house tolerance
// policy in `claude.ts`'s `extractClaudeStreamText`: a partial final line is
// held rather than parsed, a line that is not valid JSON is skipped rather
// than thrown, and an empty line contributes nothing. Nothing here knows
// which vendor produced the bytes.

export interface FramerEndResult {
  /** Whatever bytes remained in the buffer when `end()` was called, unparsed. */
  trailing: string;
  /** True exactly when `trailing` held bytes that never formed a complete line. */
  truncated: boolean;
}

export interface JsonlFramer {
  /** Feeds one chunk of raw bytes and returns the JSON values it completed, in order. */
  push(chunk: string): unknown[];
  /** Closes the stream and reports what, if anything, was left unterminated. */
  end(): FramerEndResult;
}

function parseLine(line: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = line.trim();
  if (trimmed === "") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

export function createJsonlFramer(): JsonlFramer {
  let buffer = "";

  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const values: unknown[] = [];
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const parsed = parseLine(line);
        if (parsed.ok) values.push(parsed.value);
        newlineIndex = buffer.indexOf("\n");
      }
      return values;
    },

    end(): FramerEndResult {
      const trailing = buffer;
      const truncated = buffer.trim() !== "";
      buffer = "";
      return { trailing, truncated };
    },
  };
}
