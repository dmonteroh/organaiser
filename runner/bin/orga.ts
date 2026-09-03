#!/usr/bin/env node
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  process.stderr.write("usage: orga --version\n");
  return 2;
}

process.exit(main(process.argv));
