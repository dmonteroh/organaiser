import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  fileSha256,
  validateArtifacts,
  validateDispatchLog,
  validateRoleBinding,
  validateVerificationFieldCoherence,
  type ArtifactEvidence,
  type RoleFiles,
} from "../src/compile/artifact-validator.ts";
import { CANONICAL_CHECKS } from "../src/compile/report-validator.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function makeRoleFiles(dir: string): RoleFiles {
  const rolesDir = path.join(dir, "roles");
  fs.mkdirSync(rolesDir, { recursive: true });
  const files: RoleFiles = {
    implementer: path.join(rolesDir, "implementer-prompt.md"),
    specReviewer: path.join(rolesDir, "spec-reviewer-prompt.md"),
    qualityReviewer: path.join(rolesDir, "code-quality-reviewer-prompt.md"),
  };
  fs.writeFileSync(
    files.implementer,
    "# Implementer Subagent Prompt (Copy/Paste Template)\n\nImplementer role body.\n",
    "utf8",
  );
  fs.writeFileSync(
    files.specReviewer,
    "# Spec Reviewer Subagent Prompt (Copy/Paste Template)\n\nSpec reviewer role body.\n",
    "utf8",
  );
  fs.writeFileSync(
    files.qualityReviewer,
    "# Code Quality Reviewer Subagent Prompt (Copy/Paste Template)\n\nQuality reviewer role body.\n",
    "utf8",
  );
  return files;
}

function writePacket(dir: string, role: string, roleFile: string): string {
  const sha = fileSha256(roleFile);
  const heading = fs
    .readFileSync(roleFile, "utf8")
    .split(/\r?\n/)
    .find((line) => line.startsWith("#"));
  const packet = path.join(dir, `${role}.packet.txt`);
  fs.writeFileSync(
    packet,
    `Role: ${role}\nRole file: ${roleFile}\nRole sha256: ${sha}\n\n${heading}\n\nRole body content.\n`,
    "utf8",
  );
  return packet;
}

function writeRolePackets(dir: string, roles: RoleFiles): RoleFiles {
  return {
    implementer: writePacket(dir, "implementer", roles.implementer),
    specReviewer: writePacket(dir, "spec-reviewer", roles.specReviewer),
    qualityReviewer: writePacket(dir, "quality-reviewer", roles.qualityReviewer),
  };
}

function buildAttemptFixture(dir: string): { attempt1: string; attempt3: string } {
  const attempt1 = path.join(dir, "attempt1-artifacts");
  const attempt3 = path.join(dir, "attempt3-artifacts");
  fs.mkdirSync(attempt1, { recursive: true });
  fs.mkdirSync(attempt3, { recursive: true });
  fs.writeFileSync(path.join(attempt1, "implementer.report.txt"), "Implementation complete.\n", "utf8");
  fs.writeFileSync(path.join(attempt1, "spec-reviewer.report.txt"), "Verdict: pass\n", "utf8");
  fs.writeFileSync(path.join(attempt3, "quality-reviewer.report.txt"), "Verdict: pass\n", "utf8");
  fs.writeFileSync(
    path.join(attempt1, "dispatch-log.tsv"),
    [
      "seq\trole\treason\tcommit_before\tcommit_after\tpacket_file\treport_file",
      "1\timplementer\tinitial attempt\tabc0001\tabc0002\timplementer.packet.txt\timplementer.report.txt",
      "2\timplementer\trework\tabc0002\tabc0003\timplementer.packet.txt\timplementer.report.txt",
      "3\timplementer\trework\tabc0003\tabc0004\timplementer.packet.txt\timplementer.report.txt",
      "4\tspec-reviewer\treview\tabc0004\tabc0004\tspec-reviewer.packet.txt\tspec-reviewer.report.txt\n",
    ].join("\n"),
    "utf8",
  );
  return { attempt1, attempt3 };
}

