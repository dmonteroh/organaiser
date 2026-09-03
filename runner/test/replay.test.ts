import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { accept } from "../src/engine/predicates.ts";
import { commitsSince, headSha } from "../src/git/git.ts";
import { createLedger, recordEvidence } from "../src/store/evidence.ts";
import {
  type ArtifactRef,
  ArtifactRefError,
  makeArtifactRef,
  resolveArtifactRef,
} from "../src/store/artifact-ref.ts";
import {
  verdictRegex,
  reportHasPassVerdict,
  parseDispatchLog,
  deriveImplementerCommits,
  reconstructLedger,
  buildFacts,
  type DispatchLogRow,
  type ReviewerEvidence,
} from "../src/reports/replay.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(HERE, "fixtures", "replay");

async function withTwoTempWorkspaces<T>(
  fn: (a: string, b: string) => T | Promise<T>,
): Promise<T> {
  return withTempWorkspace((a) => withTempWorkspace((b) => fn(a, b)));
}

function runGit(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

function commitFile(dir: string, relPath: string, contents: string, message: string): string {
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

function initRepo(dir: string): void {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "commit.gpgsign", "false"]);
}

function writeDispatchLog(dir: string, rows: DispatchLogRow[]): void {
  const header = "seq\trole\treason\tcommit_before\tcommit_after\tpacket_file\treport_file";
  const lines = rows.map((r, i) =>
    [
      i + 1,
      r.role ?? "",
      r.reason ?? "",
      r.commit_before ?? "none",
      r.commit_after ?? "none",
      r.packet_file ?? "",
      r.report_file ?? "",
    ].join("\t"),
  );
  fs.writeFileSync(path.join(dir, "dispatch-log.tsv"), `${[header, ...lines].join("\n")}\n`, "utf8");
}

interface FixtureMeta {
  taskId: string;
  specPath: string;
  verificationMode: string;
  integrationCommit: string;
}

function runReplayPipeline(root: string) {
  const meta = JSON.parse(fs.readFileSync(path.join(root, "meta.json"), "utf8")) as FixtureMeta;
  const ledger = reconstructLedger(root, {
    taskId: meta.taskId,
    specPath: path.join(root, meta.specPath),
    verificationMode: meta.verificationMode,
    integrationCommit: meta.integrationCommit,
    runRoot: root,
  });
  const facts = buildFacts(ledger, { cwd: path.join(root, "repo.git"), runRoot: root });
  const result = accept(facts);
  return { ledger, facts, result };
}

// ── artifact-ref.ts: run-relative refs, path-escape rejection ─────────────────

test("makeArtifactRef stores a run-relative path and content hash, never an absolute path", async () => {
  await withTempWorkspace((root) => {
    const nested = path.join(root, "a", "b", "report.txt");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "Verdict: pass\n", "utf8");

    const ref = makeArtifactRef(root, nested);
    assert.equal(ref.path, "a/b/report.txt");
    assert.equal(path.isAbsolute(ref.path), false);
    assert.match(ref.sha256, /^[0-9a-f]{64}$/);
  });
});

