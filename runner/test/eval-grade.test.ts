import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import type { Io } from "../src/cli/commands.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function fakeIo(dir: string, env: NodeJS.ProcessEnv = {}): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => dir,
    now: () => Date.now(),
    env,
  };
}

interface EvalGradeJson {
  evalRunId: string;
  artifactRoot: string;
  outcome: string;
  cells: readonly { cellId: string; outcome: string; gradingPath: string; metricsPath: string }[];
}

interface GradingArtifactJson {
  cellId: string;
  evalRunId: string;
  gradingSchemaVersion: number;
  checks: readonly { id: string; grader: string; outcome: string; detail: string | null }[];
  outcome: string;
}

interface MetricsArtifactJson {
  cellId: string;
  evalRunId: string;
  metricsSchemaVersion: number;
  wallTimeMs: number | null;
  exitCode: number | null;
  recordedPgidCount: number | null;
  eventCount: number | null;
  vendorStdoutBytes: number | null;
  startupContextBytes: number | null;
  firstActionLatencyMs: number | null;
}

function runDir(dir: string, evalRunId: string): string {
  return path.join(dir, ".orga", "evals", evalRunId);
}

function writeArtifact(cellDir: string, name: string, content: string): void {
  fs.mkdirSync(cellDir, { recursive: true });
  fs.writeFileSync(path.join(cellDir, name), content, "utf8");
}

function evalSnapshotJson(disposition: "pass" | "fail" | "skipped" = "skipped"): string {
  return `${JSON.stringify({ disposition }, null, 2)}\n`;
}

function processJson(
  overrides: Partial<{
    recordedPgids: unknown;
    pid: number | null;
    exitCode: number | null;
    wallTimeMs: number;
    startupContextBytes: number | null;
    firstActionLatencyMs: number | null;
  }> = {},
): string {
  return `${JSON.stringify(
    { recordedPgids: [], pid: null, exitCode: 0, wallTimeMs: 5, startupContextBytes: null, firstActionLatencyMs: null, ...overrides },
    null,
    2,
  )}\n`;
}

const EMPTY_BOARD_YAML = "run: null\ntasks: []\n";

function writePassingCell(cellDir: string, options: { recordedPgids?: unknown; vendorStdout?: string; events?: string } = {}): void {
  writeArtifact(cellDir, "eval-snapshot.json", evalSnapshotJson());
  writeArtifact(
    cellDir,
    "process.json",
    processJson("recordedPgids" in options ? { recordedPgids: options.recordedPgids } : {}),
  );
  writeArtifact(cellDir, "state-transitions.jsonl", "");
  writeArtifact(cellDir, "board-before.yaml", EMPTY_BOARD_YAML);
  writeArtifact(cellDir, "board-after.yaml", EMPTY_BOARD_YAML);
  writeArtifact(cellDir, "diff.patch", "");
  writeArtifact(cellDir, "events.jsonl", options.events ?? "");
  writeArtifact(cellDir, "vendor-stdout.jsonl", options.vendorStdout ?? "");
  writeArtifact(cellDir, "git-before.txt", "");
  writeArtifact(cellDir, "git-after.txt", "");
  writeArtifact(cellDir, "git-commit-graph.txt", "");
}

function writeFailingCell(cellDir: string): void {
  // duplicate recordedPgids entries trip the process-count grader into "fail".
  writeArtifact(cellDir, "eval-snapshot.json", evalSnapshotJson());
  writeArtifact(cellDir, "process.json", processJson({ recordedPgids: [5, 5] }));
  writeArtifact(cellDir, "state-transitions.jsonl", "");
  writeArtifact(cellDir, "board-before.yaml", EMPTY_BOARD_YAML);
  writeArtifact(cellDir, "board-after.yaml", EMPTY_BOARD_YAML);
  writeArtifact(cellDir, "diff.patch", "");
  writeArtifact(cellDir, "events.jsonl", "");
  writeArtifact(cellDir, "vendor-stdout.jsonl", "");
  writeArtifact(cellDir, "git-before.txt", "");
  writeArtifact(cellDir, "git-after.txt", "");
  writeArtifact(cellDir, "git-commit-graph.txt", "");
}

