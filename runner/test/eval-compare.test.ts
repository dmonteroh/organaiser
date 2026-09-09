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

interface CompareRepeatJson {
  side: "left" | "right";
  cellId: string;
  outcome: string;
}

interface CompareCellJson {
  key: string;
  unstable: boolean;
  repeats: readonly CompareRepeatJson[];
}

interface CompareJson {
  left: string;
  right: string;
  leftArtifactRoot: string;
  rightArtifactRoot: string;
  variedVariable: string | null;
  variedVariables: readonly string[];
  outcome: string;
  matchedKeys: number;
  unstableKeys: number;
  ungradedCells: number;
  leftOnlyKeys: readonly string[];
  rightOnlyKeys: readonly string[];
  cells: readonly CompareCellJson[];
}

function runDir(dir: string, evalRunId: string): string {
  return path.join(dir, ".orga", "evals", evalRunId);
}

function writeArtifact(cellDir: string, name: string, content: string): void {
  fs.mkdirSync(cellDir, { recursive: true });
  fs.writeFileSync(path.join(cellDir, name), content, "utf8");
}

function snapshotJson(overrides: Partial<{ prompt: string; workflowRevision: string | null; cliVersion: string | null; model: string | null }> = {}): string {
  return `${JSON.stringify(
    {
      snapshot: {
        prompt: overrides.prompt ?? "fixture-a",
        workflowRevision: overrides.workflowRevision ?? "rev-1",
        cliVersion: overrides.cliVersion ?? "1.0.0",
        model: overrides.model ?? "model-x",
      },
    },
    null,
    2,
  )}\n`;
}

function writeCell(
  cellDir: string,
  options: {
    prompt?: string;
    workflowRevision?: string | null;
    cliVersion?: string | null;
    model?: string | null;
    resolvedConfig?: unknown;
    outcome?: "pass" | "fail" | "not-applicable" | "operational-failure";
    skipGrading?: boolean;
    skipSnapshot?: boolean;
  } = {},
): void {
  if (!options.skipSnapshot) {
    writeArtifact(cellDir, "eval-snapshot.json", snapshotJson(options));
  }
  writeArtifact(cellDir, "resolved-config.json", `${JSON.stringify(options.resolvedConfig ?? { vendor: "fake" }, null, 2)}\n`);
  if (!options.skipGrading) {
    writeArtifact(
      cellDir,
      "grading.json",
      `${JSON.stringify({ cellId: path.basename(cellDir), evalRunId: "x", gradingSchemaVersion: 1, checks: [], outcome: options.outcome ?? "pass" }, null, 2)}\n`,
    );
  }
}

test("(a) identical variables with differing repeat outcomes report 'repeat', variedVariable null, and per-key instability", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { outcome: "pass" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { outcome: "fail" });
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-b--1"), { prompt: "fixture-b", outcome: "pass" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-b--1"), { prompt: "fixture-b", outcome: "pass" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;

    assert.equal(parsed.outcome, "repeat");
    assert.equal(parsed.variedVariable, null);

    const unstableGroup = parsed.cells.find((cell) => cell.key === "unit--profile--fixture-a");
    assert.equal(unstableGroup?.unstable, true);
    assert.deepEqual(
      unstableGroup?.repeats.map((repeat) => ({ side: repeat.side, cellId: repeat.cellId })),
      [
        { side: "left", cellId: "unit--profile--fixture-a--1" },
        { side: "right", cellId: "unit--profile--fixture-a--1" },
      ],
    );

    const stableGroup = parsed.cells.find((cell) => cell.key === "unit--profile--fixture-b");
    assert.equal(stableGroup?.unstable, false);
  });
});

test("(b) model differing on every matched key reports 'single-variable' and names model in --json and text", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { model: "model-x" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { model: "model-y" });

    const ioJson = fakeIo(dir);
    const codeJson = await main(["node", "orga", "eval", "compare", left, right, "--json"], ioJson);
    assert.equal(codeJson, EXIT_CODES.OK, ioJson.errLines.join("\n"));
    const parsed = JSON.parse(ioJson.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "model");
    assert.deepEqual(parsed.variedVariables, ["model"]);

    const ioText = fakeIo(dir);
    const codeText = await main(["node", "orga", "eval", "compare", left, right], ioText);
    assert.equal(codeText, EXIT_CODES.OK, ioText.errLines.join("\n"));
    assert.match(ioText.outLines[0] as string, /varied model,/);
  });
});

