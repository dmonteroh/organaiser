import type { YamlMapping } from "../../src/cli/yaml.ts";

export type GradingOutcome = "pass" | "fail" | "not-applicable" | "operational-failure";

export interface GradingCheck {
  id: string;
  grader: "deterministic";
  outcome: GradingOutcome;
  detail: string | null;
}

export type ArtifactRead<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "unparseable"; reason: string };

export interface TransitionEvent {
  seq: number;
  taskId: string | null;
  fromStageId: string;
  result: string;
  target: string;
}

export interface EvalSnapshotArtifact {
  disposition: "pass" | "fail" | "skipped";
}

export interface ProcessArtifact {
  recordedPgids: readonly number[] | null;
  pid: number | null;
}

export interface FrozenCellBundle {
  cellDir: string;
  snapshot: ArtifactRead<EvalSnapshotArtifact>;
  process: ArtifactRead<ProcessArtifact>;
  stateTransitions: ArtifactRead<readonly TransitionEvent[]>;
  boardBefore: ArtifactRead<YamlMapping>;
  boardAfter: ArtifactRead<YamlMapping>;
  diff: ArtifactRead<string>;
}
