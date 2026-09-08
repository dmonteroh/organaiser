import fs from "node:fs";
import path from "node:path";

import { parseYamlText, type YamlMapping } from "../../src/cli/yaml.ts";
import type { ArtifactRead, EvalSnapshotArtifact, FrozenCellBundle, ProcessArtifact, TransitionEvent } from "./types.ts";

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readText(cellDir: string, name: string): string {
  return fs.readFileSync(path.join(cellDir, name), "utf8");
}

function readJsonArtifact<T>(cellDir: string, name: string): ArtifactRead<T> {
  try {
    const parsed: unknown = JSON.parse(readText(cellDir, name));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "unparseable", reason: `${name} does not contain a JSON object` };
    }
    return { status: "ok", value: parsed as T };
  } catch (err) {
    if (isEnoent(err)) return { status: "missing" };
    return { status: "unparseable", reason: errorReason(err) };
  }
}

function readYamlArtifact(cellDir: string, name: string): ArtifactRead<YamlMapping> {
  try {
    const value = parseYamlText(readText(cellDir, name), name);
    return { status: "ok", value };
  } catch (err) {
    if (isEnoent(err)) return { status: "missing" };
    return { status: "unparseable", reason: errorReason(err) };
  }
}

function readTextArtifact(cellDir: string, name: string): ArtifactRead<string> {
  try {
    return { status: "ok", value: readText(cellDir, name) };
  } catch (err) {
    if (isEnoent(err)) return { status: "missing" };
    return { status: "unparseable", reason: errorReason(err) };
  }
}

function readStateTransitions(cellDir: string): ArtifactRead<readonly TransitionEvent[]> {
  try {
    const text = readText(cellDir, "state-transitions.jsonl");
    const lines = text.split("\n").filter((line) => line.length > 0);
    const events: TransitionEvent[] = [];
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.type !== "task.transitioned") continue;
      const payload = JSON.parse(row.payload as string) as { fromStageId: string; result: string; target: string };
      events.push({
        seq: row.seq as number,
        taskId: (row.task_id as string | null | undefined) ?? null,
        fromStageId: payload.fromStageId,
        result: payload.result,
        target: payload.target,
      });
    }
    return { status: "ok", value: events };
  } catch (err) {
    if (isEnoent(err)) return { status: "missing" };
    return { status: "unparseable", reason: errorReason(err) };
  }
}

export function readFrozenCell(cellDir: string): FrozenCellBundle {
  return {
    cellDir,
    snapshot: readJsonArtifact<EvalSnapshotArtifact>(cellDir, "eval-snapshot.json"),
    process: readJsonArtifact<ProcessArtifact>(cellDir, "process.json"),
    stateTransitions: readStateTransitions(cellDir),
    boardBefore: readYamlArtifact(cellDir, "board-before.yaml"),
    boardAfter: readYamlArtifact(cellDir, "board-after.yaml"),
    diff: readTextArtifact(cellDir, "diff.patch"),
    gitBefore: readTextArtifact(cellDir, "git-before.txt"),
    gitAfter: readTextArtifact(cellDir, "git-after.txt"),
    commitGraph: readTextArtifact(cellDir, "git-commit-graph.txt"),
  };
}