test("(c) two varied declared variables are refused with a nonzero exit code naming both, empty stdout", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { model: "model-x", cliVersion: "1.0.0" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { model: "model-y", cliVersion: "2.0.0" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.equal(io.outLines.length, 0);
    assert.equal(io.errLines.length, 1);
    assert.match(io.errLines[0] as string, /cliVersion/);
    assert.match(io.errLines[0] as string, /model/);
  });
});

test("(d) a literal null resolved-config.json on both sides is not a variation", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { resolvedConfig: null });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { resolvedConfig: null });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.variedVariables.includes("resolvedConfig"), false);
    assert.equal(parsed.outcome, "repeat");
  });
});

test("(e) resolvedConfig written in a different key order is not a variation", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    const leftCell = path.join(runDir(dir, left), "unit--profile--fixture-a--1");
    const rightCell = path.join(runDir(dir, right), "unit--profile--fixture-a--1");
    writeCell(leftCell, { skipGrading: false });
    writeArtifact(leftCell, "resolved-config.json", `${JSON.stringify({ vendor: "fake", model: "fake", cliVersion: "1.0.0" }, null, 2)}\n`);
    writeCell(rightCell, { skipGrading: false });
    writeArtifact(rightCell, "resolved-config.json", `${JSON.stringify({ cliVersion: "1.0.0", vendor: "fake", model: "fake" }, null, 2)}\n`);

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.variedVariables.includes("resolvedConfig"), false);
  });
});

test("(e2) resolvedConfig differing in array element order is a single-variable variation", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { resolvedConfig: { tags: ["a", "b", "c"] } });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { resolvedConfig: { tags: ["c", "b", "a"] } });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "resolvedConfig");
  });
});

test("(e3) resolvedConfig differing in a nested-object field is a single-variable variation", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { resolvedConfig: { outer: { a: 1, b: 2 } } });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { resolvedConfig: { outer: { b: 2, a: 3 } } });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "resolvedConfig");
  });
});

test("(d2) a literal null resolved-config.json versus a missing resolved-config.json is a variation", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    const leftCell = path.join(runDir(dir, left), "unit--profile--fixture-a--1");
    const rightCell = path.join(runDir(dir, right), "unit--profile--fixture-a--1");
    writeCell(leftCell, { resolvedConfig: null });
    writeCell(rightCell, { resolvedConfig: null });
    fs.unlinkSync(path.join(rightCell, "resolved-config.json"));

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.variedVariables.includes("resolvedConfig"), true);
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "resolvedConfig");
  });
});

test("(d3) a literal null resolved-config.json versus an unparseable one is a variation", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    const leftCell = path.join(runDir(dir, left), "unit--profile--fixture-a--1");
    const rightCell = path.join(runDir(dir, right), "unit--profile--fixture-a--1");
    writeCell(leftCell, { resolvedConfig: null });
    writeCell(rightCell, { resolvedConfig: null });
    writeArtifact(rightCell, "resolved-config.json", "{not valid json");

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.variedVariables.includes("resolvedConfig"), true);
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "resolvedConfig");
  });
});

test("(f) different fixture coverage reports variedVariable 'prompt' with leftOnlyKeys/rightOnlyKeys populated", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { prompt: "fixture-a" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-b--1"), { prompt: "fixture-b" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.variedVariable, "prompt");
    assert.deepEqual(parsed.leftOnlyKeys, ["unit--profile--fixture-a"]);
    assert.deepEqual(parsed.rightOnlyKeys, ["unit--profile--fixture-b"]);
  });
});

