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

test("buildDispatchPacketInput's non-implementer branch returns runAgentStage's own default placeholder string, byte-for-byte", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const packetFn = buildDispatchPacketInput(
        { id: "task-a", title: "Sample task title", briefPath: "brief.md" },
        { db, runId: "run-a", projectRoot: dir },
      );

      const packet = packetFn("review-spec", "spec-reviewer");

      assert.equal(packet, "packet for task task-a at stage review-spec");
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
