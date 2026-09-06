import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importMarkdown, ImportMarkdownError } from "../src/board/import-markdown.ts";
import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import type { Io } from "../src/cli/commands.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const REAL_BOARD_FIXTURE = new URL("./fixtures/import-markdown/task-board.md", import.meta.url);

function fakeIo(dir: string): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => dir,
    now: () => Date.now(),
    env: {},
  };
}

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

test("a bare Status token followed by non-parenthetical free text emits the exact status-annotation uncertainty", () => {
  const md = tasksTable([taskRow({ id: "P1", status: "drafted needs another look" })]);
  const { uncertainties } = importMarkdown(md, outputPathFor("b"));
  assert.ok(uncertainties.includes(`task P1: status annotation ignored: "needs another look"`));
});

test("a backtick-wrapped Status token outside the vocabulary still refuses, quoting the extracted token", () => {
  const md = tasksTable([taskRow({ id: "P9", status: "`mystery-status`" })]);
  assert.throws(
    () => importMarkdown(md, outputPathFor("b")),
    (err: unknown) => err instanceof ImportMarkdownError && /P9/.test(err.message) && /"mystery-status"/.test(err.message),
  );
});

test("a Claims cell whose every part is shape D maps to 'unknown' with the exact cell-level uncertainty", () => {
  const md = tasksTable([taskRow({ id: "P1", claims: "some vague thing, another vague thing" })]);
  const { board, uncertainties } = importMarkdown(md, outputPathFor("b"));
  assert.equal(board.spec.tasks[0]?.claims, "unknown");
  assert.ok(
    uncertainties.includes(
      `task P1: claims cell "some vague thing, another vague thing" yielded no file claim; claims recorded as unknown`,
    ),
  );
  assert.ok(uncertainties.includes(`task P1: claims part "some vague thing" has no backticked path; dropped`));
  assert.ok(uncertainties.includes(`task P1: claims part "another vague thing" has no backticked path; dropped`));
});

test("a Claims part whose trailing parenthetical itself contains a backtick span keeps every backticked path", () => {
  const claimsPart = "`foo/bar.ts` (see `baz/qux.ts`)";
  const md = tasksTable([taskRow({ id: "P1", claims: claimsPart })]);
  const { board, uncertainties } = importMarkdown(md, outputPathFor("b"));
  assert.deepEqual(board.spec.tasks[0]?.claims, {
    files: ["foo/bar.ts", "baz/qux.ts"],
    nonFile: [],
  });
  assert.ok(
    uncertainties.includes(
      `task P1: claims part "${claimsPart}" mixes prose with backticked paths; kept only the backticked paths`,
    ),
  );
});

function readTasksTableRows(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === TASKS_HEADER);
  assert.notEqual(headerIndex, -1, "Tasks table header not found in fixture");
  const rows: string[][] = [];
  let i = headerIndex + 2;
  while (i < lines.length) {
    const trimmed = (lines[i] as string).trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) break;
    rows.push(
      trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
    i++;
  }
  return rows;
}