test("(a) a well-formed multi-cell run writes grading.json and metrics.json per cell with pinned fields and grader: deterministic", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-multi-cell";
    writePassingCell(path.join(runDir(dir, evalRunId), "cell-a"));
    writePassingCell(path.join(runDir(dir, evalRunId), "cell-b"));

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);

    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    assert.equal(io.outLines.length, 1);
    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    assert.equal(parsed.evalRunId, evalRunId);
    assert.equal(parsed.cells.length, 2);

    for (const cell of parsed.cells) {
      const grading = JSON.parse(fs.readFileSync(cell.gradingPath, "utf8")) as GradingArtifactJson;
      assert.equal(grading.cellId, cell.cellId);
      assert.equal(grading.evalRunId, evalRunId);
      assert.equal(grading.gradingSchemaVersion, 1);
      assert.ok(grading.checks.length > 0);
      for (const check of grading.checks) {
        assert.equal(check.grader, "deterministic");
      }
      assert.equal(typeof grading.outcome, "string");

      const metrics = JSON.parse(fs.readFileSync(cell.metricsPath, "utf8")) as MetricsArtifactJson;
      assert.equal(metrics.cellId, cell.cellId);
      assert.equal(metrics.evalRunId, evalRunId);
      assert.equal(metrics.metricsSchemaVersion, 1);
      assert.ok("wallTimeMs" in metrics);
      assert.ok("exitCode" in metrics);
      assert.ok("recordedPgidCount" in metrics);
      assert.ok("eventCount" in metrics);
      assert.ok("vendorStdoutBytes" in metrics);
    }
  });
});

test("(b) grading the same eval run twice produces byte-identical grading.json with no absolute path leaked (AC3)", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-determinism";
    writePassingCell(path.join(runDir(dir, evalRunId), "cell-a"), { vendorStdout: '{"name":"a","text":"hi"}\n' });

    const io1 = fakeIo(dir);
    const code1 = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io1);
    assert.equal(code1, EXIT_CODES.OK, io1.errLines.join("\n"));
    const parsed1 = JSON.parse(io1.outLines[0] as string) as EvalGradeJson;
    const gradingPath = parsed1.cells[0]?.gradingPath as string;
    const bytesFirst = fs.readFileSync(gradingPath);

    const io2 = fakeIo(dir);
    const code2 = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io2);
    assert.equal(code2, EXIT_CODES.OK, io2.errLines.join("\n"));
    const bytesSecond = fs.readFileSync(gradingPath);

    assert.equal(bytesFirst.equals(bytesSecond), true);
    const text = bytesFirst.toString("utf8");
    assert.equal(text.includes(dir), false);
  });
});

test("(c) a cell with no artifacts yields an operational-failure outcome, distinct from a fail cell in the same run (AC5)", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-op-failure";
    writeFailingCell(path.join(runDir(dir, evalRunId), "cell-fail"));
    fs.mkdirSync(path.join(runDir(dir, evalRunId), "cell-no-artifacts"), { recursive: true });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.FAILED, io.errLines.join("\n"));

    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    const failCell = parsed.cells.find((cell) => cell.cellId === "cell-fail");
    const emptyCell = parsed.cells.find((cell) => cell.cellId === "cell-no-artifacts");
    assert.equal(failCell?.outcome, "fail");
    assert.equal(emptyCell?.outcome, "operational-failure");

    const grading = JSON.parse(fs.readFileSync(emptyCell?.gradingPath as string, "utf8")) as GradingArtifactJson;
    assert.ok(grading.checks.length > 0);
    for (const check of grading.checks) {
      assert.equal(check.outcome, "operational-failure");
    }
  });
});

test("(d) severity order: one fail cell and one operational-failure cell exits FAILED with run outcome 'failed'", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-severity";
    writeFailingCell(path.join(runDir(dir, evalRunId), "cell-fail"));
    fs.mkdirSync(path.join(runDir(dir, evalRunId), "cell-no-artifacts"), { recursive: true });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.FAILED, io.errLines.join("\n"));

    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    assert.equal(parsed.outcome, "failed");
  });
});

test("(e) a missing, escaping, or unknown evaluation-run id is a usage error, not a crash (AC7)", async () => {
  await withTempWorkspace(async (dir) => {
    const ioMissing = fakeIo(dir);
    const codeMissing = await main(["node", "orga", "eval", "grade"], ioMissing);
    assert.equal(codeMissing, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioMissing.errLines.length > 0);

    const ioEscape = fakeIo(dir);
    const codeEscape = await main(["node", "orga", "eval", "grade", "../escape"], ioEscape);
    assert.equal(codeEscape, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioEscape.errLines.length > 0);

    const ioUnknown = fakeIo(dir);
    const codeUnknown = await main(["node", "orga", "eval", "grade", "no-such-run"], ioUnknown);
    assert.equal(codeUnknown, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioUnknown.errLines.length > 0);
  });
});

test("(f) an existing but empty run directory returns OK with outcome 'no-cells'", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-empty";
    fs.mkdirSync(runDir(dir, evalRunId), { recursive: true });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    assert.equal(parsed.outcome, "no-cells");
    assert.deepEqual(parsed.cells, []);
  });
});

