import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { main } from "../bin/orga.ts";
import { EXIT_CODES } from "../src/cli/exit-codes.ts";
import type { Io } from "../src/cli/commands.ts";
import { runEvalCells } from "../src/cli/eval-run.ts";
import { loadRegistry } from "../evals/eval-vocabulary.ts";
import { resolveInvocation } from "../evals/fixture-invocations.ts";
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

interface EvalRunJson {
  evalRunId: string;
  suite: string;
  profile: string;
  tier: string;
  outcome: string;
  artifactRoot: string;
  cells: readonly { cellId: string; fixtureId: string; artifactPath: string; disposition: string }[];
  liveExemptReason?: string;
}

test("resolveInvocation resolves every registry id without throwing (AC9)", () => {
  const registry = loadRegistry();
  const failures: string[] = [];

  for (const [unit, entry] of Object.entries(registry.units)) {
    for (const id of entry.deterministic) {
      try {
        resolveInvocation(unit, "fake", id);
      } catch (err) {
        failures.push(`${unit}/fake/${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (entry.live) {
      for (const vendor of ["claude", "codex"] as const) {
        for (const id of entry.live) {
          try {
            resolveInvocation(unit, vendor, id);
          } catch (err) {
            failures.push(`${unit}/${vendor}/${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("unrecognized or missing --suite/--profile exits INVALID_ARGS naming the bad value", async () => {
  await withTempWorkspace(async (dir) => {
    const ioBadSuite = fakeIo(dir);
    const codeBadSuite = await main(
      ["node", "orga", "eval", "run", "--suite", "no-such-suite", "--profile", "fake"],
      ioBadSuite,
    );
    assert.equal(codeBadSuite, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioBadSuite.errLines.some((line) => line.includes("no-such-suite")));

    const ioBadProfile = fakeIo(dir);
    const codeBadProfile = await main(
      ["node", "orga", "eval", "run", "--suite", "store", "--profile", "no-such-profile"],
      ioBadProfile,
    );
    assert.equal(codeBadProfile, EXIT_CODES.INVALID_ARGS);
    assert.ok(ioBadProfile.errLines.some((line) => line.includes("no-such-profile")));

    const ioMissingSuite = fakeIo(dir);
    const codeMissingSuite = await main(["node", "orga", "eval", "run", "--profile", "fake"], ioMissingSuite);
    assert.equal(codeMissingSuite, EXIT_CODES.INVALID_ARGS);
  });
});

test("a live-tier resolution refuses to start without ORGA_LIVE=1 (AC3)", async () => {
  await withTempWorkspace(async (dir) => {
    const io = fakeIo(dir, {});
    assert.equal(io.spawnFn, undefined);

    const code = await main(["node", "orga", "eval", "run", "--suite", "store", "--profile", "claude"], io);

    assert.equal(code, EXIT_CODES.VENDOR_UNAVAILABLE);
    assert.equal(io.outLines.length, 0);
    assert.ok(io.errLines.some((line) => line.includes("ORGA_LIVE")));
    assert.equal(fs.existsSync(path.join(dir, ".orga", "evals")), false);
  });
});

test("a live-exempt pair resolves identically with and without ORGA_LIVE set (AC8)", async () => {
  await withTempWorkspace(async (dir) => {
    const expectedReason = loadRegistry().units["importer"]?.liveExemptReason;
    assert.ok(typeof expectedReason === "string");

    const ioUnset = fakeIo(dir, {});
    const codeUnset = await main(
      ["node", "orga", "eval", "run", "--suite", "importer", "--profile", "claude", "--json"],
      ioUnset,
    );

    const ioSet = fakeIo(dir, { ORGA_LIVE: "1" });
    const codeSet = await main(
      ["node", "orga", "eval", "run", "--suite", "importer", "--profile", "claude", "--json"],
      ioSet,
    );

    assert.equal(codeUnset, EXIT_CODES.OK);
    assert.equal(codeSet, EXIT_CODES.OK);
    assert.equal(ioUnset.outLines.length, 1);
    assert.equal(ioSet.outLines.length, 1);

    const parsedUnset = JSON.parse(ioUnset.outLines[0] as string) as EvalRunJson;
    const parsedSet = JSON.parse(ioSet.outLines[0] as string) as EvalRunJson;

    assert.equal(parsedUnset.outcome, "no-cells");
    assert.deepEqual(parsedUnset.cells, []);
    assert.equal(parsedUnset.liveExemptReason, expectedReason);

    const { evalRunId: _unsetId, artifactRoot: _unsetRoot, ...restUnset } = parsedUnset;
    const { evalRunId: _setId, artifactRoot: _setRoot, ...restSet } = parsedSet;
    assert.deepEqual(restUnset, restSet);
  });
});

test(
  "a fake-profile run of a credential-free suite completes OK with per-cell artifacts (AC1/AC4/AC5/AC6/AC7)",
  { timeout: 60000 },
  async () => {
    await withTempWorkspace(async (dir) => {
      const io = fakeIo(dir);

      const code = await main(
        ["node", "orga", "eval", "run", "--suite", "importer", "--profile", "fake", "--json"],
        io,
      );

      assert.equal(code, EXIT_CODES.OK, io.errLines.join("\n"));
      assert.equal(io.outLines.length, 1);

      const parsed = JSON.parse(io.outLines[0] as string) as EvalRunJson;
      assert.equal(parsed.suite, "importer");
      assert.equal(parsed.profile, "fake");
      assert.equal(parsed.tier, "deterministic");
      assert.equal(parsed.outcome, "passed");
      assert.equal(parsed.cells.length, 2);

      const cellIds = new Set(parsed.cells.map((cell) => cell.cellId));
      assert.equal(cellIds.size, 2);

      for (const cell of parsed.cells) {
        assert.ok(path.isAbsolute(cell.artifactPath));
        assert.ok(cell.artifactPath.startsWith(path.join(dir, ".orga", "evals", parsed.evalRunId)));
        const files = fs.readdirSync(cell.artifactPath);
        assert.equal(files.length, 15);
      }

      const progressLines = io.errLines.filter((line) => /^\[\d+\/\d+]/.test(line));
      assert.equal(progressLines.length, 2);
    });
  },
);

test(
  "runEvalCells isolates a cell whose runCell call throws before producing a record (AC10)",
  { timeout: 60000 },
  async () => {
    await withTempWorkspace(async (dir) => {
      const progress: string[] = [];

      const outcomes = await runEvalCells({
        suite: "packet-compiler",
        profile: "fake",
        ids: ["worker-final-is-data", "no-such-fixture-id-xyz"],
        evalRunId: "test-eval-run-ac10",
        root: dir,
        onProgress: (line) => progress.push(line),
      });

      assert.equal(outcomes.length, 2);
      assert.equal(outcomes[0]?.fixtureId, "worker-final-is-data");
      assert.equal(outcomes[1]?.fixtureId, "no-such-fixture-id-xyz");
      assert.equal(outcomes[1]?.disposition, "fail");
      assert.ok(outcomes[1]?.dispositionDetail?.startsWith("unresolved-fixture-id: "));

      for (const outcome of outcomes) {
        assert.ok(fs.existsSync(outcome.artifactPath));
        const files = fs.readdirSync(outcome.artifactPath);
        assert.equal(files.length, 15);
      }

      const unresolvedPath = outcomes[1]?.artifactPath as string;
      const snapshot = JSON.parse(fs.readFileSync(path.join(unresolvedPath, "eval-snapshot.json"), "utf8")) as {
        disposition: string;
      };
      assert.equal(snapshot.disposition, "fail");

      assert.equal(progress.length, 2);
    });
  },
);
