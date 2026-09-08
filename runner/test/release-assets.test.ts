import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildReleaseAssets } from "../scripts/build-release-assets.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNNER_PACKAGE_JSON = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  version: string;
  files?: string[];
  bundleDependencies?: string[];
  private?: boolean;
};

const EXPECTED_FILES_ALLOWLIST = ["bin/", "src/", "evals/", "workflows/", "package.json"];
const BUNDLED_TRANSITIVE_DEPS = ["ajv", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"];

interface TaskOverrides {
  id?: string;
  title?: string;
  briefPath?: string;
  entry?: { workflowId: string; stageId: string };
  dependencies?: string[];
  priority?: number;
  claims?: unknown;
  verification?: unknown[];
  enabled?: boolean;
}

function makeTask(overrides: TaskOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "t1",
    title: overrides.title ?? "Task",
    briefPath: overrides.briefPath ?? "brief.md",
    entry: overrides.entry ?? { workflowId: "wf1", stageId: "s1" },
    dependencies: overrides.dependencies ?? [],
    priority: overrides.priority ?? 0,
    requiredWorkflowVersions: {},
    claims: overrides.claims ?? "unknown",
    verification: overrides.verification ?? [],
    enabled: overrides.enabled ?? true,
  };
}

function makeBoard(tasks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: { tasks },
  };
}

function writeBoardFile(dir: string, board: unknown): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
  return boardPath;
}

function tarballEntries(tarball: string): string[] {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n");
}

function zipEntries(zip: string): string[] {
  return execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((entry) => entry.length > 0);
}

function runBin(
  binPath: string,
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `orga ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? ""}\nstdout: ${result.stdout ?? ""}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

test("release assets", async (t) => {
  await withTempWorkspace(async (out) => {
    const assets = buildReleaseAssets({ version: RUNNER_PACKAGE_JSON.version, ref: "HEAD", outDir: out });
    const entries = tarballEntries(assets.runnerTarball);

    await t.test("tarball shape", () => {
      assert.deepEqual(RUNNER_PACKAGE_JSON.files, EXPECTED_FILES_ALLOWLIST);
      assert.deepEqual(RUNNER_PACKAGE_JSON.bundleDependencies, ["ajv"]);
      assert.equal(RUNNER_PACKAGE_JSON.private, true);

      const topLevelDirs = new Set(entries.map((entry) => entry.split("/")[0]));
      assert.deepEqual([...topLevelDirs], ["package"]);

      for (const dir of ["schemas", "subagents", "manifests"]) {
        assert.ok(
          entries.some((entry) => entry.startsWith(`package/workflows/${dir}/`)),
          `tarball is missing package/workflows/${dir}/`,
        );
      }
      assert.ok(
        entries.includes("package/workflows/task-board-workflow.md"),
        "tarball is missing package/workflows/task-board-workflow.md",
      );

      for (const dep of BUNDLED_TRANSITIVE_DEPS) {
        assert.ok(
          entries.some((entry) => entry.startsWith(`package/node_modules/${dep}/`)),
          `tarball is missing bundled dependency ${dep}`,
        );
      }

      assert.ok(!entries.some((entry) => entry.startsWith("package/test/")), "tarball must not contain package/test/");
      assert.ok(!entries.some((entry) => entry.startsWith("package/.orga/")), "tarball must not contain package/.orga/");
      assert.ok(
        !entries.some((entry) => entry.startsWith("package/node_modules/typescript/")),
        "tarball must not bundle the typescript dev dependency",
      );
      assert.ok(
        !entries.some((entry) => entry.startsWith("package/node_modules/@types/")),
        "tarball must not bundle @types dev dependencies",
      );
    });

    await t.test("catalog zip", () => {
      const prefix = `organaiser-catalog-${RUNNER_PACKAGE_JSON.version}/`;
      const catalogEntries = zipEntries(assets.catalogZip);
      assert.ok(
        catalogEntries.every((entry) => entry.startsWith(prefix)),
        "every zip entry must sit under the catalog prefix",
      );

      const trackedFiles = execFileSync(
        "git",
        ["ls-tree", "-r", "--name-only", "HEAD", "--", "workflows", "examples"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter((entry) => entry.length > 0);

      const zipFiles = catalogEntries
        .filter((entry) => !entry.endsWith("/"))
        .map((entry) => entry.slice(prefix.length))
        .sort();

      assert.deepEqual(zipFiles, [...trackedFiles].sort());
    });

    await t.test("checksum files", () => {
      for (const [asset, checksum] of [
        [assets.runnerTarball, assets.runnerTarballChecksum],
        [assets.catalogZip, assets.catalogZipChecksum],
      ] as const) {
        const contents = fs.readFileSync(checksum, "utf8");
        assert.match(contents, /^[0-9a-f]{64}\n$/);
        const digest = createHash("sha256").update(fs.readFileSync(asset)).digest("hex");
        assert.equal(contents, `${digest}\n`);
      }
    });

    await withTempWorkspace(async (extractDir) => {
      execFileSync("tar", ["-xzf", assets.runnerTarball, "-C", extractDir]);
      const binPath = path.join(extractDir, "package", "bin", "orga.ts");

      for (const root of ["src", "bin"]) {
        const dir = path.join(extractDir, "package", root);
        for (const relative of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
          if (!relative.endsWith(".ts")) continue;
          const full = path.join(dir, relative);
          assert.ok(
            !fs.readFileSync(full, "utf8").includes("../../../workflows"),
            `${full} hardcodes ../../../workflows`,
          );
        }
      }

      await t.test("smoke: board validate", async () => {
        await withTempWorkspace(async (projectDir) => {
          const boardPath = writeBoardFile(projectDir, makeBoard([makeTask()]));
          const { stdout, stderr } = runBin(binPath, ["board", "validate", "--board", boardPath], projectDir);
          assert.ok(stdout.trim().length > 0, "board validate produced no stdout");
          assert.ok(stdout.includes("is valid"), stdout);
          assert.ok(!stderr.includes("ENOENT"), stderr);
        });
      });

      await t.test("smoke: init and dry-run", async () => {
        await withTempWorkspace(async (projectDir) => {
          const init = runBin(binPath, ["init"], projectDir);
          assert.ok(init.stdout.trim().length > 0, "init produced no stdout");
          assert.ok(!init.stderr.includes("ENOENT"), init.stderr);

          const boardPath = writeBoardFile(projectDir, makeBoard([makeTask()]));
          const dryRun = runBin(binPath, ["run", "dry-run", "--board", boardPath], projectDir);
          assert.ok(dryRun.stdout.trim().length > 0, "run dry-run produced no stdout");
          assert.ok(!dryRun.stderr.includes("ENOENT"), dryRun.stderr);
        });
      });

      await t.test("smoke: eval list", async () => {
        await withTempWorkspace(async (projectDir) => {
          const { stdout, stderr } = runBin(binPath, ["eval", "list"], projectDir);
          assert.ok(stdout.trim().length > 0, "eval list produced no stdout");
          assert.ok(!stderr.includes("ENOENT"), stderr);
        });
      });
    });
  });
});

test("buildReleaseAssets rejects a version that does not match runner/package.json", async () => {
  await withTempWorkspace(async (out) => {
    assert.throws(
      () => buildReleaseAssets({ version: "9.9.9-does-not-exist", ref: "HEAD", outDir: out }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("9.9.9-does-not-exist"), err.message);
        assert.ok(err.message.includes(RUNNER_PACKAGE_JSON.version), err.message);
        return true;
      },
    );
  });
});