function fixtureEvidence(
  packets: RoleFiles,
  attempt: { attempt1: string; attempt3: string },
): ArtifactEvidence {
  return {
    packets,
    reports: {
      implementer: path.join(attempt.attempt1, "implementer.report.txt"),
      specReviewer: path.join(attempt.attempt1, "spec-reviewer.report.txt"),
      qualityReviewer: path.join(attempt.attempt3, "quality-reviewer.report.txt"),
    },
    dispatchLog: path.join(attempt.attempt1, "dispatch-log.tsv"),
  };
}

function declaredContract(statuses: Record<string, string>): Record<string, unknown> {
  const c: Record<string, unknown> = { VERIFICATION_MODE: "declared" };
  for (const id of CANONICAL_CHECKS) {
    const upper = id.toUpperCase();
    c[`TASK_VERIFY_${upper}_STATUS`] = statuses[id];
    c[`FINAL_VERIFY_${upper}_STATUS`] = statuses[id];
  }
  return c;
}

const LEGACY_PASS = { VERIFICATION_MODE: "legacy", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" };

function writeTranscript(dir: string, label: string, { empty = false }: { empty?: boolean } = {}): string {
  const file = path.join(dir, `${label}.transcript.txt`);
  fs.writeFileSync(file, empty ? "" : "raw worker stdout/stderr\n", "utf8");
  return file;
}

test("role-SHA binding validates freshly built implementer/spec/quality role packets", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    assert.ok(validateRoleBinding("implementer", packets.implementer, roles.implementer).ok);
    assert.ok(validateRoleBinding("spec-reviewer", packets.specReviewer, roles.specReviewer).ok);
    assert.ok(validateRoleBinding("quality-reviewer", packets.qualityReviewer, roles.qualityReviewer).ok);
  });
});

test("role-SHA binding fails when the packet sha does not match the role file", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const r = validateRoleBinding("spec-reviewer", packets.specReviewer, roles.implementer);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /role file\/sha256 binding/);
  });
});

test("role-SHA binding fails when the role body is stripped to a one-line label", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const roleFile = roles.specReviewer;
    const sha = fileSha256(roleFile);
    const packet = path.join(dir, "spec-reviewer.packet.txt");
    fs.writeFileSync(packet, `Role: spec-reviewer\nRole file: ${roleFile}\nRole sha256: ${sha}\n`, "utf8");
    const r = validateRoleBinding("spec-reviewer", packet, roleFile);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /missing required role body content/);
  });
});

test("role-SHA binding returns a failing result (not a throw) for a missing role file", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const missingRoleFile = path.join(dir, "nonexistent-role-file.md");
    assert.ok(!fs.existsSync(missingRoleFile), "precondition: role file must not exist");
    let r: ReturnType<typeof validateRoleBinding> | undefined;
    assert.doesNotThrow(() => {
      r = validateRoleBinding("spec-reviewer", packets.specReviewer, missingRoleFile);
    });
    assert.equal(r?.ok, false);
    assert.match(r?.reason ?? "", /role file is unreadable/);
  });
});

test("role-SHA binding allows an implementer reuse packet to omit the role body", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const roleFile = roles.implementer;
    const sha = fileSha256(roleFile);
    const packet = path.join(dir, "implementer.packet.txt");
    fs.writeFileSync(
      packet,
      `Role: implementer\nRole file: ${roleFile}\nRole sha256: ${sha}\nImplementation was completed and committed in prior attempt 1.\n`,
      "utf8",
    );
    const r = validateRoleBinding("implementer", packet, roleFile);
    assert.ok(r.ok, r.reason ?? "");
  });
});

test("dispatch count is derived from dispatch-log rows (fixture attempt1 has 4 worker rows)", () => {
  return withTempWorkspace((dir) => {
    const { attempt1 } = buildAttemptFixture(dir);
    const r = validateDispatchLog(path.join(attempt1, "dispatch-log.tsv"));
    assert.ok(r.ok, r.reason ?? "");
    assert.equal(r.dispatchCount, 4);
  });
});