test("(g) usage errors return INVALID_ARGS for one positional, an escaping id, a nonexistent id, and identical ids", async () => {
  await withTempWorkspace(async (dir) => {
    const existing = "run-existing";
    writeCell(path.join(runDir(dir, existing), "unit--profile--fixture-a--1"), {});

    const ioOnePositional = fakeIo(dir);
    const codeOnePositional = await main(["node", "orga", "eval", "compare", existing], ioOnePositional);
    assert.equal(codeOnePositional, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioOnePositional.errLines.length > 0);

    const ioEscape = fakeIo(dir);
    const codeEscape = await main(["node", "orga", "eval", "compare", existing, "../escape"], ioEscape);
    assert.equal(codeEscape, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioEscape.errLines.length > 0);

    const ioUnknown = fakeIo(dir);
    const codeUnknown = await main(["node", "orga", "eval", "compare", existing, "no-such-run"], ioUnknown);
    assert.equal(codeUnknown, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioUnknown.errLines.length > 0);

    const ioIdentical = fakeIo(dir);
    const codeIdentical = await main(["node", "orga", "eval", "compare", existing, existing], ioIdentical);
    assert.equal(codeIdentical, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioIdentical.errLines.length > 0);
  });
});

test("(h) a cell with no grading.json reports outcome 'ungraded', a nonzero ungradedCells, and exit OK", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { skipGrading: true });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { outcome: "pass" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.ok(parsed.ungradedCells > 0);
    const group = parsed.cells.find((cell) => cell.key === "unit--profile--fixture-a");
    const leftRepeat = group?.repeats.find((repeat) => repeat.side === "left");
    assert.equal(leftRepeat?.outcome, "ungraded");
  });
});

test("(i) AC4: the emitted JSON has no key named mean, median, average, score, rate, or ratio anywhere", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { outcome: "pass" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { outcome: "fail" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed: unknown = JSON.parse(io.outLines[0] as string);

    const forbidden = new Set(["mean", "median", "average", "score", "rate", "ratio"]);
    const seen: string[] = [];
    function scan(value: unknown): void {
      if (Array.isArray(value)) {
        for (const item of value) scan(item);
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          if (forbidden.has(key.toLowerCase())) seen.push(key);
          scan(item);
        }
      }
    }
    scan(parsed);
    assert.deepEqual(seen, []);
  });
});

test("(j) AC5: compare.ts imports no grader, grade-runner, cell-runner, fixtures, store, reports, or child_process module", async () => {
  const EVALS_DIR = fileURLToPath(new URL("../evals/", import.meta.url));
  const source = fs.readFileSync(path.join(EVALS_DIR, "compare.ts"), "utf8");
  const forbidden = [
    "graders/",
    "grade-runner.ts",
    "cell-runner.ts",
    "fixtures/",
    "src/store/",
    "src/reports/",
    '"node:child_process"',
    "'node:child_process'",
  ];
  for (const specifier of forbidden) {
    assert.ok(!source.includes(specifier), `compare.ts must not reference ${specifier}`);
  }

  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    const leftCellDir = path.join(runDir(dir, left), "unit--profile--fixture-a--1");
    const rightCellDir = path.join(runDir(dir, right), "unit--profile--fixture-a--1");
    writeCell(leftCellDir, { outcome: "pass" });
    writeCell(rightCellDir, { outcome: "fail" });

    const gradingBefore = fs.readFileSync(path.join(leftCellDir, "grading.json"), "utf8");

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));

    const gradingAfter = fs.readFileSync(path.join(leftCellDir, "grading.json"), "utf8");
    assert.equal(gradingBefore, gradingAfter);
  });
});

test("(l) a missing eval-snapshot.json on one side is a variation, refused as multiple varied declared variables", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), {});
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { skipSnapshot: true });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.equal(io.outLines.length, 0);
    assert.equal(io.errLines.length, 1);
    assert.match(io.errLines[0] as string, /prompt/);
    assert.match(io.errLines[0] as string, /workflowRevision/);
    assert.match(io.errLines[0] as string, /cliVersion/);
    assert.match(io.errLines[0] as string, /model/);
  });
});

