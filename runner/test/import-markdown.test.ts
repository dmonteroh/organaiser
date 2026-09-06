import assert from "node:assert/strict";
import test from "node:test";

import { importMarkdown, ImportMarkdownError } from "../src/board/import-markdown.ts";

const TASKS_HEADER = "| Id | Title | Brief | Status | Depends on | Parallel | Claims | Branch |";
const TASKS_SEP = "| --- | --- | --- | --- | --- | --- | --- | --- |";
const DECISIONS_HEADER = "| Id | Decision | Status |";
const DECISIONS_SEP = "| --- | --- | --- |";

function taskRow(overrides: Partial<{
  id: string;
  title: string;
  brief: string;
  status: string;
  dependsOn: string;
  parallel: string;
  claims: string;
  branch: string;
}> = {}): string {
  const row = {
    id: "P1",
    title: "Do the thing",
    brief: "05-briefs/P1-thing.md",
    status: "drafted",
    dependsOn: "none",
    parallel: "no",
    claims: "none",
    branch: "",
    ...overrides,
  };
  return `| ${row.id} | ${row.title} | ${row.brief} | ${row.status} | ${row.dependsOn} | ${row.parallel} | ${row.claims} | ${row.branch} |`;
}

function tasksTable(rows: string[]): string {
  return [TASKS_HEADER, TASKS_SEP, ...rows].join("\n");
}

function decisionsTable(): string {
  return [DECISIONS_HEADER, DECISIONS_SEP, "| Q1 | Some decision | `confirmed` |"].join("\n");
}

function outputPathFor(name: string): string {
  return `/tmp/does-not-need-to-exist/${name}.json`;
}

test("happy path: each accepted Status value maps to the documented entry/enabled pair", () => {
  const statuses: Array<[string, { enabled: boolean; workflowId: string; stageId: string }]> = [
    ["drafted", { enabled: true, workflowId: "task-refinement", stageId: "analyst-initial" }],
    ["refining", { enabled: true, workflowId: "task-refinement", stageId: "analyst-initial" }],
    ["implementation-ready", { enabled: true, workflowId: "dev-workflow", stageId: "implement" }],
    ["in-progress", { enabled: true, workflowId: "dev-workflow", stageId: "implement" }],
    ["running", { enabled: true, workflowId: "dev-workflow", stageId: "implement" }],
    ["blocked", { enabled: false, workflowId: "dev-workflow", stageId: "implement" }],
    ["in-review", { enabled: false, workflowId: "dev-workflow", stageId: "implement" }],
    ["parked", { enabled: false, workflowId: "dev-workflow", stageId: "implement" }],
    ["umbrella", { enabled: false, workflowId: "dev-workflow", stageId: "implement" }],
    ["integrated", { enabled: false, workflowId: "dev-workflow", stageId: "implement" }],
    ["superseded", { enabled: false, workflowId: "dev-workflow", stageId: "implement" }],
  ];

  for (const [status, expected] of statuses) {
    const md = tasksTable([taskRow({ id: `P-${status}`, status })]);
    const { board } = importMarkdown(md, outputPathFor("b"));
    const task = board.spec.tasks[0] as unknown as {
      id: string;
      enabled: boolean;
      entry: { workflowId: string; stageId: string };
    };
    assert.equal(task.enabled, expected.enabled, `status ${status}`);
    assert.equal(task.entry.workflowId, expected.workflowId, `status ${status}`);
    assert.equal(task.entry.stageId, expected.stageId, `status ${status}`);
  }
});

test("in-progress and running each emit the mandatory dead-process uncertainty", () => {
  for (const status of ["in-progress", "running"]) {
    const md = tasksTable([taskRow({ id: "P4", status })]);
    const { uncertainties } = importMarkdown(md, outputPathFor("b"));
    assert.ok(
      uncertainties.some((u) => /no live process at import time; re-entered fresh/.test(u) && u.includes("P4")),
      `expected dead-process uncertainty for ${status}`,
    );
  }
});