test("dispatch-log validation rejects a malformed header", () => {
  return withTempWorkspace((dir) => {
    const f = path.join(dir, "dispatch-log.tsv");
    fs.writeFileSync(f, "wrong\theader\n1\timplementer\tx\ta\tb\tc\td\n", "utf8");
    const r = validateDispatchLog(f);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /header is invalid/);
  });
});

test("dispatch-log validation rejects an invalid role", () => {
  return withTempWorkspace((dir) => {
    const f = path.join(dir, "dispatch-log.tsv");
    fs.writeFileSync(
      f,
      "seq\trole\treason\tcommit_before\tcommit_after\tpacket_file\treport_file\n1\tbogus\tx\ta\tb\tc\td\n",
      "utf8",
    );
    const r = validateDispatchLog(f);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /role is invalid/);
  });
});

test("verification field coherence rejects reported-mode drift from task mode", () => {
  const r = validateVerificationFieldCoherence({ VERIFICATION_MODE: "declared" }, "legacy");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /drifted from task-declared mode/);
});

test("verification field coherence rejects coarse fields in declared mode (invalid-mixed)", () => {
  const c = declaredContract({ build: "pass", typecheck: "pass", test: "pass", lint: "pass" });
  c.TASK_VERIFY_STATUS = "pass";
  const r = validateVerificationFieldCoherence(c, "declared");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /coexist with declared/);
});

test("verification field coherence rejects per-check fields in legacy mode (invalid-mixed)", () => {
  const c = {
    VERIFICATION_MODE: "legacy",
    TASK_VERIFY_STATUS: "pass",
    FINAL_VERIFY_STATUS: "pass",
    TASK_VERIFY_BUILD_STATUS: "pass",
  };
  const r = validateVerificationFieldCoherence(c, "legacy");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /without a declared gate section/);
});

test("verification field coherence rejects an invalid-mixed task mode outright", () => {
  const r = validateVerificationFieldCoherence({ VERIFICATION_MODE: "declared" }, "invalid-mixed");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /invalid-mixed/);
});

test("verification field coherence accepts a coherent legacy contract", () => {
  const r = validateVerificationFieldCoherence(
    { VERIFICATION_MODE: "legacy", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" },
    "legacy",
  );
  assert.ok(r.ok);
});

test("verification field coherence accepts a coherent declared contract", () => {
  const c = declaredContract({ build: "pass", typecheck: "pass", test: "pass", lint: "pass" });
  c.VERIFICATION_MODE = "declared";
  const r = validateVerificationFieldCoherence(c, "declared");
  assert.ok(r.ok, r.reason ?? "");
});

test("validateArtifacts is accretion-aware: report/dispatch evidence spans attempt1 + attempt3", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence = fixtureEvidence(packets, attempt);
    const contract = { VERIFICATION_MODE: "legacy", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" };
    const result = validateArtifacts({ evidence, roles, contract, taskMode: "legacy" });
    assert.deepEqual(result.gaps, [], "no gaps expected for fresh role packets + fixture reports");
    assert.equal(result.ok, true);
    assert.equal(result.dispatchCount, 4);
  });
});

test("validateArtifacts: omitting transcript paths never produces a GAP (advisory, not a gate)", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence = fixtureEvidence(packets, attempt);
    const result = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.ok(
      !result.gaps.some((g) => /transcript/.test(g)),
      `transcript must never be a gap; got: ${JSON.stringify(result.gaps)}`,
    );
    assert.equal(result.ok, true, `gate must pass; gaps: ${JSON.stringify(result.gaps)}`);
    assert.ok(
      result.warnings.some((w) => /^transcript:missing:implementer:/.test(w)),
      `expected an implementer transcript warning; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      result.warnings.some((w) => /^transcript:missing:spec-reviewer:/.test(w)),
      `expected a spec-reviewer transcript warning; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(
      !result.warnings.some((w) => /quality-reviewer/.test(w)),
      `non-dispatched quality-reviewer must not warn; got: ${JSON.stringify(result.warnings)}`,
    );
  });
});

