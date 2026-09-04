#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { main as dispatch, processIo, type Io } from "../src/cli/commands.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    io.stdout(pkg.version);
    return 0;
  }
  return dispatch(argv, io);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`orga: unexpected error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(4);
    },
  );
}
