import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const ORGA_BIN_PATH = fileURLToPath(new URL("../bin/orga.ts", import.meta.url));

const STATE_DB = "state.sqlite";
const PINNED_VERSION = "9.9.9";
const STUB_EXIT_CODE = 66;

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runOrga(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync(process.execPath, [ORGA_BIN_PATH, ...args], {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

function markAsProjectRoot(dir: string, version: string = PINNED_VERSION): void {
  fs.writeFileSync(
    path.join(dir, "orga.yaml"),
    `runner:\n  version: "${version}"\n  url: "https://example.invalid/runner.tgz"\n  checksum: ""\n`,
  );
  fs.mkdirSync(path.join(dir, ".orga"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".orga", STATE_DB), "");
}

function pinnedRunnerBinPath(dir: string, version: string = PINNED_VERSION): string {
  return path.join(dir, ".orga", "runner", version, "bin", "orga.ts");
}

function writeStubRunner(dir: string, version: string = PINNED_VERSION): void {
  const target = pinnedRunnerBinPath(dir, version);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    [
      "const payload = JSON.stringify({",
      "  argv: process.argv.slice(2),",
      "  delegated: process.env.ORGA_DELEGATED ?? null,",
      "});",
      "process.stdout.write(payload + \"\\n\");",
      `process.exit(${STUB_EXIT_CODE});`,
      "",
    ].join("\n"),
  );
}

function writeSelfSignalingRunner(dir: string, version: string = PINNED_VERSION): void {
  const target = pinnedRunnerBinPath(dir, version);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'process.kill(process.pid, "SIGTERM");\n');
}

test("maps a pinned runner that dies by signal to the outer STATE_CONFLICT exit code", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeSelfSignalingRunner(dir);

    const result = runOrga(["run", "status", "abc"], dir);

    assert.equal(result.signal, null, `outer process itself should exit normally; stderr: ${result.stderr}`);
    assert.equal(result.status, EXIT_CODES.STATE_CONFLICT, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /orga: pinned runner terminated by signal SIGTERM/);
  });
});

test("delegates to the pinned runner, propagating argv, the delegation marker, and the exit code", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeStubRunner(dir);

    const result = runOrga(["run", "status", "abc"], dir);

    assert.equal(result.status, STUB_EXIT_CODE, `stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop() as string) as {
      argv: string[];
      delegated: string | null;
    };
    assert.deepEqual(payload.argv, ["run", "status", "abc"]);
    assert.equal(payload.delegated, "1");
  });
});

test("does not re-exec when ORGA_DELEGATED is already set", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeStubRunner(dir);

    const result = runOrga(["not-a-real-command"], dir, { ...process.env, ORGA_DELEGATED: "1" });

    assert.equal(result.status, EXIT_CODES.INVALID_ARGS, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /"delegated"/);
  });
});

test("does not re-exec when the pinned target's realpath equals the running entry's", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    const target = pinnedRunnerBinPath(dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(ORGA_BIN_PATH, target);

    const result = runOrga(["not-a-real-command"], dir);

    assert.equal(result.signal, null);
    assert.equal(result.status, EXIT_CODES.INVALID_ARGS, `stderr: ${result.stderr}`);
  });
});

test("isMainModule() runs main() when invoked through a symlinked entry point from a non-realpath-clean location", () => {
  // Deliberately not withTempWorkspace: it calls fs.realpath on its own
  // mkdtemp root, which would defeat this repro (the bug requires
  // process.argv[1] to differ, by symlink, from import.meta.url's
  // realpath-resolved value).
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orga-bin-symlink-"));
  try {
    const symlinkedEntry = path.join(symlinkRoot, "orga-entry.ts");
    fs.symlinkSync(ORGA_BIN_PATH, symlinkedEntry);

    const result = spawnSync(process.execPath, [symlinkedEntry, "--version"], {
      cwd: symlinkRoot,
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(result.signal, null, `stderr: ${result.stderr}`);
    assert.equal(result.status, EXIT_CODES.OK, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.trim().length > 0,
      `expected real, non-empty stdout from the symlinked entry point (a pre-fix isMainModule() would silently no-op with empty stdout and exit 0); got: ${JSON.stringify(result.stdout)}`,
    );
  } finally {
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
  }
});

test("never delegates `init`, even when an eligible pinned runner is present in an ancestor", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeStubRunner(dir);
    const subDir = path.join(dir, "sub");
    fs.mkdirSync(subDir);

    const result = runOrga(["init"], subDir);

    assert.equal(result.status, EXIT_CODES.OK, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /"delegated"/);
    assert.ok(fs.existsSync(path.join(subDir, "orga.yaml")));
  });
});

test("never delegates a first-position-only --help or -h", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeStubRunner(dir);

    for (const flag of ["--help", "-h"]) {
      const result = runOrga([flag], dir);
      assert.equal(result.status, EXIT_CODES.INVALID_ARGS, `${flag} stderr: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /"delegated"/);
    }
  });
});

test("delegates --help when it is not the sole argument", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeStubRunner(dir);

    const result = runOrga(["run", "status", "--help"], dir);

    assert.equal(result.status, STUB_EXIT_CODE, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /"delegated":"1"/);
  });
});

test("delegates --version like any other argv, and only prints its own version otherwise", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);
    writeStubRunner(dir);

    const delegated = runOrga(["--version"], dir);
    assert.equal(delegated.status, STUB_EXIT_CODE, `stderr: ${delegated.stderr}`);
    assert.match(delegated.stdout, /"delegated":"1"/);
  });

  await withTempWorkspace((dir) => {
    const result = runOrga(["--version"], dir);
    assert.equal(result.status, EXIT_CODES.OK, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.trim().length > 0);
    assert.doesNotMatch(result.stdout, /"delegated"/);
  });
});

test("falls through to the running binary when the pinned runner entry is absent", async () => {
  await withTempWorkspace((dir) => {
    markAsProjectRoot(dir);

    const result = runOrga(["not-a-real-command"], dir);

    assert.equal(result.status, EXIT_CODES.INVALID_ARGS, `stderr: ${result.stderr}`);
  });
});

test("falls through when runner.version is missing or not a string", async () => {
  await withTempWorkspace((dir) => {
    fs.mkdirSync(path.join(dir, ".orga"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".orga", STATE_DB), "");
    fs.writeFileSync(path.join(dir, "orga.yaml"), "runner:\n  url: \"https://example.invalid\"\n");

    const result = runOrga(["not-a-real-command"], dir);

    assert.equal(result.status, EXIT_CODES.INVALID_ARGS, `stderr: ${result.stderr}`);
  });
});

test("falls through when orga.yaml cannot be read", async () => {
  await withTempWorkspace((dir) => {
    fs.mkdirSync(path.join(dir, ".orga"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".orga", STATE_DB), "");
    fs.writeFileSync(path.join(dir, "orga.yaml"), "runner: {version: bad-flow-collection}\n");

    const result = runOrga(["not-a-real-command"], dir);

    assert.equal(result.status, EXIT_CODES.INVALID_ARGS, `stderr: ${result.stderr}`);
  });
});

test("reports the discovery error and exits 4 when no project root exists anywhere upward", async () => {
  await withTempWorkspace((dir) => {
    const result = runOrga(["run", "status", "nope"], dir);

    assert.equal(result.status, EXIT_CODES.STATE_CONFLICT, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /no project root found searching upward from/);
    assert.match(result.stderr, /no orga\.yaml was found/);
    assert.equal(fs.existsSync(path.join(dir, ".orga")), false);
  });
});
