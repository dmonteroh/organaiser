import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

test("initProject creates orga.yaml, orgaw, and .orga/ with correct modes", async () => {
  await withTempWorkspace(async (dir) => {
    const result = initProject(dir);
    assert.equal(result.root, dir);
    assert.equal(result.created, true);

    assert.equal(fs.existsSync(path.join(dir, "orga.yaml")), true);
    assert.equal(fs.existsSync(path.join(dir, "orgaw")), true);
    assert.equal(fs.existsSync(path.join(dir, ".orga")), true);

    assert.equal(mode(path.join(dir, "orga.yaml")), 0o644);
    assert.equal(mode(path.join(dir, "orgaw")), 0o755);
    assert.equal(mode(path.join(dir, ".orga")), 0o700);

    const yaml = fs.readFileSync(path.join(dir, "orga.yaml"), "utf8");
    assert.match(yaml, /runner:\n\s+version: "[^"]+"\n\s+url: "[^"]+"\n\s+checksum: ""\n/);
  });
});

test("initProject appends .orga/ to .gitignore and .git/info/exclude idempotently", async () => {
  await withTempWorkspace(async (dir) => {
    fs.mkdirSync(path.join(dir, ".git", "info"), { recursive: true });

    initProject(dir);
    initProject(dir);

    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");

    assert.equal(gitignore.split("\n").filter((line) => line === ".orga/").length, 1);
    assert.equal(exclude.split("\n").filter((line) => line === ".orga/").length, 1);
  });
});

test("re-running initProject on an initialized project is a no-op that does not overwrite orga.yaml", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const orgaYamlPath = path.join(dir, "orga.yaml");
    fs.writeFileSync(orgaYamlPath, "runner:\n  version: \"custom-marker\"\n", { mode: 0o644 });

    const result = initProject(dir);
    assert.equal(result.created, false);

    const yaml = fs.readFileSync(orgaYamlPath, "utf8");
    assert.match(yaml, /custom-marker/);
  });
});

test("initProject refuses to run when a path component from cwd up to the root is a symlink", async () => {
  await withTempWorkspace(async (dir) => {
    const realTarget = path.join(dir, "real-project");
    fs.mkdirSync(realTarget, { recursive: true });
    const symlinkedDir = path.join(dir, "linked-project");
    fs.symlinkSync(realTarget, symlinkedDir, "dir");

    assert.throws(() => initProject(symlinkedDir), /symlink/);
  });
});
