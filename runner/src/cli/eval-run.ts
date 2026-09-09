// `eval run`'s orchestration loop: per fixture id, execute one cell through
// the eval engine and persist it through the artifact writer, isolating any
// per-cell failure so one bad id never aborts the run. Kept in its own
// module so `runEvalCells` is callable directly from a test with a synthetic
// id list, and so the eval engine's own module graph is loaded only when
// this file's functions are actually called: a value-level static import of
// `cell-runner.ts` pulls the whole `evals/fixtures/` tree into every `orga`
// command's module graph.

import path from "node:path";

import type { CapturedCellRecord } from "../../evals/cell-runner.ts";

export interface EvalRunCellOutcome {
  cellId: string;
  fixtureId: string;
  shape: string;
  disposition: string;
  dispositionDetail: string | null;
  artifactPath: string;
}

export function unresolvedCellRecord(
  cellId: string,
  evalRunId: string,
  suite: string,
  profile: string,
  fixtureId: string,
  message: string,
): CapturedCellRecord {
  return {
    cellId,
    evalRunId,
    unit: suite,
    profile,
    fixtureId,
    shape: "single",
    disposition: "fail",
    dispositionDetail: `unresolved-fixture-id: ${message}`,
    constituents: null,
    snapshot: {
      prompt: fixtureId,
      taskFixture: fixtureId,
      cliVersion: null,
      workflowRevision: null,
      model: null,
      resolvedConfig: null,
    },
    git: null,
    board: null,
    process: {
      recordedPgids: null,
      pid: null,
      exitCode: null,
      wallTimeMs: 0,
      startupContextBytes: null,
      firstActionLatencyMs: null,
    },
    vendorStdout: null,
    vendorStderr: null,
    events: null,
    stateTransitions: null,
    workerReport: null,
  };
}

export async function runEvalCells(args: {
  suite: string;
  profile: string;
  ids: readonly string[];
  evalRunId: string;
  root: string;
  onProgress: (line: string) => void;
}): Promise<EvalRunCellOutcome[]> {
  const { suite, profile, ids, evalRunId, root, onProgress } = args;
  const { createCellRunner } = await import("../../evals/cell-runner.ts");
  const { writeCellArtifacts } = await import("../../evals/artifact-writer.ts");

  const runner = createCellRunner(evalRunId);
  const cellIdCounters = new Map<string, number>();
  const outcomes: EvalRunCellOutcome[] = [];

  for (let i = 0; i < ids.length; i++) {
    const fixtureId = ids[i] as string;

    const key = `${suite}--${profile}--${fixtureId}`;
    const n = (cellIdCounters.get(key) ?? 0) + 1;
    cellIdCounters.set(key, n);
    const mirroredCellId = `${key}--${n}`;

    let record: CapturedCellRecord;
    try {
      record = await runner.runCell(suite, profile, fixtureId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record = unresolvedCellRecord(mirroredCellId, evalRunId, suite, profile, fixtureId, message);
    }

    const artifactPath = path.join(root, ".orga", "evals", evalRunId, record.cellId);
    writeCellArtifacts(record, artifactPath, root);

    onProgress(
      `[${i + 1}/${ids.length}] ${record.cellId}: ${record.disposition}` +
        (record.dispositionDetail !== null ? ` (${record.dispositionDetail})` : ""),
    );

    outcomes.push({
      cellId: record.cellId,
      fixtureId,
      shape: record.shape,
      disposition: record.disposition,
      dispositionDetail: record.dispositionDetail,
      artifactPath,
    });
  }

  return outcomes;
}
