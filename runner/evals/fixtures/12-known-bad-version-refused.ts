// Fixture: known-bad-version-refused.
//
// Puts a stub `codex` executable on `PATH` that reports a known-bad version and asserts
// `orga doctor --vendor codex --json` exits 15 with a machine-readable refusal reason
// naming the version; the same stub reporting a version one patch above the known-bad
// entry must exit 0. This proves `orga doctor` actually consults the known-bad list
// rather than only checking binary presence and authentication.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main } from "../../bin/orga.ts";
import type { Io } from "../../src/cli/commands.ts";

const STUB_SOURCE = (version: string): string => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("codex-cli ${version}\\n");
  process.exit(0);
}
if (args[0] === "doctor-auth-probe") {
  process.exit(0);
}
process.exit(1);
`;

function writeCodexStub(dir: string, version: string): void {
  const stubPath = path.join(dir, "codex");
  fs.writeFileSync(stubPath, STUB_SOURCE(version), { mode: 0o755 });
  fs.chmodSync(stubPath, 0o755);
}

function fixtureIo(env: NodeJS.ProcessEnv): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    env,
  };
}

export async function knownBadVersionRefused(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orga-known-bad-"));
  try {
    writeCodexStub(dir, "0.120.2");
    const badIo = fixtureIo({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
    const badExit = await main(["node", "orga", "doctor", "--vendor", "codex", "--json"], badIo);

    assert.equal(badExit, 15, `known-bad version must exit 15; stderr: ${badIo.errLines.join("\n")}`);
    assert.equal(badIo.outLines.length, 1, "doctor --json must emit exactly one JSON line on stdout");
    const badPayload = JSON.parse(badIo.outLines[0] as string) as Array<{ vendor: string; usable: boolean; reason: string }>;
    assert.equal(badPayload.length, 1);
    assert.equal(badPayload[0]?.vendor, "codex");
    assert.equal(badPayload[0]?.usable, false);
    assert.match(badPayload[0]?.reason ?? "", /0\.120\.2/, "refusal reason must name the offending version");

    writeCodexStub(dir, "0.120.3");
    const okIo = fixtureIo({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
    const okExit = await main(["node", "orga", "doctor", "--vendor", "codex", "--json"], okIo);

    assert.equal(okExit, 0, `one patch above a known-bad version must exit 0; stderr: ${okIo.errLines.join("\n")}`);
    const okPayload = JSON.parse(okIo.outLines[0] as string) as Array<{ vendor: string; usable: boolean }>;
    assert.equal(okPayload[0]?.usable, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