test("(g) recordedPgidCount is null for recordedPgids: null and 0 for recordedPgids: []", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-pgid-count";
    writePassingCell(path.join(runDir(dir, evalRunId), "cell-null-pgids"), { recordedPgids: null });
    writePassingCell(path.join(runDir(dir, evalRunId), "cell-empty-pgids"), { recordedPgids: [] });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;

    const nullCell = parsed.cells.find((cell) => cell.cellId === "cell-null-pgids");
    const emptyCell = parsed.cells.find((cell) => cell.cellId === "cell-empty-pgids");

    const nullMetrics = JSON.parse(fs.readFileSync(nullCell?.metricsPath as string, "utf8")) as MetricsArtifactJson;
    const emptyMetrics = JSON.parse(fs.readFileSync(emptyCell?.metricsPath as string, "utf8")) as MetricsArtifactJson;

    assert.equal(nullMetrics.recordedPgidCount, null);
    assert.equal(emptyMetrics.recordedPgidCount, 0);
  });
});

test("(h) metrics.json's five value fields are all null for a cell with no process.json, events.jsonl, or vendor-stdout.jsonl", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-no-metrics-inputs";
    const cellPath = path.join(runDir(dir, evalRunId), "cell-empty");
    fs.mkdirSync(cellPath, { recursive: true });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.FAILED, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    const cell = parsed.cells.find((c) => c.cellId === "cell-empty");

    const metrics = JSON.parse(fs.readFileSync(cell?.metricsPath as string, "utf8")) as MetricsArtifactJson;
    assert.equal(metrics.wallTimeMs, null);
    assert.equal(metrics.exitCode, null);
    assert.equal(metrics.recordedPgidCount, null);
    assert.equal(metrics.eventCount, null);
    assert.equal(metrics.vendorStdoutBytes, null);
  });
});

test("(j) a process.json carrying startupContextBytes/firstActionLatencyMs yields the same two values in metrics.json", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-context-cost-present";
    const cellDir = path.join(runDir(dir, evalRunId), "cell-context-cost");
    writeArtifact(cellDir, "eval-snapshot.json", evalSnapshotJson());
    writeArtifact(cellDir, "process.json", processJson({ startupContextBytes: 2048, firstActionLatencyMs: 1200 }));
    writeArtifact(cellDir, "state-transitions.jsonl", "");
    writeArtifact(cellDir, "board-before.yaml", EMPTY_BOARD_YAML);
    writeArtifact(cellDir, "board-after.yaml", EMPTY_BOARD_YAML);
    writeArtifact(cellDir, "diff.patch", "");
    writeArtifact(cellDir, "events.jsonl", "");
    writeArtifact(cellDir, "vendor-stdout.jsonl", "");
    writeArtifact(cellDir, "git-before.txt", "");
    writeArtifact(cellDir, "git-after.txt", "");
    writeArtifact(cellDir, "git-commit-graph.txt", "");

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    const cell = parsed.cells.find((c) => c.cellId === "cell-context-cost");
    const metrics = JSON.parse(fs.readFileSync(cell?.metricsPath as string, "utf8")) as MetricsArtifactJson;
    assert.equal(metrics.startupContextBytes, 2048);
    assert.equal(metrics.firstActionLatencyMs, 1200);
  });
});

test("(k) a process.json carrying neither startupContextBytes nor firstActionLatencyMs yields null for both in metrics.json, with no live process spawned", async () => {
  await withTempWorkspace(async (dir) => {
    const evalRunId = "run-context-cost-absent";
    writePassingCell(path.join(runDir(dir, evalRunId), "cell-no-context-cost"));

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "grade", evalRunId, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    const parsed = JSON.parse(io.outLines[0] as string) as EvalGradeJson;
    const cell = parsed.cells.find((c) => c.cellId === "cell-no-context-cost");
    const metrics = JSON.parse(fs.readFileSync(cell?.metricsPath as string, "utf8")) as MetricsArtifactJson;
    assert.equal(metrics.startupContextBytes, null);
    assert.equal(metrics.firstActionLatencyMs, null);
  });
});

test("(i) grading-schema.ts and grade-runner.ts import no vendor adapter, spawn no process, and grading-schema.ts imports no node:fs (AC4)", () => {
  const EVALS_DIR = fileURLToPath(new URL("../evals/", import.meta.url));
  const FORBIDDEN_ALWAYS = ["src/adapters/", "src/store/", "src/reports/replay.ts", "src/reports/run-replay.ts", '"node:child_process"', "'node:child_process'"];
  const FORBIDDEN_FS = ['"node:fs"', "'node:fs'"];

  for (const file of ["grading-schema.ts", "grade-runner.ts"]) {
    const source = fs.readFileSync(path.join(EVALS_DIR, file), "utf8");
    for (const specifier of FORBIDDEN_ALWAYS) {
      assert.ok(!source.includes(specifier), `${file} must not reference ${specifier}`);
    }
    if (file !== "grading-schema.ts") continue;
    for (const specifier of FORBIDDEN_FS) {
      assert.ok(!source.includes(specifier), `${file} must not import node:fs`);
    }
  }
});
