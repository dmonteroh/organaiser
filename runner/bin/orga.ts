#!/usr/bin/env node
import { readFileSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { main as dispatch, processIo, type Io } from "../src/cli/commands.ts";
import { findProjectRoot, ProjectRootError } from "../src/store/db.ts";
import { readYamlFile, type YamlMapping } from "../src/cli/yaml.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

function pinnedRunnerVersion(root: string): string | undefined {
  let yaml: YamlMapping;
  try {
    yaml = readYamlFile(path.join(root, "orga.yaml"));
  } catch {
    return undefined;
  }
  const runner = yaml.runner;
  if (runner === null || typeof runner !== "object" || Array.isArray(runner)) return undefined;
  const version = runner.version;
  return typeof version === "string" ? version : undefined;
}

function delegate(args: readonly string[], io: Io): number {
  if (io.env.ORGA_DELEGATED === "1") return -1;
  if (args[0] === "init") return -1;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return -1;

  let root: string;
  try {
    root = findProjectRoot(io.cwd());
  } catch (err) {
    if (err instanceof ProjectRootError) return -1;
    throw err;
  }

  const version = pinnedRunnerVersion(root);
  if (version === undefined) return -1;

  const target = path.join(root, ".orga", "runner", version, "bin", "orga.ts");
  if (!existsSync(target)) return -1;

  if (realpathSync(target) === realpathSync(fileURLToPath(import.meta.url))) return -1;

  const result = spawnSync(process.execPath, [target, ...args], {
    stdio: "inherit",
    cwd: io.cwd(),
    env: { ...io.env, ORGA_DELEGATED: "1" },
  });

  if (result.error) {
    io.stderr(`orga: cannot execute pinned runner at ${target}: ${result.error.message}`);
    return 4;
  }
  if (result.status === null) {
    io.stderr(`orga: pinned runner terminated by signal ${result.signal}`);
    return 4;
  }
  return result.status;
}

export async function main(argv: readonly string[], io: Io = processIo): Promise<number> {
  const args = argv.slice(2);

  const delegated = delegate(args, io);
  if (delegated !== -1) return delegated;

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