function backtickSpansOf(cell: string): string[] {
  return Array.from(cell.matchAll(/`([^`]+)`/g)).map((match) => match[1] as string);
}

function claimsFilesFor(
  tasks: readonly { id: string; claims: "unknown" | { files: string[]; nonFile: string[] } }[],
  id: string,
): string[] {
  const claims = tasks.find((task) => task.id === id)?.claims;
  assert.ok(claims && claims !== "unknown", `expected ${id} to have file claims`);
  return (claims as { files: string[] }).files;
}

function assertRowClaims(
  rows: readonly string[][],
  tasks: readonly { id: string; claims: "unknown" | { files: string[]; nonFile: string[] } }[],
  id: string,
  quotedCell: string,
  expectedFiles: readonly string[],
): void {
  const row = rows.find((r) => r[0] === id);
  assert.ok(row, `row ${id} not found in fixture`);
  const cell = (row as string[])[6] ?? "";
  const files = claimsFilesFor(tasks, id);
  if (cell === quotedCell) {
    assert.deepEqual(files, [...expectedFiles]);
  } else {
    for (const span of backtickSpansOf(cell)) {
      assert.ok(files.includes(span), `expected ${id} claims.files to include "${span}"; got ${JSON.stringify(files)}`);
    }
  }
}

test("the real task-board fixture imports cleanly through importMarkdown with no data loss", () => {
  const fixturePath = fileURLToPath(REAL_BOARD_FIXTURE);
  const raw = fs.readFileSync(fixturePath, "utf8");
  const { board, uncertainties } = importMarkdown(raw, outputPathFor("real-board"));

  const rows = readTasksTableRows(raw);
  assert.equal(board.spec.tasks.length, rows.length);

  assertRowClaims(
    rows,
    board.spec.tasks,
    "P3",
    "`workflows/dev-workflow.md`, `workflows/task-refinement-workflow.md`, `workflows/product-spec-workflow.md`, `workflows/task-board-workflow.md`, `workflows/conventions.md`, seven runnable templates, `test/workflow-parity/golden/`",
    [
      "workflows/dev-workflow.md",
      "workflows/task-refinement-workflow.md",
      "workflows/product-spec-workflow.md",
      "workflows/task-board-workflow.md",
      "workflows/conventions.md",
      "test/workflow-parity/golden/",
    ],
  );

  assertRowClaims(
    rows,
    board.spec.tasks,
    "P8b-i",
    "`runner/src/board/import-markdown.ts`, `runner/test/import-markdown.test.ts`, one new checked-in board fixture",
    ["runner/src/board/import-markdown.ts", "runner/test/import-markdown.test.ts"],
  );

  assertRowClaims(
    rows,
    board.spec.tasks,
    "P1",
    "`workflows/*.md` frontmatter, `workflows/conventions.md`, `test/workflow-parity/`",
    ["workflows/*.md", "workflows/conventions.md", "test/workflow-parity/"],
  );

  assertRowClaims(
    rows,
    board.spec.tasks,
    "P1.3",
    "the nine manual-only `workflows/*-workflow.md`",
    ["workflows/*-workflow.md"],
  );

  const p8ciaCell =
    "`runner/src/adapters/probe.ts`, `runner/src/cli/doctor.ts`, `runner/src/cli/config.ts`, `runner/src/engine/dispatch.ts`, `runner/src/engine/board-predicates.ts`, `runner/src/engine/scheduler.ts`, `runner/test/dispatch-idempotency.test.ts`, `runner/test/board-predicates.test.ts`, `runner/test/config.test.ts`, `runner/test/adapter-selection.test.ts` (undeclared, mechanical follow-up fix — see brief's follow-ups file)";
  const p8ciaRow = rows.find((r) => r[0] === "P8c-i-a");
  assert.ok(p8ciaRow, "row P8c-i-a not found in fixture");
  const p8ciaFiles = claimsFilesFor(board.spec.tasks, "P8c-i-a");
  if ((p8ciaRow as string[])[6] === p8ciaCell) {
    assert.equal(p8ciaFiles.length, 10);
    assert.equal(p8ciaFiles[p8ciaFiles.length - 1], "runner/test/adapter-selection.test.ts");
  } else {
    for (const span of backtickSpansOf((p8ciaRow as string[])[6] ?? "")) {
      assert.ok(p8ciaFiles.includes(span));
    }
  }

  const p7eiCell =
    "`runner/src/cli/config.ts`, `runner/src/engine/scheduler.ts` (one field, one call site), `runner/evals/fixtures/harness.ts` (one type), `runner/evals/fixtures/test-supervisor.ts`, `runner/test/config.test.ts`, `runner/test/scheduler.test.ts`";
  const p7eiRow = rows.find((r) => r[0] === "P7e-i");
  assert.ok(p7eiRow, "row P7e-i not found in fixture");
  const p7eiFiles = claimsFilesFor(board.spec.tasks, "P7e-i");
  if ((p7eiRow as string[])[6] === p7eiCell) {
    assert.equal(p7eiFiles.length, 6);
  } else {
    for (const span of backtickSpansOf((p7eiRow as string[])[6] ?? "")) {
      assert.ok(p7eiFiles.includes(span));
    }
  }

  const p3diCell = "`workflows/task-board-workflow.md`, `workflows/conventions.md` Workflow ids register, `test/workflow-parity/static.test.mjs`";
  const p3diRow = rows.find((r) => r[0] === "P3d-i");
  assert.ok(p3diRow, "row P3d-i not found in fixture");
  const p3diFiles = claimsFilesFor(board.spec.tasks, "P3d-i");
  if ((p3diRow as string[])[6] === p3diCell) {
    assert.equal(p3diFiles.length, 3);
  } else {
    for (const span of backtickSpansOf((p3diRow as string[])[6] ?? "")) {
      assert.ok(p3diFiles.includes(span));
    }
  }

  const p10Cell =
    "`workflows/manifests/`, `workflows/schemas/`, the nine manual-only `workflows/*-workflow.md` frontmatter, `test/workflow-parity/`";
  const p10Row = rows.find((r) => r[0] === "P10");
  assert.ok(p10Row, "row P10 not found in fixture");
  const p10Files = claimsFilesFor(board.spec.tasks, "P10");
  if ((p10Row as string[])[6] === p10Cell) {
    assert.equal(p10Files.length, 4);
    assert.ok(p10Files.includes("workflows/*-workflow.md"));
  } else {
    for (const span of backtickSpansOf((p10Row as string[])[6] ?? "")) {
      assert.ok(p10Files.includes(span));
    }
  }

  for (const task of board.spec.tasks) {
    if (task.claims === "unknown") continue;
    for (const file of task.claims.files) {
      assert.ok(!file.includes("`"), `claims.files entry "${file}" for ${task.id} still has a backtick`);
      assert.ok(!/\s/.test(file), `claims.files entry "${file}" for ${task.id} still has whitespace`);
    }
  }

  const BARE_BACKTICK_SPAN = /^`[^`]+`$/;
  const expectedAnnotationCount = rows.filter((row) => !BARE_BACKTICK_SPAN.test(row[3] ?? "")).length;
  const annotationUncertainties = uncertainties.filter((u) => u.includes("status annotation ignored:"));
  assert.equal(annotationUncertainties.length, expectedAnnotationCount);
});

test("the real task-board fixture imports through the real CLI dispatcher", async () => {
  await withTempWorkspace(async (dir) => {
    const fixturePath = fileURLToPath(REAL_BOARD_FIXTURE);
    const outputPath = path.join(dir, "imported-board.json");
    const io = fakeIo(dir);

    const code = await main(
      ["node", "orga", "board", "import-markdown", "--input", fixturePath, "--output", outputPath, "--json"],
      io,
    );
    assert.equal(code, EXIT_CODES.OK);

    const written = JSON.parse(fs.readFileSync(outputPath, "utf8")) as { spec: { tasks: unknown[] } };
    const raw = fs.readFileSync(fixturePath, "utf8");
    const rows = readTasksTableRows(raw);
    assert.equal(written.spec.tasks.length, rows.length);
  });
});
