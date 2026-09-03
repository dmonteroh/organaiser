import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test("the directory exists and is writable inside fn and is gone after", async () => {
  let capturedDir = "";

  await withTempWorkspace((dir) => {
    capturedDir = dir;
    assert.equal(path.isAbsolute(dir), true);
    return fs.writeFile(path.join(dir, "marker.txt"), "hello");
  });

  assert.equal(await exists(capturedDir), false);
});

test("an async fn is awaited to settlement before removal and its resolved value is what withTempWorkspace resolves with", async () => {
  let capturedDir = "";
  let resolvedBeforeReturn = false;

  const result = await withTempWorkspace(async (dir) => {
    capturedDir = dir;
    await new Promise((resolve) => setTimeout(resolve, 10));
    resolvedBeforeReturn = true;
    return "settled-value";
  });

  assert.equal(resolvedBeforeReturn, true);
  assert.equal(result, "settled-value");
  assert.equal(await exists(capturedDir), false);
});

test("a rejecting async fn leaves no directory behind and rethrows the identical error value", async () => {
  let capturedDir = "";
  const thrown = new Error("boom");

  let caught: unknown;
  try {
    await withTempWorkspace(async (dir) => {
      capturedDir = dir;
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw thrown;
    });
  } catch (error) {
    caught = error;
  }

  assert.strictEqual(caught, thrown);
  assert.equal(await exists(capturedDir), false);
});

test("two concurrent withTempWorkspace calls receive different directories and neither removal disturbs the other", async () => {
  const dirs: string[] = [];

  const [resultA, resultB] = await Promise.all([
    withTempWorkspace(async (dir) => {
      dirs.push(dir);
      await fs.writeFile(path.join(dir, "a.txt"), "a");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await exists(path.join(dir, "a.txt")), true);
      return dir;
    }),
    withTempWorkspace(async (dir) => {
      dirs.push(dir);
      await fs.writeFile(path.join(dir, "b.txt"), "b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await exists(path.join(dir, "b.txt")), true);
      return dir;
    }),
  ]);

  assert.notEqual(resultA, resultB);
  assert.equal(await exists(resultA), false);
  assert.equal(await exists(resultB), false);
});