test("(m) an unparseable eval-snapshot.json on one side is a variation, refused as multiple varied declared variables", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    const leftCell = path.join(runDir(dir, left), "unit--profile--fixture-a--1");
    const rightCell = path.join(runDir(dir, right), "unit--profile--fixture-a--1");
    writeCell(leftCell, {});
    writeCell(rightCell, {});
    writeArtifact(rightCell, "eval-snapshot.json", "{not valid json");

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.equal(io.outLines.length, 0);
    assert.equal(io.errLines.length, 1);
    assert.match(io.errLines[0] as string, /prompt/);
    assert.match(io.errLines[0] as string, /workflowRevision/);
    assert.match(io.errLines[0] as string, /cliVersion/);
    assert.match(io.errLines[0] as string, /model/);
  });
});

test("(n) workflowRevision differing on every matched key reports 'single-variable' and names workflowRevision", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { workflowRevision: "rev-1" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { workflowRevision: "rev-2" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "workflowRevision");
    assert.deepEqual(parsed.variedVariables, ["workflowRevision"]);
  });
});

test("(o) cliVersion differing on every matched key reports 'single-variable' and names cliVersion", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile--fixture-a--1"), { cliVersion: "1.0.0" });
    writeCell(path.join(runDir(dir, right), "unit--profile--fixture-a--1"), { cliVersion: "2.0.0" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "cliVersion");
    assert.deepEqual(parsed.variedVariables, ["cliVersion"]);
  });
});

test("(k) two empty run directories report 'no-cells'; disjoint profile keys report 'no-matched-cells'", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    fs.mkdirSync(runDir(dir, left), { recursive: true });
    fs.mkdirSync(runDir(dir, right), { recursive: true });

    const ioEmpty = fakeIo(dir);
    const codeEmpty = await main(["node", "orga", "eval", "compare", left, right, "--json"], ioEmpty);
    assert.equal(codeEmpty, EXIT_CODES.OK, ioEmpty.errLines.join("\n"));
    const parsedEmpty = JSON.parse(ioEmpty.outLines[0] as string) as CompareJson;
    assert.equal(parsedEmpty.outcome, "no-cells");
  });

  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--profile-a--fixture-a--1"), { prompt: "fixture-a" });
    writeCell(path.join(runDir(dir, right), "unit--profile-b--fixture-a--1"), { prompt: "fixture-a" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "no-matched-cells");
  });
});

interface VendorEvidenceSideJson {
  profiles: readonly string[];
  cliVersion: readonly string[];
  model: readonly string[];
  resolvedConfig: readonly string[];
}

interface CompareJsonWithVendor extends CompareJson {
  vendorEvidence?: { left: VendorEvidenceSideJson; right: VendorEvidenceSideJson };
}

test("(p) AC2/AC3: --vary vendor matches cells of the identical fixture run under different profiles and names 'vendor'", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--1"), {});
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-a--1"), {});

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--vary", "vendor", "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "single-variable");
    assert.equal(parsed.variedVariable, "vendor");
    assert.deepEqual(parsed.variedVariables, ["vendor"]);
    assert.equal(parsed.matchedKeys, 1);
    assert.ok(parsed.cells.some((cell) => cell.key === "unit--fixture-a"));
  });
});

test("(q) AC4: a --vary vendor pair that also varies prompt reports 'multi-variable' and is refused", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--1"), { prompt: "fixture-a" });
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-a--1"), { prompt: "fixture-a-changed" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--vary", "vendor", "--json"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.equal(io.outLines.length, 0);
    assert.equal(io.errLines.length, 1);
    assert.match(io.errLines[0] as string, /vendor/);
    assert.match(io.errLines[0] as string, /prompt/);
  });
});

test("(r) AC5: --vary vendor flags a key unstable only from each side's own repeats, never merely from a cross-side difference", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--1"), { prompt: "fixture-a", outcome: "pass" });
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--2"), { prompt: "fixture-a", outcome: "fail" });
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-b--1"), { prompt: "fixture-b", outcome: "pass" });
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-a--1"), { prompt: "fixture-a", outcome: "pass" });
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-b--1"), { prompt: "fixture-b", outcome: "fail" });

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--vary", "vendor", "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;

    const selfUnstableGroup = parsed.cells.find((cell) => cell.key === "unit--fixture-a");
    assert.equal(selfUnstableGroup?.unstable, true);

    const crossOnlyGroup = parsed.cells.find((cell) => cell.key === "unit--fixture-b");
    assert.equal(crossOnlyGroup?.unstable, false);
  });
});

