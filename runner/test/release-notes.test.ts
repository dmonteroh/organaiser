import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";
import {
  generateContractVersionDelta,
  GitRefError,
  ContractVersionConflictError,
  MalformedContractBlockError,
} from "../scripts/release-notes.ts";

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function commitFile(
  dir: string,
  relPath: string,
  contents: string,
  message: string,
): string {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, "utf8");
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    message,
    "--",
    relPath,
  ]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function removeFile(dir: string, relPath: string, message: string): string {
  fs.rmSync(path.join(dir, relPath));
  runGit(dir, ["add", "--", relPath]);
  runGit(dir, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    message,
    "--",
    relPath,
  ]);
  return runGit(dir, ["rev-parse", "HEAD"]);
}

function makeRepo(dir: string): void {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
}

function tag(dir: string, name: string): void {
  runGit(dir, ["tag", name]);
}

function frontmatter(id: string, contractVersion: string): string {
  return `---\nid: ${id}\ncontractVersion: ${contractVersion}\n---\n\nBody.\n`;
}

function manifest(id: string, contractVersion: string): string {
  return (
    `apiVersion: ai-workflows.dev/v1alpha1\n` +
    `kind: Workflow\n` +
    `metadata:\n` +
    `  id: ${id}\n` +
    `  contractVersion: ${contractVersion}\n` +
    `spec:\n` +
    `  policy: ../elsewhere.md\n` +
    `  stages:\n` +
    `    - id: not-a-contract-id\n` +
    `      kind: runner\n`
  );
}

test("release notes: markdown bump, manifest-only bump, added, removed, unchanged, no-frontmatter skip", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);

    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.0.0"), "add alpha 1.0.0");
    commitFile(
      dir,
      "workflows/manifests/beta.v1.yaml",
      manifest("beta", "1.0.0"),
      "add beta manifest 1.0.0",
    );
    commitFile(dir, "workflows/gamma.md", frontmatter("gamma", "1.0.0"), "add gamma 1.0.0");
    commitFile(
      dir,
      "workflows/delta-removed.md",
      frontmatter("delta-removed", "1.0.0"),
      "add delta-removed 1.0.0",
    );
    commitFile(
      dir,
      "workflows/conventions.md",
      "# Conventions\n\nThis file mentions contractVersion in prose but has no frontmatter.\n",
      "add conventions (no frontmatter)",
    );
    tag(dir, "v1");

    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.1.0"), "bump alpha to 1.1.0");
    commitFile(
      dir,
      "workflows/manifests/beta.v1.yaml",
      manifest("beta", "2.0.0"),
      "bump beta manifest to 2.0.0",
    );
    commitFile(
      dir,
      "workflows/epsilon.md",
      frontmatter("epsilon", "1.0.0"),
      "add epsilon 1.0.0",
    );
    removeFile(dir, "workflows/delta-removed.md", "remove delta-removed");
    tag(dir, "v2");

    const section = generateContractVersionDelta("v1", "v2", dir);

    assert.equal(section.startsWith("## Contract Versions\n"), true, "single ## heading, no leading blank line");
    assert.equal(section.endsWith("\n"), true, "exactly one trailing newline");
    assert.equal(section.endsWith("\n\n"), false, "exactly one trailing newline, not two");

    assert.match(section, /\*\*Changed:\*\*/);
    assert.match(section, /- `alpha`: `1\.0\.0` -> `1\.1\.0`/);
    assert.match(section, /- `beta`: `1\.0\.0` -> `2\.0\.0`/);

    assert.match(section, /\*\*Added:\*\*/);
    assert.match(section, /- `epsilon`: `1\.0\.0`/);

    assert.match(section, /\*\*Removed:\*\*/);
    assert.match(section, /- `delta-removed`: `1\.0\.0`/);

    assert.equal(section.includes("gamma"), false, "unchanged contract is not listed");
    assert.equal(section.includes("conventions"), false, "no-frontmatter file never yields a contract");
  });
});

test("release notes: no changes between refs yields the explicit no-contract-changes line", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.0.0"), "add alpha");
    tag(dir, "v1");
    commitFile(dir, "workflows/unrelated.txt", "unrelated\n", "unrelated change");
    tag(dir, "v2");

    const section = generateContractVersionDelta("v1", "v2", dir);
    assert.equal(section, "## Contract Versions\n\nNo contract changes.\n");
  });
});

