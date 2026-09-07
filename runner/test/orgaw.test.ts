import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const BASE_TOOLS = ["dirname", "sed", "head", "mkdir", "chmod", "mktemp", "tar", "awk", "rm", "mv", "node"];

function writeOrgaYaml(dir: string, version: string, url: string, checksum: string): void {
  fs.writeFileSync(
    path.join(dir, "orga.yaml"),
    `runner:\n  version: "${version}"\n  url: "${url}"\n  checksum: "${checksum}"\n`,
  );
}

function buildFixtureTarball(dir: string, marker: string): { tgzPath: string; digest: string } {
  const stageDir = path.join(dir, "fixture-stage");
  const binDir = path.join(stageDir, "package", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "orga.ts"),
    `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)} + " " + process.argv.slice(2).join(" "));\n`,
  );
  fs.writeFileSync(path.join(stageDir, "package", "package.json"), JSON.stringify({ name: "organaiser", version: "0.0.0" }));

  const tgzPath = path.join(dir, "runner.tgz");
  execFileSync("tar", ["-czf", tgzPath, "-C", stageDir, "package"]);
  const digest = createHash("sha256").update(fs.readFileSync(tgzPath)).digest("hex");
  return { tgzPath, digest };
}

function resolveToolPath(tool: string): string | null {
  try {
    const out = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function buildToolStubDir(dir: string, tools: readonly string[]): string {
  const stubDir = fs.mkdtempSync(path.join(dir, "stub-bin-"));
  for (const tool of tools) {
    const resolved = resolveToolPath(tool);
    if (!resolved) continue;
    fs.symlinkSync(resolved, path.join(stubDir, tool));
  }
  return stubDir;
}

function orgaTmpEntries(dir: string): string[] {
  const orgaDir = path.join(dir, ".orga");
  if (!fs.existsSync(orgaDir)) return [];
  return fs.readdirSync(orgaDir).filter((entry) => entry.startsWith("orgaw-tmp-"));
}

test("orgaw: downloads, verifies, extracts, and execs an absent pinned runner from a fresh-clone shape", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const marker = "ORGAW-FIXTURE-MARKER";
    const { tgzPath, digest } = buildFixtureTarball(dir, marker);
    const version = "9.9.9";
    writeOrgaYaml(dir, version, `file://${tgzPath}`, digest);
    fs.rmSync(path.join(dir, ".orga"), { recursive: true, force: true });

    const stdout = execFileSync("sh", [path.join(dir, "orgaw"), "doctor"], { encoding: "utf8" });
    assert.match(stdout, new RegExp(marker));
    assert.match(stdout, /doctor/);

    const versionDir = path.join(dir, ".orga", "runner", version);
    assert.equal(fs.existsSync(path.join(versionDir, "bin", "orga.ts")), true);
    assert.equal(fs.existsSync(path.join(versionDir, "package")), false);
    assert.deepEqual(orgaTmpEntries(dir), []);

    assert.equal(fs.statSync(path.join(dir, ".orga")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, ".orga", "runner")).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(dir, ".orga", "state.sqlite")), false);
    assert.equal(fs.existsSync(path.join(dir, ".orga", "config.resolved.json")), false);
  });
});

test("orgaw: execs an already-present pinned runner without downloading, probing tools, or creating a temp directory", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const version = "1.2.3";
    const marker = "ORGAW-PRESENT-MARKER";
    const binDir = path.join(dir, ".orga", "runner", version, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, "orga.ts"),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)} + " " + process.argv.slice(2).join(" "));\n`,
    );
    writeOrgaYaml(dir, version, `file://${path.join(dir, "does-not-exist.tgz")}`, "0".repeat(64));

    const stdout = execFileSync("sh", [path.join(dir, "orgaw"), "status"], { encoding: "utf8" });
    assert.match(stdout, new RegExp(marker));
    assert.match(stdout, /status/);
    assert.deepEqual(orgaTmpEntries(dir), []);
  });
});

test("orgaw: a digest mismatch exits non-zero naming both digests and leaves no temp directory or version directory", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const { tgzPath, digest } = buildFixtureTarball(dir, "ORGAW-BAD-CHECKSUM-MARKER");
    const version = "2.0.0";
    const wrongDigest = "a".repeat(64);
    assert.notEqual(digest, wrongDigest);
    writeOrgaYaml(dir, version, `file://${tgzPath}`, wrongDigest);
    fs.rmSync(path.join(dir, ".orga"), { recursive: true, force: true });

    assert.throws(
      () => {
        execFileSync("sh", [path.join(dir, "orgaw")], { encoding: "utf8" });
      },
      (err: unknown) => {
        const e = err as { status: number; stderr: string };
        assert.notEqual(e.status, 0);
        assert.match(e.stderr, new RegExp(wrongDigest));
        assert.match(e.stderr, new RegExp(digest));
        return true;
      },
    );

    assert.equal(fs.existsSync(path.join(dir, ".orga", "runner", version)), false);
    assert.deepEqual(orgaTmpEntries(dir), []);
  });
});

test("orgaw: an absent runner with an empty checksum refuses to download and names the version, URL, and orga init --runner-checksum", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const version = "3.0.0";
    const url = "file:///does/not/matter.tgz";
    writeOrgaYaml(dir, version, url, "");
    fs.rmSync(path.join(dir, ".orga"), { recursive: true, force: true });

    assert.throws(
      () => {
        execFileSync("sh", [path.join(dir, "orgaw")], { encoding: "utf8" });
      },
      (err: unknown) => {
        const e = err as { status: number; stderr: string };
        assert.notEqual(e.status, 0);
        assert.match(e.stderr, new RegExp(version));
        assert.match(e.stderr, /matter\.tgz/);
        assert.match(e.stderr, /orga init --runner-checksum/);
        return true;
      },
    );
  });
});

test("orgaw: exits non-zero naming curl and wget when neither download tool is resolvable", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const version = "4.0.0";
    writeOrgaYaml(dir, version, "file:///does/not/matter.tgz", "a".repeat(64));
    fs.rmSync(path.join(dir, ".orga"), { recursive: true, force: true });

    const stubDir = buildToolStubDir(dir, BASE_TOOLS);

    assert.throws(
      () => {
        execFileSync("/bin/sh", [path.join(dir, "orgaw")], { encoding: "utf8", env: { PATH: stubDir } });
      },
      (err: unknown) => {
        const e = err as { status: number; stderr: string };
        assert.notEqual(e.status, 0);
        assert.match(e.stderr, /curl/);
        assert.match(e.stderr, /wget/);
        return true;
      },
    );
  });
});

test("orgaw: exits non-zero naming sha256sum, shasum, and openssl when no hash tool is resolvable", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const version = "5.0.0";
    writeOrgaYaml(dir, version, "file:///does/not/matter.tgz", "a".repeat(64));
    fs.rmSync(path.join(dir, ".orga"), { recursive: true, force: true });

    const stubDir = buildToolStubDir(dir, [...BASE_TOOLS, "curl"]);

    assert.throws(
      () => {
        execFileSync("/bin/sh", [path.join(dir, "orgaw")], { encoding: "utf8", env: { PATH: stubDir } });
      },
      (err: unknown) => {
        const e = err as { status: number; stderr: string };
        assert.notEqual(e.status, 0);
        assert.match(e.stderr, /sha256sum/);
        assert.match(e.stderr, /shasum/);
        assert.match(e.stderr, /openssl/);
        return true;
      },
    );
  });
});

test("orgaw: the generated script is syntactically valid POSIX sh", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    execFileSync("sh", ["-n", path.join(dir, "orgaw")], { encoding: "utf8" });
  });
});
