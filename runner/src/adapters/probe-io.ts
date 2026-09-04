// The concrete `ProbeIo` wiring: the only module in this directory that touches the
// real filesystem or spawns a real child process on behalf of the readiness probe.
// `probe.ts` depends on this module only through the `ProbeIo` interface and the
// `processProbeIo` value it exports below; it never imports `node:fs`,
// `node:fs/promises`, or `node:child_process` itself.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn as spawnChildProcess } from "node:child_process";

import type { ProbeIo, ProbeSpawnOptions, ProbeSpawnResult } from "./probe.ts";

async function existsOnDisk(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFileText(targetPath: string): Promise<string> {
  return fsp.readFile(targetPath, "utf8");
}

function spawnBounded(command: string, args: readonly string[], options: ProbeSpawnOptions): Promise<ProbeSpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawnChildProcess(command, args, { cwd: options.cwd, env: options.env });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false });
    });
    child.stdin?.end();
  });
}

export const processProbeIo: ProbeIo = {
  exists: existsOnDisk,
  readFile: readFileText,
  spawn: spawnBounded,
};
