import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { runReplay } from "../src/reports/run-replay.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import { main } from "../bin/orga.ts";
import type { Io } from "../src/cli/commands.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, "fixtures", "run-replay");
const RUN_ID = "run-fixture";
const KNOWN_TASK_ID = "T-agree";

function fakeIo(): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    env: {},
  };
}

function ioAt(dir: string): Io & { outLines: string[]; errLines: string[] } {
  const io = fakeIo();
  io.cwd = () => dir;
  return io;
}

async function withFixtureCopy<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  return withTempWorkspace((dir) => {
    fs.cpSync(FIXTURE_ROOT, dir, { recursive: true });
    fs.renameSync(path.join(dir, "repo.git"), path.join(dir, ".git"));
    return fn(dir);
  });
}

async function withTwoFixtureCopies<T>(
  fn: (a: string, b: string) => T | Promise<T>,
): Promise<T> {
  return withFixtureCopy((a) => withFixtureCopy((b) => fn(a, b)));
}

test("runReplay returns an explicit exitCode for a diverged task rather than throwing", async () => {
  await withFixtureCopy((root) => {
    let result: ReturnType<typeof runReplay> | undefined;
    assert.doesNotThrow(() => {
      result = runReplay(root, RUN_ID);
    });
    assert.ok(result);
    assert.equal(result.exitCode, EXIT_CODES.STATE_CONFLICT);
    assert.ok(result.report.tasks.some((task) => task.status === "diverged"));
  });
});

test("runReplay is relocatable: two temp copies of the fixture yield deeply equal results", async () => {
  await withTwoFixtureCopies((rootA, rootB) => {
    const resultA = runReplay(rootA, RUN_ID);
    const resultB = runReplay(rootB, RUN_ID);
    assert.deepEqual(resultA, resultB);
  });
});

test("main() wires 'run replay <run-id> --task <id>' without a spurious --task usage error", async () => {
  await withFixtureCopy(async (dir) => {
    const io = ioAt(dir);
    const code = await main(
      ["node", "orga", "run", "replay", RUN_ID, "--task", KNOWN_TASK_ID, "--json"],
      io,
    );
    assert.deepEqual(io.errLines, []);
    assert.equal(code, EXIT_CODES.OK);

    const result = JSON.parse(io.outLines[0] as string) as {
      runId: string;
      tasks: Array<{ taskId: string; status: string }>;
    };
    assert.equal(result.runId, RUN_ID);
    assert.deepEqual(
      result.tasks.map((task) => task.taskId),
      [KNOWN_TASK_ID],
    );
    assert.equal(result.tasks[0]?.status, "agree");
  });
});
