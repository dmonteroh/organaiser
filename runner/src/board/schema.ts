import fs from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

import { workflowAssetPath } from "../workflow-assets.ts";

export class BoardShapeError extends Error {
  errors: Array<{ path: string; message: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string }>) {
    super(message);
    this.name = "BoardShapeError";
    this.errors = errors;
  }
}

export interface BoardTaskEntry {
  workflowId: string;
  stageId: string;
}

export interface BoardClaimSet {
  files?: string[];
  nonFile?: string[];
}

export type VerificationCheck =
  | string
  | { id: string; argv: string[]; cwd?: string; timeoutSecs?: number }
  | { id: string; shell: true; command: string; cwd?: string; timeoutSecs?: number };

export interface BoardTask {
  id: string;
  title: string;
  briefPath: string;
  entry: BoardTaskEntry;
  dependencies: string[];
  priority: number;
  requiredWorkflowVersions: Record<string, string>;
  claims: "unknown" | BoardClaimSet;
  verification: VerificationCheck[];
  enabled: boolean;
}

export interface Board {
  apiVersion: "ai-workflows.dev/v1alpha1";
  kind: "Board";
  metadata: { id: string; contractVersion: string };
  spec: { tasks: BoardTask[] };
}

export function loadAndValidateBoardShape(board: unknown): asserts board is Board {
  const schema = JSON.parse(fs.readFileSync(workflowAssetPath("schemas/board.schema.json"), "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(schema);
  if (!validate(board)) {
    const errors = (validate.errors ?? []).map((error: ErrorObject) => ({
      path: error.instancePath,
      message: error.message ?? "invalid",
    }));
    const summary = errors
      .slice(0, 5)
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("; ");
    throw new BoardShapeError(`board failed schema validation: ${summary}`, errors);
  }
}
