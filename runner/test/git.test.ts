import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withTempWorkspace } from "./helpers/workspace.ts";
import {
  headSha,
  isAncestor,
  frontmatterStatusFromText,
  committedFrontmatterStatus,
  commitsSince,
} from "../src/git/git.ts";

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

function makeRepo(dir: string): string {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
  return commitFile(dir, "seed.txt", "seed\n", "seed");
}

test("headSha returns the current HEAD as a 40-char hex string", async () => {
  await withTempWorkspace((dir) => {
    const seed = makeRepo(dir);
    const sha = headSha(dir);
    assert.match(sha, /^[0-9a-f]{40}$/, "headSha must be a 40-char hex SHA");
    assert.equal(sha, seed);
  });
});

test("frontmatterStatusFromText extracts the status value from a frontmatter block", () => {
  const text = "---\ntitle: My Task\nstatus: Done\nassignee: alice\n---\n\nBody text.";
  assert.equal(frontmatterStatusFromText(text), "Done");
});

test("frontmatterStatusFromText handles mixed-case field (spec uses lowercase status)", () => {
  const text = "---\nstatus: In Progress\n---\n";
  assert.equal(frontmatterStatusFromText(text), "In Progress");
});

test("frontmatterStatusFromText returns null when no frontmatter block is present", () => {
  assert.equal(frontmatterStatusFromText("Just plain text\nstatus: Done\n"), null);
});

test("frontmatterStatusFromText returns null when frontmatter has no status field", () => {
  const text = "---\ntitle: My Task\n---\n\nBody here.";
  assert.equal(frontmatterStatusFromText(text), null);
});

test("frontmatterStatusFromText does not match a status line in the body (after closing ---)", () => {
  const text = "---\ntitle: My Task\n---\n\nstatus: Done\n";
  assert.equal(frontmatterStatusFromText(text), null);
});

test("isAncestor returns false for a valid commit that is not an ancestor of another, and true for the reverse", async () => {
  await withTempWorkspace((dir) => {
    const parent = makeRepo(dir);
    const head = commitFile(dir, "b.txt", "b\n", "second");

    assert.equal(
      isAncestor(head, parent, dir),
      false,
      "HEAD is not an ancestor of its own parent",
    );
    assert.equal(isAncestor(parent, head, dir), true, "parent IS an ancestor of HEAD");
  });
});

test("isAncestor surfaces a real error when the descendant ref is garbage", async () => {
  await withTempWorkspace((dir) => {
    const head = makeRepo(dir);
    assert.throws(
      () => isAncestor(head, "not-a-valid-ref-zzz-garbage", dir),
      (err: unknown) => err instanceof Error,
      "isAncestor must rethrow real git errors, not silently return false",
    );
  });
});

test("isAncestor returns false (not an error) when the commit does not exist", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    assert.equal(
      isAncestor("0000000000000000000000000000000000000000", "HEAD", dir),
      false,
    );
  });
});

test("committedFrontmatterStatus reads the COMMITTED status, never the working tree", async () => {
  await withTempWorkspace((dir) => {
    runGit(dir, ["init", "-q"]);
    runGit(dir, ["config", "commit.gpgsign", "false"]);
    const spec = path.join(dir, "task.md");

    commitFile(dir, "task.md", "---\nstatus: Approved\n---\n\n# Task\n", "add task (Approved)");

    fs.writeFileSync(spec, "---\nstatus: Done\n---\n\n# Task\n", "utf8");
    assert.equal(committedFrontmatterStatus(spec, dir), "Approved");

    commitFile(dir, "task.md", "---\nstatus: Done\n---\n\n# Task\n", "mark Done");
    assert.equal(committedFrontmatterStatus(spec, dir), "Done");

    const fresh = path.join(dir, "fresh.md");
    fs.writeFileSync(fresh, "---\nstatus: Done\n---\n", "utf8");
    assert.equal(committedFrontmatterStatus(fresh, dir), null);

    const elsewhere = path.join(path.dirname(dir), "elsewhere.md");
    assert.equal(committedFrontmatterStatus(elsewhere, dir), null);
  });
});

test("commitsSince returns full 40-char SHAs of baseline..HEAD newest-first", async () => {
  await withTempWorkspace((dir) => {
    const seed = makeRepo(dir);
    assert.deepEqual(commitsSince(seed, dir), [], "no commits since HEAD itself");

    const first = commitFile(dir, "b.txt", "b\n", "first");
    const second = commitFile(dir, "c.txt", "c\n", "second");

    const since = commitsSince(seed, dir);
    assert.deepEqual(since, [second, first], "newest-first, baseline excluded");
    for (const sha of since) {
      assert.match(sha, /^[0-9a-f]{40}$/, "full 40-char hex SHA (no --abbrev)");
    }
  });
});

test("commitsSince is tolerant of a missing/invalid baseline and never throws", async () => {
  await withTempWorkspace((dir) => {
    makeRepo(dir);
    assert.deepEqual(commitsSince("", dir), [], "empty baseline -> []");
    assert.deepEqual(commitsSince(null, dir), [], "null baseline -> []");
    assert.deepEqual(
      commitsSince("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", dir),
      [],
      "unknown sha -> []",
    );
  });
});

test("commitsSince never attributes commits authored before the baseline", async () => {
  await withTempWorkspace((dir) => {
    const before = makeRepo(dir);
    const baseline = headSha(dir);
    const after = commitFile(dir, "b.txt", "b\n", "after baseline");

    const since = commitsSince(baseline, dir);
    assert.deepEqual(since, [after], "only the post-baseline commit");
    assert.ok(!since.includes(before), "pre-baseline commit is never attributed");
  });
});

test("the recorded integration commit is excluded from the captured implementer commits", async () => {
  await withTempWorkspace((dir) => {
    const baseline = makeRepo(dir);
    const workerSha = commitFile(dir, "src/code.txt", "work\n", "worker change");
    const integrationSha = commitFile(dir, "spec.md", "---\nstatus: Done\n---\n", "finalize");

    const delta = commitsSince(baseline, dir);
    assert.deepEqual(delta, [integrationSha, workerSha], "delta has both, newest-first");
    const captured = delta.filter((sha) => sha !== integrationSha);
    assert.deepEqual(captured, [workerSha], "integration commit excluded by exact SHA match");
  });
});
