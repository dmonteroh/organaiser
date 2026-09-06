import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import { validateBoard } from "../src/board/validate.ts";
import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import { initProject } from "../src/store/init.ts";
import type { Io } from "../src/cli/commands.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

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

interface TaskOverrides {
  id?: string;
  title?: string;
  briefPath?: string;
  entry?: { workflowId: string; stageId: string };
  dependencies?: string[];
  priority?: number;
  claims?: unknown;
  verification?: unknown[];
  enabled?: boolean;
}

function makeTask(overrides: TaskOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "t1",
    title: overrides.title ?? "Task",
    briefPath: overrides.briefPath ?? "brief.md",
    entry: overrides.entry ?? { workflowId: "wf1", stageId: "s1" },
    dependencies: overrides.dependencies ?? [],
    priority: overrides.priority ?? 0,
    requiredWorkflowVersions: {},
    claims: overrides.claims ?? "unknown",
    verification: overrides.verification ?? [],
    enabled: overrides.enabled ?? true,
  };
}

function makeBoard(tasks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: { id: "board-1", contractVersion: "v1" },
    spec: { tasks },
  };
}

function writeBoardFile(dir: string, board: unknown): string {
  const boardPath = path.join(dir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
  return boardPath;
}

test("validateBoard accepts a well-formed board with argv and shell verification checks", () => {
  const board = makeBoard([
    makeTask({ id: "t1", claims: "unknown" }),
    makeTask({
      id: "t2",
      dependencies: ["t1"],
      claims: { files: ["src/x.ts"], nonFile: [] },
      verification: [
        { id: "unit", argv: ["npm", "test"] },
        { id: "lint", shell: true, command: "npm run lint" },
      ],
    }),
  ]);

  const result = validateBoard(board);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateBoard flags a duplicate task id", () => {
  const board = makeBoard([makeTask({ id: "dup" }), makeTask({ id: "dup" })]);
  const result = validateBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /duplicate task id: dup/.test(e.message)));
});

test("validateBoard flags a dependency that does not resolve to a known task id", () => {
  const board = makeBoard([makeTask({ id: "t1", dependencies: ["ghost"] })]);
  const result = validateBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown task id "ghost"/.test(e.message)));
});

test("validateBoard flags a dependency cycle via DFS-based cycle detection", () => {
  const board = makeBoard([
    makeTask({ id: "a", dependencies: ["b"] }),
    makeTask({ id: "b", dependencies: ["a"] }),
  ]);
  const result = validateBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /dependency cycle detected/.test(e.message)));
});

test("validateBoard flags an empty claims object masquerading as a real claim set", () => {
  const board = makeBoard([makeTask({ id: "t1", claims: {} })]);
  const result = validateBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /empty claims object/.test(e.message)));
});

test("validateBoard accepts claims: \"unknown\" and a non-empty {files, nonFile} set", () => {
  const board = makeBoard([
    makeTask({ id: "t1", claims: "unknown" }),
    makeTask({ id: "t2", claims: { files: ["a.ts"] } }),
  ]);
  const result = validateBoard(board);
  assert.equal(result.valid, true);
});

test("validateBoard flags a non-empty briefPath and malformed entry.{workflowId, stageId}", () => {
  const board = makeBoard([
    makeTask({ id: "t1", briefPath: "" }),
    makeTask({ id: "t2", entry: { workflowId: "wf1", stageId: "" } }),
  ]);
  const result = validateBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /t1.*briefPath/.test(e.path) && /non-empty briefPath/.test(e.message)));
  assert.ok(result.errors.some((e) => /t2.*entry/.test(e.path) && /malformed entry/.test(e.message)));
});

test("validateBoard rejects a bare-string verification entry citing goals-spec 9.2's explicit shell mode requirement", () => {
  const board = makeBoard([makeTask({ id: "t1", verification: ["npm test"] })]);
  const result = validateBoard(board);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /bare-string verification/.test(e.message) && /goals-spec 9.2/.test(e.message)));
});

test("the same bare-string verification fixture still passes board.schema.json and dry-run.ts's unmodified shape-only check", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const board = makeBoard([makeTask({ id: "t1", verification: ["npm test"] })]);
    const boardPath = writeBoardFile(dir, board);
    const io = fakeIo(dir);

    const code = await main(["node", "orga", "run", "dry-run", "--board", boardPath, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    const strictResult = validateBoard(board);
    assert.equal(strictResult.valid, false);
  });
});

test("board validate --json emits {valid, errors} and exits INVALID_ARGS for an invalid board", async () => {
  await withTempWorkspace(async (dir) => {
    const board = makeBoard([makeTask({ id: "dup" }), makeTask({ id: "dup" })]);
    const boardPath = writeBoardFile(dir, board);
    const io = fakeIo(dir);

    const code = await main(["node", "orga", "board", "validate", "--board", boardPath, "--json"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    const parsed = JSON.parse(io.outLines[0] as string) as { valid: boolean; errors: Array<{ path: string; message: string }> };
    assert.equal(parsed.valid, false);
    assert.ok(parsed.errors.length > 0);
  });
});

test("board validate without --json prints one error per line to stderr, a count summary to stdout, and exits OK for a valid board", async () => {
  await withTempWorkspace(async (dir) => {
    const board = makeBoard([makeTask({ id: "t1" })]);
    const boardPath = writeBoardFile(dir, board);
    const io = fakeIo(dir);

    const code = await main(["node", "orga", "board", "validate", "--board", boardPath], io);
    assert.equal(code, EXIT_CODES.OK);
    assert.equal(io.errLines.length, 0);
    assert.ok(io.outLines.some((line) => /is valid/.test(line)));
  });
});

test("board validate treats an unreadable board file as a UsageError, exactly like run start's readBoardFile", async () => {
  await withTempWorkspace(async (dir) => {
    const io = fakeIo(dir);
    const code = await main(["node", "orga", "board", "validate", "--board", path.join(dir, "missing.json")], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.ok(io.errLines.some((line) => /cannot read board file/.test(line)));
  });
});
