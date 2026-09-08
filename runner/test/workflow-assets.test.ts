import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { resolveWorkflowsRoot } from "../src/workflow-assets.ts";

test("resolveWorkflowsRoot: a dev-shaped tree resolves the catalog two levels above the module", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-assets-dev-"));
  try {
    fs.mkdirSync(path.join(tmpRoot, "workflows", "schemas"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "runner", "src"), { recursive: true });
    const moduleUrl = pathToFileURL(path.join(tmpRoot, "runner", "src", "module.ts")).href;

    const root = resolveWorkflowsRoot(moduleUrl);

    assert.equal(fileURLToPath(root), path.join(tmpRoot, "workflows") + path.sep);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveWorkflowsRoot: a bundled-shaped tree resolves the catalog one level above the module", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-assets-bundled-"));
  try {
    fs.mkdirSync(path.join(tmpRoot, "workflows", "schemas"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "src"), { recursive: true });
    const moduleUrl = pathToFileURL(path.join(tmpRoot, "src", "module.ts")).href;

    const root = resolveWorkflowsRoot(moduleUrl);

    assert.equal(fileURLToPath(root), path.join(tmpRoot, "workflows") + path.sep);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveWorkflowsRoot: neither candidate existing throws an error naming both absolute paths", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-assets-missing-"));
  try {
    fs.mkdirSync(path.join(tmpRoot, "runner", "src"), { recursive: true });
    const moduleUrl = pathToFileURL(path.join(tmpRoot, "runner", "src", "module.ts")).href;
    const bundledCandidate = path.join(tmpRoot, "runner", "workflows") + path.sep;
    const devCandidate = path.join(tmpRoot, "workflows") + path.sep;

    assert.throws(
      () => resolveWorkflowsRoot(moduleUrl),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(bundledCandidate), error.message);
        assert.ok(error.message.includes(devCandidate), error.message);
        return true;
      },
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("no source file resolves the workflow catalog by hardcoded relative path", () => {
  const needle = "../../../workflows";
  for (const root of ["src", "bin"]) {
    const dir = fileURLToPath(new URL(`../${root}/`, import.meta.url));
    for (const relative of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!relative.endsWith(".ts")) continue;
      const full = path.join(dir, relative);
      assert.ok(!fs.readFileSync(full, "utf8").includes(needle), `${full} hardcodes ${needle}`);
    }
  }
});