test("release notes: no previous ref lists every contract at its current version instead of failing", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.0.0"), "add alpha");
    commitFile(
      dir,
      "workflows/manifests/beta.v1.yaml",
      manifest("beta", "1.0.0"),
      "add beta manifest",
    );
    tag(dir, "v1");

    const section = generateContractVersionDelta(null, "v1", dir);
    assert.equal(section.startsWith("## Contract Versions\n"), true);
    assert.match(section, /First release: every contract at its current version\./);
    assert.match(section, /- `alpha`: `1\.0\.0`/);
    assert.match(section, /- `beta`: `1\.0\.0`/);
    assert.equal(section.includes("Added"), false, "first release never uses the added label");
  });
});

test("release notes: fails with a named error when a ref is unavailable in the local clone", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.0.0"), "add alpha");
    tag(dir, "v1");

    assert.throws(
      () => generateContractVersionDelta("v1", "not-a-real-ref-zzz", dir),
      (err: unknown) => err instanceof GitRefError,
    );
  });
});

test("release notes: cross-source contractVersion disagreement fails with a named error, no delta line emitted", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    commitFile(dir, "workflows/dev-workflow.md", frontmatter("dev-workflow", "1.0.0"), "add md");
    commitFile(
      dir,
      "workflows/manifests/development.v1.yaml",
      manifest("dev-workflow", "2.0.0"),
      "add manifest disagreeing with md",
    );
    tag(dir, "v1");

    assert.throws(
      () => generateContractVersionDelta(null, "v1", dir),
      (err: unknown) => {
        assert.equal(err instanceof ContractVersionConflictError, true);
        const message = (err as Error).message;
        assert.match(message, /dev-workflow/);
        assert.match(message, /v1/);
        assert.match(message, /1\.0\.0/);
        assert.match(message, /2\.0\.0/);
        return true;
      },
    );
  });
});

test("release notes: markdown frontmatter declaring id without contractVersion throws MalformedContractBlockError naming the path", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    commitFile(
      dir,
      "workflows/malformed.md",
      "---\nid: malformed-contract\n---\n\nBody.\n",
      "add malformed contract md",
    );
    tag(dir, "v1");

    assert.throws(
      () => generateContractVersionDelta(null, "v1", dir),
      (err: unknown) => {
        assert.equal(err instanceof MalformedContractBlockError, true);
        const message = (err as Error).message;
        assert.match(message, /workflows\/malformed\.md/);
        assert.match(message, /id without contractVersion/);
        return true;
      },
    );
  });
});

test("release notes: identical id and contractVersion declared in both markdown frontmatter and yaml manifest folds to one contract, never duplicated or reported as changed", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.0.0"), "add alpha 1.0.0");
    commitFile(
      dir,
      "workflows/shared.md",
      frontmatter("shared-workflow", "1.0.0"),
      "add shared-workflow md",
    );
    commitFile(
      dir,
      "workflows/manifests/shared.v1.yaml",
      manifest("shared-workflow", "1.0.0"),
      "add shared-workflow manifest matching md",
    );
    tag(dir, "v1");

    const initial = generateContractVersionDelta(null, "v1", dir);
    const sharedOccurrences = (initial.match(/`shared-workflow`/g) ?? []).length;
    assert.equal(
      sharedOccurrences,
      1,
      "identically-declared cross-source contract appears exactly once",
    );
    assert.match(initial, /- `shared-workflow`: `1\.0\.0`/);

    commitFile(dir, "workflows/alpha.md", frontmatter("alpha", "1.1.0"), "bump alpha to 1.1.0");
    tag(dir, "v2");

    const diff = generateContractVersionDelta("v1", "v2", dir);
    assert.match(diff, /\*\*Changed:\*\*/);
    assert.match(diff, /- `alpha`: `1\.0\.0` -> `1\.1\.0`/);
    assert.equal(
      diff.includes("shared-workflow"),
      false,
      "unchanged cross-source contract is not listed as changed, added, or removed",
    );
  });
});
