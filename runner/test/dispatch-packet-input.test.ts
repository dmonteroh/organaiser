import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { buildDispatchPacketInput, extractBulletSection } from "../src/compile/dispatch-packet-input.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const SAMPLE_BRIEF = [
  "# Sample task",
  "",
  "## Acceptance Criteria",
  "",
  "- First criterion",
  "- Second criterion",
  "",
  "## Verification Commands",
  "",
  "- npm test",
  "- npm run typecheck",
  "",
  "## Stop Condition",
  "",
  "Done once both commands above pass.",
  "",
].join("\n");

test("extractBulletSection recovers a bulleted section's items, trimmed and marker-stripped", () => {
  assert.deepEqual(extractBulletSection(SAMPLE_BRIEF, "Acceptance Criteria"), [
    "First criterion",
    "Second criterion",
  ]);
  assert.deepEqual(extractBulletSection(SAMPLE_BRIEF, "Verification Commands"), [
    "npm test",
    "npm run typecheck",
  ]);
});

test("extractBulletSection returns an empty array when the heading is absent", () => {
  assert.deepEqual(extractBulletSection("# no sections here\n", "Acceptance Criteria"), []);
});

test("buildDispatchPacketInput's implementer branch renders a real, non-empty packet from the task's brief file", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("implement", "implementer");

      assert.match(packet, /- objective: Sample task title/);
      assert.match(packet, /- attemptId: task-a:implement:1/);
      assert.match(packet, /First criterion/);
      assert.match(packet, /Second criterion/);
      assert.match(packet, /npm test/);
      assert.match(packet, /npm run typecheck/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's non-real-packet branch returns runAgentStage's own default placeholder string, byte-for-byte", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("some-stage", "analyst");

      assert.equal(packet, "packet for task task-a at stage some-stage");
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's synthesized attemptId round advances across successive calls for the same task and stage", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const first = packetFn("implement", "implementer");
      assert.match(first, /- attemptId: task-a:implement:1/);

      db.prepare(
        `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, interrupt_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?)`,
      ).run("attempt-1", "run-a", "task-a", "implement", "implementer", 1, "v1", "fake", "fake", "{}", 1, Date.now());

      const second = packetFn("implement", "implementer");
      assert.match(second, /- attemptId: task-a:implement:2/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's implementer branch throws a descriptive error when the task has no brief_path", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: null },
        { db, runId: "run-a", projectRoot: dir },
      );

      assert.throws(() => packetFn("implement", "implementer"), /task-a has no brief_path/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's integrator branch renders a real packet from the task's brief file", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("integration", "integrator");

      assert.match(packet, /- role: integrator/);
      assert.match(packet, /- authorityTier: read-only/);
      assert.match(packet, /- Role file: .*integrator-prompt\.md/);
      assert.match(packet, /First criterion/);
      assert.match(packet, /Second criterion/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's integrator branch degrades to an empty brief instead of throwing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const nullBriefPacketFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: null },
        { db, runId: "run-a", projectRoot: dir },
      );
      const nullBriefPacket = nullBriefPacketFn("integration", "integrator");
      assert.match(nullBriefPacket, /### Input: task-brief \(untrusted\)/);

      const missingFilePacketFn = buildDispatchPacketInput(
        { id: "task-b", title: "Sample task title", briefPath: "does-not-exist.md" },
        { db, runId: "run-a", projectRoot: dir },
      );
      const missingFilePacket = missingFilePacketFn("integration", "integrator");
      assert.match(missingFilePacket, /### Input: task-brief \(untrusted\)/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's spec-reviewer branch renders a real packet with the role's verdict enum", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("review-spec", "spec-reviewer");

      assert.match(packet, /- role: spec-reviewer/);
      assert.match(packet, /- authorityTier: read-only/);
      assert.match(packet, /- Role file: .*spec-reviewer-prompt\.md/);
      assert.match(packet, /First criterion/);
      assert.match(packet, /Second criterion/);
      assert.match(packet, /- verdict: one of pass \| fail \| needs-info/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's code-quality-reviewer branch renders a real packet with the review-quality verdict enum", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("review-quality", "code-quality-reviewer");

      assert.match(packet, /- role: code-quality-reviewer/);
      assert.match(packet, /- authorityTier: read-only/);
      assert.match(packet, /- Role file: .*code-quality-reviewer-prompt\.md/);
      assert.match(packet, /First criterion/);
      assert.match(packet, /Second criterion/);
      assert.match(
        packet,
        /- verdict: one of pass \| needs-info \| fail-with-severity: critical \| fail-with-severity: important/,
      );
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's code-quality-reviewer branch resolves the cross-task-review verdict enum from INTEGRATION_STAGES", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("cross-task-review", "code-quality-reviewer");

      assert.match(
        packet,
        /- verdict: one of pass \| needs-info \| fail-with-severity: critical \| fail-with-severity: important/,
      );
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput threads a non-null priorReport into a reviewer branch's stageInputs as prior-report", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("review-spec", "spec-reviewer", { summary: "distinctive-report-marker-123" });

      assert.match(packet, /<<<UNTRUSTED prior-report/);
      assert.match(packet, /distinctive-report-marker-123/);
      assert.match(packet, /### Canonical Inputs\n- task-brief\n- prior-report/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput omits the prior-report input when priorReport is null", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("review-spec", "spec-reviewer", null);

      assert.doesNotMatch(packet, /prior-report/);
      assert.match(packet, /### Canonical Inputs\n- task-brief\n/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput threads a non-null priorReport into the implementer branch, so fix-spec carries the reviewer's findings", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      fs.writeFileSync(path.join(dir, "brief.md"), SAMPLE_BRIEF);
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("fix-spec", "implementer", {
        verdict: "fail",
        findings: [{ summary: "distinctive-finding-marker-456", severity: "critical" }],
      });

      assert.match(packet, /<<<UNTRUSTED prior-report/);
      assert.match(packet, /distinctive-finding-marker-456/);
      assert.match(packet, /### Canonical Inputs\n- task-brief\n- prior-report/);
    } finally {
      db.close();
    }
  });
});

test("buildDispatchPacketInput's reviewer branch degrades to an empty brief instead of throwing", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const nullBriefPacketFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: null },
        { db, runId: "run-a", projectRoot: dir },
      );
      const nullBriefPacket = nullBriefPacketFn("review-spec", "spec-reviewer");
      assert.match(nullBriefPacket, /### Input: task-brief \(untrusted\)/);

      const missingFilePacketFn = buildDispatchPacketInput(
        { id: "task-b", title: "Sample task title", briefPath: "does-not-exist.md" },
        { db, runId: "run-a", projectRoot: dir },
      );
      const missingFilePacket = missingFilePacketFn("review-spec", "spec-reviewer");
      assert.match(missingFilePacket, /### Input: task-brief \(untrusted\)/);
    } finally {
      db.close();
    }
  });
});
