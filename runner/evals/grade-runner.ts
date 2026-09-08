import fs from "node:fs";
import path from "node:path";

import { readFrozenCell, gradeTransitionOrder, gradeProcessCount, gradeTaskDisposition, gradeDiffScope } from "./graders/index.ts";
import type { ArtifactRead, GradingCheck, GradingOutcome, ProcessArtifact } from "./graders/types.ts";
import { compareIds, serializeGrading, serializeMetrics, worstOutcome, type GradingArtifact, type MetricsArtifact } from "./grading-schema.ts";

export interface GradedCell {
  cellId: string;
  outcome: GradingOutcome;
  gradingPath: string;
  metricsPath: string;
}

export interface GradeEvalRunResult {
  evalRunId: string;
  artifactRoot: string;
  outcome: string;
  cells: readonly GradedCell[];
}

function readTextOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readProcessNumber(processRead: ArtifactRead<ProcessArtifact>, key: "wallTimeMs" | "exitCode"): number | null {
  if (processRead.status !== "ok") return null;
  const raw = processRead.value as unknown as Record<string, unknown>;
  const value = raw[key];
  return typeof value === "number" ? value : null;
}

function readRecordedPgidCount(processRead: ArtifactRead<ProcessArtifact>): number | null {
  if (processRead.status !== "ok") return null;
  const recordedPgids = processRead.value.recordedPgids;
  if (recordedPgids === null || recordedPgids === undefined || !Array.isArray(recordedPgids)) return null;
  return recordedPgids.length;
}

function readEventCount(cellDir: string): number | null {
  const text = readTextOrNull(path.join(cellDir, "events.jsonl"));
  if (text === null) return null;
  return text.split("\n").filter((line) => line.length > 0).length;
}

function readVendorStdoutBytes(cellDir: string): number | null {
  const text = readTextOrNull(path.join(cellDir, "vendor-stdout.jsonl"));
  if (text === null) return null;
  return Buffer.byteLength(text, "utf8");
}

export function gradeEvalRun(args: { root: string; evalRunId: string }): GradeEvalRunResult {
  const { root, evalRunId } = args;
  const artifactRoot = path.join(root, ".orga", "evals", evalRunId);

  const entries = fs.readdirSync(artifactRoot, { withFileTypes: true });
  const cellIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareIds);

  const cells: GradedCell[] = [];

  for (const cellId of cellIds) {
    const cellDir = path.join(artifactRoot, cellId);
    const bundle = readFrozenCell(cellDir);

    const checks: GradingCheck[] = [
      gradeTransitionOrder(bundle),
      gradeProcessCount(bundle),
      gradeTaskDisposition(bundle),
      gradeDiffScope(bundle),
    ].sort((a, b) => compareIds(a.id, b.id));

    const outcome = worstOutcome(checks.map((check) => check.outcome));

    const grading: GradingArtifact = { cellId, evalRunId, gradingSchemaVersion: 1, checks, outcome };
    const metrics: MetricsArtifact = {
      cellId,
      evalRunId,
      metricsSchemaVersion: 1,
      wallTimeMs: readProcessNumber(bundle.process, "wallTimeMs"),
      exitCode: readProcessNumber(bundle.process, "exitCode"),
      recordedPgidCount: readRecordedPgidCount(bundle.process),
      eventCount: readEventCount(cellDir),
      vendorStdoutBytes: readVendorStdoutBytes(cellDir),
    };

    const gradingPath = path.join(cellDir, "grading.json");
    const metricsPath = path.join(cellDir, "metrics.json");
    fs.writeFileSync(gradingPath, serializeGrading(grading), "utf8");
    fs.writeFileSync(metricsPath, serializeMetrics(metrics), "utf8");

    cells.push({ cellId, outcome, gradingPath, metricsPath });
  }

  const runOutcome =
    cells.length === 0
      ? "no-cells"
      : cells.some((cell) => cell.outcome === "fail")
        ? "failed"
        : cells.some((cell) => cell.outcome === "operational-failure")
          ? "operational-failure"
          : "passed";

  return { evalRunId, artifactRoot, outcome: runOutcome, cells };
}
