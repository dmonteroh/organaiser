import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import type { Io } from "../src/cli/commands.ts";
import { SUITE_NAMES, PROFILE_IDS, buildEvalCatalog, loadRegistry } from "../evals/eval-vocabulary.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function fakeIo(dir: string): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => dir,
    now: () => Date.now(),
    env: {},
  };
}

test("eval list prints a human table naming every suite and every profile, and exits OK", async () => {
  await withTempWorkspace(async (dir) => {
    const io = fakeIo(dir);

    const code = await main(["node", "orga", "eval", "list"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    assert.equal(io.errLines.length, 0);

    const table = io.outLines.join("\n");
    for (const suite of SUITE_NAMES) {
      assert.ok(table.includes(suite), `expected table to mention suite "${suite}"`);
    }
    for (const profile of PROFILE_IDS) {
      assert.ok(table.includes(profile), `expected table to mention profile "${profile}"`);
    }
  });
});

test("eval list --json emits {suites, profiles} matching buildEvalCatalog's output", async () => {
  await withTempWorkspace(async (dir) => {
    const io = fakeIo(dir);

    const code = await main(["node", "orga", "eval", "list", "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    assert.equal(io.outLines.length, 1);

    const parsed = JSON.parse(io.outLines[0] as string) as { suites: unknown; profiles: string[] };
    assert.deepEqual(parsed.suites, buildEvalCatalog(loadRegistry()));
    assert.deepEqual(parsed.profiles, [...PROFILE_IDS]);
  });
});

test("eval list requires no .orga project, no store, and no spawnFn (no credentials, no vendor spawn)", async () => {
  await withTempWorkspace(async (dir) => {
    // A bare temp dir with no `init` run first, and an Io with no `spawnFn` at all.
    const io = fakeIo(dir);
    assert.equal(io.spawnFn, undefined);

    const code = await main(["node", "orga", "eval", "list", "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
  });
});