test("validateArtifacts: a dispatched role with a MISSING transcript warns but still passes", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence: ArtifactEvidence = {
      ...fixtureEvidence(packets, attempt),
      transcripts: { implementer: path.join(dir, "nonexistent", "implementer.transcript.txt") },
    };
    const result = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.ok(
      result.warnings.some((w) => w === `transcript:missing:implementer:${evidence.transcripts?.implementer}`),
      `expected the missing-transcript warning with the path; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.ok(!result.gaps.some((g) => /transcript/.test(g)), "transcript is never a gap");
    assert.equal(result.ok, true, "attempt still passes (advisory)");
  });
});

test("validateArtifacts: a dispatched role with an EMPTY (zero-length) transcript warns", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const empty = writeTranscript(dir, "implementer", { empty: true });
    const evidence: ArtifactEvidence = { ...fixtureEvidence(packets, attempt), transcripts: { implementer: empty } };
    const result = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.ok(
      result.warnings.some((w) => w === `transcript:empty:implementer:${empty}`),
      `expected an empty-transcript warning; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.ok, true);
  });
});

test("validateArtifacts: a dispatched role with a NON-EMPTY present transcript produces no warning", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence: ArtifactEvidence = {
      ...fixtureEvidence(packets, attempt),
      transcripts: {
        implementer: writeTranscript(dir, "implementer"),
        specReviewer: writeTranscript(dir, "spec-reviewer"),
      },
    };
    const result = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.deepEqual(result.warnings, [], `no transcript warnings expected; got: ${JSON.stringify(result.warnings)}`);
    assert.equal(result.ok, true);
  });
});