test("(s) AC6: an unrecognized --vary value raises a usage error naming the accepted values", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--1"), {});
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-a--1"), {});

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--vary", "bogus"], io);
    assert.equal(code, EXIT_CODES.INVALID_ARGS);
    assert.ok(io.errLines.length > 0);
    assert.match(io.errLines[0] as string, /vendor/);
  });
});

test("(t) AC2: the same cross-profile fixtures report 'no-matched-cells' in default mode, without --vary", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--1"), {});
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-a--1"), {});

    const io = fakeIo(dir);
    const code = await main(["node", "orga", "eval", "compare", left, right, "--json"], io);
    assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
    const parsed = JSON.parse(io.outLines[0] as string) as CompareJson;
    assert.equal(parsed.outcome, "no-matched-cells");
  });
});

test("(u) AC4: --vary vendor carries vendorEvidence with both sides' four arrays; default mode omits the key entirely", async () => {
  await withTempWorkspace(async (dir) => {
    const left = "run-left";
    const right = "run-right";
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--1"), {
      model: "model-x",
      cliVersion: "1.0.0",
      resolvedConfig: { vendor: "claude" },
    });
    writeCell(path.join(runDir(dir, left), "unit--claude--fixture-a--2"), {
      model: "model-x2",
      cliVersion: "1.0.1",
      resolvedConfig: { vendor: "claude" },
    });
    writeCell(path.join(runDir(dir, right), "unit--codex--fixture-a--1"), {
      model: "model-y",
      cliVersion: "2.0.0",
      resolvedConfig: { vendor: "codex" },
    });

    const ioVendor = fakeIo(dir);
    const codeVendor = await main(["node", "orga", "eval", "compare", left, right, "--vary", "vendor", "--json"], ioVendor);
    assert.equal(codeVendor, EXIT_CODES.OK, ioVendor.errLines.join("\n"));
    const parsedVendor = JSON.parse(ioVendor.outLines[0] as string) as CompareJsonWithVendor;

    assert.deepEqual(parsedVendor.vendorEvidence?.left.profiles, ["claude"]);
    assert.deepEqual(parsedVendor.vendorEvidence?.left.cliVersion, [`ok:${JSON.stringify("1.0.0")}`, `ok:${JSON.stringify("1.0.1")}`]);
    assert.deepEqual(parsedVendor.vendorEvidence?.left.model, [`ok:${JSON.stringify("model-x")}`, `ok:${JSON.stringify("model-x2")}`]);
    assert.deepEqual(parsedVendor.vendorEvidence?.left.resolvedConfig, [`ok:${JSON.stringify({ vendor: "claude" })}`]);

    assert.deepEqual(parsedVendor.vendorEvidence?.right.profiles, ["codex"]);
    assert.deepEqual(parsedVendor.vendorEvidence?.right.cliVersion, [`ok:${JSON.stringify("2.0.0")}`]);
    assert.deepEqual(parsedVendor.vendorEvidence?.right.model, [`ok:${JSON.stringify("model-y")}`]);
    assert.deepEqual(parsedVendor.vendorEvidence?.right.resolvedConfig, [`ok:${JSON.stringify({ vendor: "codex" })}`]);

    const ioDefault = fakeIo(dir);
    const codeDefault = await main(["node", "orga", "eval", "compare", left, right, "--json"], ioDefault);
    assert.equal(codeDefault, EXIT_CODES.OK, ioDefault.errLines.join("\n"));
    const parsedDefault: unknown = JSON.parse(ioDefault.outLines[0] as string);
    assert.equal(Object.prototype.hasOwnProperty.call(parsedDefault, "vendorEvidence"), false);
  });
});
