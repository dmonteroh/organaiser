import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoSymlinkAncestry } from "./db.ts";

const ORGA_YAML = "orga.yaml";
const ORGAW = "orgaw";
const ORGA_DIR = ".orga";
const GITIGNORE = ".gitignore";

const ORGAW_TEMPLATE = `#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(sed -n 's/^[[:space:]]*version:[[:space:]]*"\\{0,1\\}\\([^"[:space:]]*\\)"\\{0,1\\}[[:space:]]*$/\\1/p' "$DIR/${ORGA_YAML}" | head -n 1)
RUNNER_BIN="$DIR/${ORGA_DIR}/runner/$VERSION/bin/orga.ts"
if [ -f "$RUNNER_BIN" ]; then
  exec node "$RUNNER_BIN" "$@"
fi
echo "orgaw: pinned runner not found at $RUNNER_BIN" >&2
exit 1
`;

interface RunnerPackageInfo {
  version: string;
}

function readRunnerVersion(): string {
  const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as RunnerPackageInfo;
  return pkg.version;
}

function renderOrgaYaml(version: string): string {
  return `runner:\n  version: "${version}"\n`;
}

function filesystemRoot(p: string): string {
  return path.parse(p).root;
}

function appendIgnoreLineIfAbsent(filePath: string, line: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const existingLines = existing.length > 0 ? existing.split("\n") : [];
  if (existingLines.includes(line)) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  fs.appendFileSync(filePath, `${needsLeadingNewline ? "\n" : ""}${line}\n`, "utf8");
}

export interface InitProjectResult {
  root: string;
  created: boolean;
}

// Creates orga.yaml, orgaw, and .orga/ at `cwd`, and registers .orga/ as
// ignored in both .gitignore and .git/info/exclude. Writes nothing else
// outside those paths. Re-running on an already-initialized project touches
// neither orga.yaml nor orgaw, and every ignore-line append is idempotent.
export function initProject(cwd: string): InitProjectResult {
  const root = path.resolve(cwd);
  assertNoSymlinkAncestry(filesystemRoot(root), root);

  const orgaYamlPath = path.join(root, ORGA_YAML);
  const orgawPath = path.join(root, ORGAW);
  const orgaDirPath = path.join(root, ORGA_DIR);

  const alreadyInitialized = fs.existsSync(orgaYamlPath);

  if (!alreadyInitialized) {
    fs.writeFileSync(orgaYamlPath, renderOrgaYaml(readRunnerVersion()), { mode: 0o644 });
    fs.chmodSync(orgaYamlPath, 0o644);
  }

  if (!fs.existsSync(orgawPath)) {
    fs.writeFileSync(orgawPath, ORGAW_TEMPLATE, { mode: 0o755 });
    fs.chmodSync(orgawPath, 0o755);
  }

  if (!fs.existsSync(orgaDirPath)) {
    fs.mkdirSync(orgaDirPath, { recursive: true, mode: 0o700 });
    fs.chmodSync(orgaDirPath, 0o700);
  }

  appendIgnoreLineIfAbsent(path.join(root, GITIGNORE), `${ORGA_DIR}/`);

  const gitDir = path.join(root, ".git");
  if (fs.existsSync(gitDir)) {
    const gitInfoDir = path.join(gitDir, "info");
    fs.mkdirSync(gitInfoDir, { recursive: true });
    appendIgnoreLineIfAbsent(path.join(gitInfoDir, "exclude"), `${ORGA_DIR}/`);
  }

  return { root, created: !alreadyInitialized };
}