test("validateArtifacts: a NOT-dispatched role (reuse/no-dispatch) is never checked or warned, even with no transcript", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const implOnlyLog = path.join(dir, "dispatch-log-impl-only.tsv");
    fs.writeFileSync(
      implOnlyLog,
      "seq\trole\treason\tcommit_before\tcommit_after\tpacket_file\treport_file\n1\timplementer\tx\ta\tb\tc\td\n",
      "utf8",
    );
    const evidence: ArtifactEvidence = {
      ...fixtureEvidence(packets, attempt),
      dispatchLog: implOnlyLog,
      transcripts: { implementer: writeTranscript(dir, "implementer") },
    };
    const result = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.deepEqual(
      result.warnings,
      [],
      `only-implementer-dispatched + implementer transcript present -> no warnings; got: ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(result.ok, true);
  });
});

test("validateArtifacts: MUTATION GUARD - flipping the dispatched-role check off would drop the warnings the above cases assert", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence = fixtureEvidence(packets, attempt);
    const result = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.ok(result.warnings.length >= 2, `the check must produce warnings; got: ${JSON.stringify(result.warnings)}`);
  });
});

test("validateArtifacts surfaces a roleBinding gap when a packet has the wrong sha", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const fakePacket = path.join(dir, "spec-reviewer-fake.packet.txt");
    fs.writeFileSync(fakePacket, "Role file: /wrong/path\nRole sha256: deadbeef\n", "utf8");
    const evidence: ArtifactEvidence = {
      ...fixtureEvidence(packets, attempt),
      packets: {
        implementer: packets.implementer,
        specReviewer: fakePacket,
        qualityReviewer: packets.qualityReviewer,
      },
    };
    const contract = { VERIFICATION_MODE: "legacy", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" };
    const result = validateArtifacts({ evidence, roles, contract, taskMode: "legacy" });
    assert.ok(
      result.gaps.some((g) => g.startsWith("roleBinding:")),
      `expected a roleBinding: gap; got: ${JSON.stringify(result.gaps)}`,
    );
  });
});

test("validateArtifacts surfaces a dispatchLog gap when the dispatch log is missing", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence: ArtifactEvidence = {
      ...fixtureEvidence(packets, attempt),
      dispatchLog: path.join(dir, "nonexistent", "dispatch-log.tsv"),
    };
    const contract = { VERIFICATION_MODE: "legacy", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" };
    const result = validateArtifacts({ evidence, roles, contract, taskMode: "legacy" });
    assert.ok(
      result.gaps.some((g) => g.startsWith("artifact:missing:dispatch log") || g.startsWith("dispatchLog:")),
      `expected a dispatchLog or artifact:missing gap; got: ${JSON.stringify(result.gaps)}`,
    );
  });
});

test("validateArtifacts: a header-only dispatch log gates by default but is exempt on verified no-op reuse", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const headerOnly = path.join(dir, "dispatch-log-header-only.tsv");
    fs.writeFileSync(
      headerOnly,
      "seq\trole\treason\tcommit_before\tcommit_after\tpacket_file\treport_file\n",
      "utf8",
    );
    const evidence: ArtifactEvidence = { ...fixtureEvidence(packets, attempt), dispatchLog: headerOnly };

    const gated = validateArtifacts({ evidence, roles, contract: LEGACY_PASS, taskMode: "legacy" });
    assert.ok(
      gated.gaps.includes("dispatchLog:dispatch log is missing worker rows"),
      `expected the empty-log gap by default; got: ${JSON.stringify(gated.gaps)}`,
    );

    const exempt = validateArtifacts({
      evidence,
      roles,
      contract: LEGACY_PASS,
      taskMode: "legacy",
      allowEmptyDispatchLog: true,
    });
    assert.ok(
      !exempt.gaps.some((g) => g.startsWith("dispatchLog:")),
      `reuse must not produce a dispatchLog gap; got: ${JSON.stringify(exempt.gaps)}`,
    );
    assert.equal(exempt.ok, true);

    const badHeader = path.join(dir, "dispatch-log-bad.tsv");
    fs.writeFileSync(badHeader, "not\ta\tvalid\theader\trow\there\tnope\n", "utf8");
    const stillGated = validateArtifacts({
      evidence: { ...fixtureEvidence(packets, attempt), dispatchLog: badHeader },
      roles,
      contract: LEGACY_PASS,
      taskMode: "legacy",
      allowEmptyDispatchLog: true,
    });
    assert.ok(
      stillGated.gaps.some((g) => g.startsWith("dispatchLog:")),
      `a malformed log must still gate even on reuse; got: ${JSON.stringify(stillGated.gaps)}`,
    );
  });
});

test("validateArtifacts surfaces a verificationFields gap when the reported mode drifts from task mode", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence = fixtureEvidence(packets, attempt);
    const contract = { VERIFICATION_MODE: "declared", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" };
    const result = validateArtifacts({ evidence, roles, contract, taskMode: "legacy" });
    assert.ok(
      result.gaps.some((g) => g.startsWith("verificationFields:")),
      `expected a verificationFields: gap; got: ${JSON.stringify(result.gaps)}`,
    );
  });
});

test("validateArtifacts reports a gap for a missing artifact path", () => {
  return withTempWorkspace((dir) => {
    const roles = makeRoleFiles(dir);
    const packets = writeRolePackets(dir, roles);
    const attempt = buildAttemptFixture(dir);
    const evidence = fixtureEvidence(packets, attempt);
    evidence.reports.implementer = path.join(dir, "nonexistent", "implementer.report.txt");
    const contract = { VERIFICATION_MODE: "legacy", TASK_VERIFY_STATUS: "pass", FINAL_VERIFY_STATUS: "pass" };
    const result = validateArtifacts({ evidence, roles, contract, taskMode: "legacy" });
    assert.equal(result.ok, false);
    assert.ok(result.gaps.some((g) => /implementer report/.test(g)));
  });
});