test("blocked, in-review, parked, and umbrella each emit their documented disabled-reason uncertainty", () => {
  const expectations: Record<string, RegExp> = {
    blocked: /blocked on an unresolved dependency\/decision; no confident entry stage, disabled/,
    "in-review": /ambiguous whether spec-review or quality-review; disabled/,
    parked: /awaiting operator; no confident entry stage, disabled/,
    umbrella: /parent\/umbrella row, not directly dispatchable; disabled/,
  };
  for (const [status, pattern] of Object.entries(expectations)) {
    const md = tasksTable([taskRow({ id: "P5", status })]);
    const { uncertainties } = importMarkdown(md, outputPathFor("b"));
    assert.ok(uncertainties.some((u) => pattern.test(u) && u.includes("P5")), `status ${status}`);
  }
});

test("integrated and superseded require no uncertainty beyond the mandatory defaults", () => {
  for (const status of ["integrated", "superseded"]) {
    const md = tasksTable([taskRow({ id: "P6", status })]);
    const { uncertainties } = importMarkdown(md, outputPathFor("b"));
    assert.equal(uncertainties.length, 3);
    assert.ok(uncertainties.every((u) => /priority defaulted|verification defaulted|requiredWorkflowVersions defaulted/.test(u)));
  }
});

test("an unrecognized Status value refuses the whole import, citing row id and raw value", () => {
  const md = tasksTable([taskRow({ id: "P9", status: "mystery-status" })]);
  assert.throws(
    () => importMarkdown(md, outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /P9/.test(err.message) && /mystery-status/.test(err.message),
  );
});

test("dependencies split on comma and trim; 'none' (case-insensitive) maps to []", () => {
  const md = tasksTable([
    taskRow({ id: "P1", dependsOn: "none" }),
    taskRow({ id: "P2", dependsOn: "NoNe", status: "implementation-ready" }),
    taskRow({ id: "P3", dependsOn: "P1, P2", status: "implementation-ready" }),
  ]);
  const { board } = importMarkdown(md, outputPathFor("b"));
  const byId = new Map(board.spec.tasks.map((t) => [t.id, t]));
  assert.deepEqual(byId.get("P1")?.dependencies, []);
  assert.deepEqual(byId.get("P2")?.dependencies, []);
  assert.deepEqual(byId.get("P3")?.dependencies, ["P1", "P2"]);
});

test("claims: empty/none/unknown map to the 'unknown' literal", () => {
  for (const claims of ["", "none", "NONE", "unknown", "Unknown"]) {
    const md = tasksTable([taskRow({ id: "P1", claims })]);
    const { board } = importMarkdown(md, outputPathFor("b"));
    assert.equal(board.spec.tasks[0]?.claims, "unknown");
  }
});

test("claims: comma-split, trimmed, trailing parenthetical annotation stripped per part", () => {
  const md = tasksTable([
    taskRow({
      id: "P1",
      claims: "runner/src/engine/scheduler.ts (four named regions), runner/src/cli/commands.ts",
    }),
  ]);
  const { board } = importMarkdown(md, outputPathFor("b"));
  assert.deepEqual(board.spec.tasks[0]?.claims, {
    files: ["runner/src/engine/scheduler.ts", "runner/src/cli/commands.ts"],
    nonFile: [],
  });
});

test("priority, verification, requiredWorkflowVersions default with a mandatory uncertainty naming the row", () => {
  const md = tasksTable([taskRow({ id: "P1" }), taskRow({ id: "P2", status: "implementation-ready" })]);
  const { board, uncertainties } = importMarkdown(md, outputPathFor("b"));
  const byId = new Map(board.spec.tasks.map((t) => [t.id, t]));
  assert.equal(byId.get("P1")?.priority, 100);
  assert.equal(byId.get("P2")?.priority, 200);
  for (const task of board.spec.tasks) {
    assert.deepEqual(task.verification, []);
    assert.deepEqual(task.requiredWorkflowVersions, {});
  }
  assert.ok(uncertainties.some((u) => u === "task P1: priority defaulted to 100 (no source column)"));
  assert.ok(uncertainties.some((u) => u === "task P2: priority defaulted to 200 (no source column)"));
  assert.ok(uncertainties.some((u) => u === "task P1: verification defaulted to [] (no source column)"));
  assert.ok(uncertainties.some((u) => u === "task P1: requiredWorkflowVersions defaulted to {} (no source column)"));
});

test("zero Tasks tables refuses", () => {
  assert.throws(
    () => importMarkdown(decisionsTable(), outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /found 0/.test(err.message),
  );
});

test("more than one Tasks table refuses", () => {
  const md = [tasksTable([taskRow({ id: "P1" })]), "", tasksTable([taskRow({ id: "P2" })])].join("\n");
  assert.throws(
    () => importMarkdown(md, outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /found 2/.test(err.message),
  );
});

test("a Decisions table alongside one Tasks table is skipped with a non-blocking uncertainty; Tasks still imports", () => {
  const md = [decisionsTable(), "", tasksTable([taskRow({ id: "P1" })])].join("\n\n");
  const { board, uncertainties } = importMarkdown(md, outputPathFor("b"));
  assert.equal(board.spec.tasks.length, 1);
  assert.ok(uncertainties.some((u) => /skipped table/.test(u) && /Decision/.test(u)));
});

test("duplicate task id refuses", () => {
  const md = tasksTable([taskRow({ id: "P1" }), taskRow({ id: "P1", status: "implementation-ready" })]);
  assert.throws(
    () => importMarkdown(md, outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /duplicate task id: P1/.test(err.message),
  );
});

test("a dependency cycle refuses", () => {
  const md = tasksTable([
    taskRow({ id: "P1", dependsOn: "P2", status: "implementation-ready" }),
    taskRow({ id: "P2", dependsOn: "P1", status: "implementation-ready" }),
  ]);
  assert.throws(
    () => importMarkdown(md, outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /cycle/.test(err.message),
  );
});

test("importer-refuses-dead-running: in-progress and running are never marked complete, omitted, or given a liveness field", () => {
  for (const status of ["in-progress", "running"]) {
    const md = tasksTable([taskRow({ id: "P4", status })]);
    const { board } = importMarkdown(md, outputPathFor("b"));
    assert.equal(board.spec.tasks.length, 1);
    const task = board.spec.tasks[0] as unknown as {
      enabled: boolean;
      entry: { workflowId: string; stageId: string };
    };
    assert.equal(task.enabled, true);
    assert.deepEqual(task.entry, { workflowId: "dev-workflow", stageId: "implement" });
    assert.deepEqual(Object.keys(task).sort(), [
      "briefPath",
      "claims",
      "dependencies",
      "enabled",
      "entry",
      "id",
      "priority",
      "requiredWorkflowVersions",
      "title",
      "verification",
    ]);
  }
});

test("metadata.id is the --output basename with its extension stripped", () => {
  const md = tasksTable([taskRow({ id: "P1" })]);
  const { board } = importMarkdown(md, "/some/dir/imported.json");
  assert.equal(board.metadata.id, "imported");
  assert.equal(board.metadata.contractVersion, "1.0.0");
  assert.equal(board.apiVersion, "ai-workflows.dev/v1alpha1");
  assert.equal(board.kind, "Board");
});

test("metadata.id falls back to imported-board when the basename strips to empty", () => {
  const md = tasksTable([taskRow({ id: "P1" })]);
  const { board } = importMarkdown(md, "");
  assert.equal(board.metadata.id, "imported-board");
});

test("schema validation refuses an assembled board before any write: zero data rows violates spec.tasks minItems", () => {
  const md = tasksTable([]);
  assert.throws(
    () => importMarkdown(md, outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /schema validation/.test(err.message),
  );
});