test("resolveArtifactRef resolves a valid run-relative ref back to its absolute path within root", async () => {
  await withTempWorkspace((root) => {
    const target = path.join(root, "reports", "x.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "Verdict: pass\n", "utf8");

    const ref = makeArtifactRef(root, target);
    assert.equal(resolveArtifactRef(root, ref), target);
  });
});

test("makeArtifactRef throws a named error for a path outside root", async () => {
  await withTwoTempWorkspaces((root, outside) => {
    const outsideFile = path.join(outside, "report.txt");
    fs.writeFileSync(outsideFile, "Verdict: pass\n", "utf8");
    assert.throws(() => makeArtifactRef(root, outsideFile), ArtifactRefError);
  });
});

test("resolveArtifactRef throws a named error when ref.path is absolute, and never falls back to it", async () => {
  await withTempWorkspace((root) => {
    const evil: ArtifactRef = { path: "/etc/passwd", sha256: "0".repeat(64) };
    assert.throws(() => resolveArtifactRef(root, evil), ArtifactRefError);
  });
});

test("resolveArtifactRef throws a named error when the normalized join escapes root", async () => {
  await withTempWorkspace((root) => {
    assert.throws(
      () => resolveArtifactRef(root, { path: "../outside.txt", sha256: "0".repeat(64) }),
      ArtifactRefError,
    );
    assert.throws(
      () => resolveArtifactRef(root, { path: "a/../../outside.txt", sha256: "0".repeat(64) }),
      ArtifactRefError,
    );
  });
});

test("resolveArtifactRef throws a named error when ref.path is empty or resolves to the root itself", async () => {
  await withTempWorkspace((root) => {
    assert.throws(
      () => resolveArtifactRef(root, { path: "", sha256: "0".repeat(64) }),
      ArtifactRefError,
    );
    assert.throws(
      () => resolveArtifactRef(root, { path: ".", sha256: "0".repeat(64) }),
      ArtifactRefError,
    );
  });
});

test("makeArtifactRef throws a named error when the source path is a symlink whose target escapes root", async () => {
  await withTwoTempWorkspaces((root, outside) => {
    const outsideFile = path.join(outside, "report.txt");
    fs.writeFileSync(outsideFile, "Verdict: pass\n", "utf8");
    const symlinkPath = path.join(root, "report.txt");
    fs.symlinkSync(outsideFile, symlinkPath);

    assert.throws(() => makeArtifactRef(root, symlinkPath), ArtifactRefError);
  });
});

test("resolveArtifactRef throws a named error when the ref resolves to a symlink whose target escapes root", async () => {
  await withTwoTempWorkspaces((root, outside) => {
    const outsideFile = path.join(outside, "report.txt");
    fs.writeFileSync(outsideFile, "Verdict: pass\n", "utf8");
    fs.symlinkSync(outsideFile, path.join(root, "report.txt"));

    assert.throws(
      () => resolveArtifactRef(root, { path: "report.txt", sha256: "0".repeat(64) }),
      ArtifactRefError,
    );
  });
});

// ── replay.ts: verdict regex, dispatch-log parsing ────────────────────────────

test("verdictRegex still matches a markdown-decorated Verdict line", () => {
  assert.ok(verdictRegex("pass").test("**Final Verdict:** PASS"));
});

test("reportHasPassVerdict returns false for a missing report file", () => {
  assert.equal(reportHasPassVerdict("/nonexistent/path/quality-reviewer.report.txt"), false);
});

test("parseDispatchLog returns [] for a missing file and parses rows keyed by header otherwise", async () => {
  await withTempWorkspace((dir) => {
    assert.deepEqual(parseDispatchLog(path.join(dir, "missing.tsv")), []);

    const file = path.join(dir, "dispatch-log.tsv");
    fs.writeFileSync(file, "seq\trole\tcommit_after\n1\timplementer\tabc1234\n", "utf8");
    assert.deepEqual(parseDispatchLog(file), [{ seq: "1", role: "implementer", commit_after: "abc1234" }]);
  });
});

test("deriveImplementerCommits drops pending/none/empty/non-sha placeholders, keeps real SHAs", () => {
  const rows: DispatchLogRow[] = [
    { role: "implementer", commit_after: "e2d9665" },
    { role: "spec-reviewer", commit_after: "e2d9665" },
    { role: "implementer", commit_after: "pending" },
    { role: "implementer", commit_after: "none" },
    { role: "implementer", commit_after: "" },
    { role: "implementer", commit_after: "not-a-sha" },
    { role: "implementer", commit_after: "7918cce2365309a7073b45f3ce93b64473b2e7f2" },
  ];
  assert.deepEqual(
    deriveImplementerCommits(rows),
    ["e2d9665", "7918cce2365309a7073b45f3ce93b64473b2e7f2"],
  );

  const mixed = deriveImplementerCommits([
    { role: "implementer", commit_after: "e2d9665" },
    { role: "implementer", commit_after: "pending" },
    { role: "implementer", commit_after: "7918cce" },
  ]);
  assert.deepEqual(mixed, ["e2d9665", "7918cce"]);
});

// ── replay.ts: report_file resolution, the relocatability fix ────────────────

test("replay reads spec-reviewer evidence from a non-conventional report_file value, stored as a run-relative ArtifactRef", async () => {
  await withTempWorkspace((root) => {
    const attemptDir = path.join(root, "attempt1-artifacts");
    fs.mkdirSync(attemptDir, { recursive: true });
    const customReport = path.join(attemptDir, "nested", "custom-spec-report.txt");
    fs.mkdirSync(path.dirname(customReport), { recursive: true });
    fs.writeFileSync(customReport, "Verdict: pass\n", "utf8");

    writeDispatchLog(attemptDir, [
      { role: "implementer", commit_after: "aabbcc1" },
      { role: "spec-reviewer", report_file: "nested/custom-spec-report.txt" },
    ]);

    const ledger = reconstructLedger(root, {
      taskId: "TEST",
      specPath: null,
      verificationMode: "legacy",
      integrationCommit: null,
      runRoot: root,
    });

    const evidence = ledger.evidence.specReviewer as ReviewerEvidence;
    assert.ok(evidence, "specReviewer evidence must be accreted");
    assert.equal(evidence.verdict, "pass");
    assert.equal(
      evidence.report.path,
      "attempt1-artifacts/nested/custom-spec-report.txt",
      "the stored ref must be run-relative, never the custom absolute path",
    );
    assert.equal(resolveArtifactRef(root, evidence.report), customReport);
  });
});

test("replay falls back to the conventional filename when the dispatch-log report_file column is empty", async () => {
  await withTempWorkspace((root) => {
    const attemptDir = path.join(root, "attempt1-artifacts");
    fs.mkdirSync(attemptDir, { recursive: true });
    const conventional = path.join(attemptDir, "spec-reviewer.report.txt");
    fs.writeFileSync(conventional, "Verdict: pass\n", "utf8");

    writeDispatchLog(attemptDir, [
      { role: "implementer", commit_after: "aabbcc2" },
      { role: "spec-reviewer", report_file: "" },
    ]);

    const ledger = reconstructLedger(root, {
      taskId: "TEST",
      specPath: null,
      verificationMode: "legacy",
      integrationCommit: null,
      runRoot: root,
    });

    const evidence = ledger.evidence.specReviewer as ReviewerEvidence;
    assert.ok(evidence, "specReviewer evidence must be accreted via fallback");
    assert.equal(evidence.report.path, "attempt1-artifacts/spec-reviewer.report.txt");
  });
});

test("an absolute report_file value is unresolvable, never stored as a path, and produces a gap at accept()", async () => {
  await withTempWorkspace((root) => {
    const attemptDir = path.join(root, "attempt1-artifacts");
    fs.mkdirSync(attemptDir, { recursive: true });

    // A conventionally-named, passing report also exists in the same directory,
    // so a silent fallback to it would hide the defect this test targets.
    fs.writeFileSync(path.join(attemptDir, "spec-reviewer.report.txt"), "Verdict: pass\n", "utf8");
    const outsideReport = path.join(root, "outside-report.txt");
    fs.writeFileSync(outsideReport, "Verdict: pass\n", "utf8");

    writeDispatchLog(attemptDir, [
      { role: "implementer", commit_after: "aabbcc3" },
      { role: "spec-reviewer", report_file: outsideReport },
    ]);

    const ledger = reconstructLedger(root, {
      taskId: "TEST",
      specPath: null,
      verificationMode: "legacy",
      integrationCommit: null,
      runRoot: root,
    });

    assert.equal(ledger.evidence.specReviewer, null, "an absolute report_file must never resolve to evidence");

    const result = accept(buildFacts(ledger, { cwd: root, runRoot: root }));
    assert.ok(result.gaps.includes("specReviewer:missing"), "the unresolved reviewer produces a gap, never a silent pass");
  });
});

test("a report_file that is a symlink escaping the run root is rejected, never accreted as forged evidence", async () => {
  await withTwoTempWorkspaces((root, outside) => {
    const attemptDir = path.join(root, "attempt1-artifacts");
    fs.mkdirSync(attemptDir, { recursive: true });

    const forgedReport = path.join(outside, "forged-quality-report.txt");
    fs.writeFileSync(forgedReport, "Verdict: pass\n", "utf8");
    fs.symlinkSync(forgedReport, path.join(attemptDir, "quality-reviewer.report.txt"));

    writeDispatchLog(attemptDir, [
      { role: "implementer", commit_after: "aabbcc5" },
      { role: "quality-reviewer", report_file: "" },
    ]);

    assert.throws(
      () =>
        reconstructLedger(root, {
          taskId: "TEST",
          specPath: null,
          verificationMode: "legacy",
          integrationCommit: null,
          runRoot: root,
        }),
      ArtifactRefError,
      "a report_file symlinked to a target outside the run root must be rejected, not accreted as a pass",
    );
  });
});

// ── git-capture path (commits-since-capture, finalize.mjs steps removed) ──────

test("a reaped attempt whose worker committed is captured as an implementer commit despite no orchestrator contract", async () => {
  await withTempWorkspace((dir) => {
    initRepo(dir);
    const relSpec = "docs/project/tasks/T-cap.md";
    commitFile(dir, relSpec, "---\nstatus: Approved\n---\n\n# Task\n", "seed spec");
    const specPath = path.join(dir, relSpec);

    const reportsDir = path.join(dir, "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    const specReport = path.join(reportsDir, "spec-reviewer.report.txt");
    const qualityReport = path.join(reportsDir, "quality-reviewer.report.txt");
    fs.writeFileSync(specReport, "Verdict: pass\n", "utf8");
    fs.writeFileSync(qualityReport, "Verdict: pass\n", "utf8");

    // Baseline taken once before the attempt; the worker commits to HEAD; the
    // orchestrator emits no contract (reaped), so integrationCommit stays null.
    const baseline = headSha(dir);
    const workerSha = commitFile(dir, "src/feature.txt", "implemented\n", "implement feature");

    const ledger = createLedger({ taskId: "T-cap", specPath, specSha256: null, verificationMode: "legacy" });
    recordEvidence(ledger, "specReviewer", {
      verdict: "pass",
      report: makeArtifactRef(dir, specReport),
      attempt: 1,
    });
    recordEvidence(ledger, "qualityReviewer", {
      verdict: "pass",
      report: makeArtifactRef(dir, qualityReport),
      attempt: 1,
    });
    recordEvidence(ledger, "verification", { status: "pass", mode: "legacy" });

    const captured = commitsSince(baseline, dir).filter(
      (sha) => sha !== (ledger.evidence.integrationCommit as string | null),
    );
    assert.deepEqual(captured, [workerSha], "the worker commit is captured from git despite the lost contract");
    recordEvidence(ledger, "implementerCommits", captured);
    assert.deepEqual(ledger.evidence.implementerCommits, [workerSha]);

    const result = accept(buildFacts(ledger, { cwd: dir, runRoot: dir }));
    assert.equal(result.state, "incomplete");
    assert.deepEqual(
      result.gaps,
      ["status", "integrationCommit:missing"],
      "only the still-open status and integration-commit gaps remain",
    );
  });
});

test("no worker commit yields an empty capture and no spurious acceptance", async () => {
  await withTempWorkspace((dir) => {
    initRepo(dir);
    const relSpec = "docs/project/tasks/T-none.md";
    commitFile(dir, relSpec, "---\nstatus: Approved\n---\n", "seed");
    const specPath = path.join(dir, relSpec);
    const specReport = path.join(dir, "spec.report.txt");
    const qualityReport = path.join(dir, "quality.report.txt");
    fs.writeFileSync(specReport, "Verdict: pass\n", "utf8");
    fs.writeFileSync(qualityReport, "Verdict: pass\n", "utf8");

    const baseline = headSha(dir);
    const captured = commitsSince(baseline, dir);
    assert.deepEqual(captured, [], "nothing committed -> empty capture");

    const ledger = createLedger({ taskId: "T-none", specPath, specSha256: null, verificationMode: "legacy" });
    recordEvidence(ledger, "specReviewer", {
      verdict: "pass",
      report: makeArtifactRef(dir, specReport),
      attempt: 1,
    });
    recordEvidence(ledger, "qualityReviewer", {
      verdict: "pass",
      report: makeArtifactRef(dir, qualityReport),
      attempt: 1,
    });
    recordEvidence(ledger, "verification", { status: "pass", mode: "legacy" });
    if (captured.length > 0) recordEvidence(ledger, "implementerCommits", captured);

    const result = accept(buildFacts(ledger, { cwd: dir, runRoot: dir }));
    assert.equal(result.state, "incomplete", "no commits -> not accepted");
    assert.ok(result.gaps.includes("implementerCommits:empty"), "implementerCommits:empty gates acceptance");
  });
});

// ── frozen fixture: commit identity and cross-attempt accretion ───────────────

test("typed-commit-identity-rejects-placeholder: the fixture repo carries a real, explicit commit identity", () => {
  const output = execFileSync(
    "git",
    ["--git-dir", path.join(FIXTURE_ROOT, "repo.git"), "log", "--all", "--format=%an\t%ae"],
    { encoding: "utf8" },
  ).trim();
  const identities = output.split("\n").map((line) => {
    const [name, email] = line.split("\t");
    return { name, email };
  });

  assert.ok(identities.length > 0, "fixture repo must have commits");
  for (const { name, email } of identities) {
    assert.ok(name && name.trim().length > 0, "commit author name must not be empty");
    assert.ok(email && email.trim().length > 0, "commit author email must not be empty");
    assert.notEqual(name, "Your Name", "commit identity must not be the git placeholder default");
    assert.notEqual(email, "you@example.com", "commit identity must not be the git placeholder default");
  }
});

// ── relocatability: the fixture must resolve identically after it moves ──────

test("replay reconstruction is relocatable: copying the fixture root yields identical evidence, facts, and accept result", async () => {
  await withTwoTempWorkspaces(async (rootA, rootB) => {
    fs.cpSync(FIXTURE_ROOT, rootA, { recursive: true });
    fs.cpSync(FIXTURE_ROOT, rootB, { recursive: true });

    const runA = runReplayPipeline(rootA);
    const runB = runReplayPipeline(rootB);

    assert.deepEqual(
      runA.ledger.evidence,
      runB.ledger.evidence,
      "accreted evidence (including stored ArtifactRefs) must be identical across relocated copies",
    );
    assert.deepEqual(runA.facts, runB.facts, "resolved facts must be identical across relocated copies");
    assert.deepEqual(runA.result, runB.result, "accept() must return the same state and gaps across relocated copies");
    assert.equal(runA.result.state, "accepted", `fixture must accept; gaps: ${JSON.stringify(runA.result.gaps)}`);

    const specEvidence = runA.ledger.evidence.specReviewer as ReviewerEvidence;
    const qualityEvidence = runA.ledger.evidence.qualityReviewer as ReviewerEvidence;
    assert.equal(specEvidence.attempt, 1, "spec-reviewer pass accreted from attempt 1");
    assert.equal(qualityEvidence.attempt, 2, "quality-reviewer pass accreted from attempt 2");
    assert.equal(specEvidence.report.path, "attempt1-artifacts/spec-review-result.txt");
    assert.equal(qualityEvidence.report.path, "attempt2-artifacts/quality-reviewer.report.txt");
  });
});
