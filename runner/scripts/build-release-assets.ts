// Builds the two release assets `orgaw` (`runner/src/store/orgaw-template.ts`)
// downloads, plus their checksum files, from a staging directory outside
// `runner/`: `organaiser-<version>.tgz` (the runner package, with `ajv` and
// its transitive dependencies bundled via `bundleDependencies` and the whole
// `workflows/` tree embedded at `package/workflows/`) and
// `organaiser-catalog-<version>.zip` (`workflows/` and `examples/` from the
// given git ref, packed with `git archive`). Never touches `runner/` in
// place: `npm pack` cannot include a path outside the package root, so the
// catalog copy has to land in a staging tree instead.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildReleaseAssetsOptions {
  version: string;
  ref: string;
  outDir: string;
  repoRoot?: string;
}

export interface ReleaseAssets {
  catalogZip: string;
  catalogZipChecksum: string;
  runnerTarball: string;
  runnerTarballChecksum: string;
}

interface RunnerPackageInfo {
  version: string;
}

function readRunnerVersion(repoRoot: string): string {
  const pkgPath = path.join(repoRoot, "runner", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as RunnerPackageInfo;
  return pkg.version;
}

function run(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function writeChecksum(assetPath: string): string {
  const digest = createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex");
  const checksumPath = `${assetPath}.sha256`;
  fs.writeFileSync(checksumPath, `${digest}\n`);
  return checksumPath;
}

export function buildReleaseAssets(options: BuildReleaseAssetsOptions): ReleaseAssets {
  const repoRoot = options.repoRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const actualVersion = readRunnerVersion(repoRoot);
  if (actualVersion !== options.version) {
    throw new Error(
      `version mismatch: requested "${options.version}" but runner/package.json declares "${actualVersion}"`,
    );
  }

  const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orga-release-")));
  try {
    const pkgDir = path.join(staging, "pkg");
    fs.mkdirSync(pkgDir, { recursive: true });

    for (const entry of ["package.json", "package-lock.json", "bin", "src", "evals"]) {
      fs.cpSync(path.join(repoRoot, "runner", entry), path.join(pkgDir, entry), { recursive: true });
    }

    const workflowsTar = path.join(staging, "workflows.tar");
    run("git", ["archive", "--format=tar", "-o", workflowsTar, options.ref, "workflows"], repoRoot);
    run("tar", ["-xf", workflowsTar, "-C", pkgDir], staging);

    run("npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], pkgDir);
    run("npm", ["pack", "--pack-destination", outDir], pkgDir);

    const runnerTarball = path.join(outDir, `organaiser-${options.version}.tgz`);
    const runnerTarballChecksum = writeChecksum(runnerTarball);

    const catalogZip = path.join(outDir, `organaiser-catalog-${options.version}.zip`);
    run(
      "git",
      [
        "archive",
        "--format=zip",
        `--prefix=organaiser-catalog-${options.version}/`,
        "-o",
        catalogZip,
        options.ref,
        "workflows",
        "examples",
      ],
      repoRoot,
    );
    const catalogZipChecksum = writeChecksum(catalogZip);

    return { catalogZip, catalogZipChecksum, runnerTarball, runnerTarballChecksum };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

export function main(argv: readonly string[]): void {
  const [, , version, ref, outDir] = argv;
  if (!version || !ref || !outDir) {
    process.stderr.write("build-release-assets: usage: build-release-assets.ts <version> <ref> <outDir>\n");
    process.exitCode = 1;
    return;
  }

  try {
    const assets = buildReleaseAssets({ version, ref, outDir });
    process.stdout.write(`${assets.runnerTarball}\n`);
    process.stdout.write(`${assets.runnerTarballChecksum}\n`);
    process.stdout.write(`${assets.catalogZip}\n`);
    process.stdout.write(`${assets.catalogZipChecksum}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  main(process.argv);
}
