import assert from "node:assert/strict";
import test from "node:test";

import { serializeBoardSnapshot } from "../evals/board-yaml.ts";

test("board-yaml: a null snapshot serializes to run: null and tasks: []", () => {
  const yaml = serializeBoardSnapshot(null);
  assert.equal(yaml, "run: null\ntasks: []\n");
});

test("board-yaml: an undefined run and empty tasks array serialize to the same empty forms", () => {
  const yaml = serializeBoardSnapshot({ run: undefined, tasks: [] });
  assert.equal(yaml, "run: null\ntasks: []\n");
});

test("board-yaml: a populated run renders as a block mapping under run:", () => {
  const yaml = serializeBoardSnapshot({
    run: { id: "run-1", state: "active", started_at: 100 },
    tasks: [],
  });
  assert.equal(yaml, "run:\n  id: run-1\n  state: active\n  started_at: 100\ntasks: []\n");
});

test("board-yaml: tasks render as a block sequence of block mappings, one per row", () => {
  const yaml = serializeBoardSnapshot({
    run: undefined,
    tasks: [
      { id: "t1", task_key: "k1", priority: 0 },
      { id: "t2", task_key: "k2", priority: 1 },
    ],
  });
  assert.equal(
    yaml,
    "run: null\ntasks:\n  - id: t1\n    task_key: k1\n    priority: 0\n  - id: t2\n    task_key: k2\n    priority: 1\n",
  );
});

test("board-yaml: a depends_on JSON-encoded array with embedded quotes is quoted and escaped (AC3)", () => {
  const dependsOn = JSON.stringify(["task-a", "task-b"]);
  const yaml = serializeBoardSnapshot({
    run: undefined,
    tasks: [{ id: "t1", depends_on: dependsOn }],
  });
  const expectedScalar = `"${dependsOn.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  assert.ok(
    yaml.includes(`depends_on: ${expectedScalar}`),
    `expected escaped depends_on scalar in:\n${yaml}`,
  );
});

test("board-yaml: a config_snapshot_ref value with both a colon and quotes escapes correctly (AC3)", () => {
  const value = 'ref:"abc"';
  const yaml = serializeBoardSnapshot({
    run: { id: "run-1", config_snapshot_ref: value },
    tasks: [],
  });
  assert.ok(yaml.includes('config_snapshot_ref: "ref:\\"abc\\""'), yaml);
});

test("board-yaml: an empty string scalar renders quoted-empty", () => {
  const yaml = serializeBoardSnapshot({ run: { id: "" }, tasks: [] });
  assert.ok(yaml.includes('id: ""'), yaml);
});

test("board-yaml: a newline in a value renders as the two-character \\n escape", () => {
  const yaml = serializeBoardSnapshot({ run: { title: "HEAD abc\nclean" }, tasks: [] });
  assert.ok(yaml.includes('title: "HEAD abc\\nclean"'), yaml);
});

test("board-yaml: null and numeric task columns render as bare literals", () => {
  const yaml = serializeBoardSnapshot({
    run: undefined,
    tasks: [{ id: "t1", stage_id: null, priority: 3 }],
  });
  assert.ok(yaml.includes("stage_id: null"), yaml);
  assert.ok(yaml.includes("priority: 3"), yaml);
});
