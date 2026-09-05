// Reviewer worktree lifecycle and finding validation/routing for
// `review-spec`/`review-quality` (`workflows/manifests/development.v1.yaml`).
// This module supplies the `reviewerWorkspace` resolver `workflow-stages.ts`
// consults for `authority: read-only` stages; it never calls `createWorkspace`
// or `removeWorkspace` for any other stage kind, and never reaches into
// `dispatch.ts` or `scheduler.ts`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { createWorkspace, removeWorkspace, type WorkspaceHandle } from "../git/workspace.ts";
import { createReportValidator, ReportValidationError, type ReportSchemaError } from "../compile/report-validator.ts";
import type { ReviewerWorkspaceHandle, ReviewerWorkspaceRequest, ReviewerWorkspaceResolver } from "./workflow-stages.ts";

const REVIEW_FINDING_SCHEMA_PATH = fileURLToPath(
  new URL("../../../workflows/schemas/review-finding.schema.json", import.meta.url),
);

// `Ajv` (the plain, non-2020 build `report-validator.ts` constructs) has no
// registered meta-schema for this file's own declared `$schema`
// (`https://json-schema.org/draft/2020-12/schema`); stripping it here mirrors
// `fake.ts`'s own bundling of this same file and lets Ajv compile the rest of
// the document, which uses no 2020-only keyword, under its default dialect.
function loadReviewFindingSchema(): object {
  const schema = JSON.parse(readFileSync(REVIEW_FINDING_SCHEMA_PATH, "utf8")) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

const reviewFindingValidator = createReportValidator(loadReviewFindingSchema());

export interface ReviewFindingProof {
  path: string;
  line: number;
  snippet: string;
}

export interface ReviewFinding {
  id: string;
  severity: "critical" | "important" | "minor";
  summary: string;
  path: string;
  line?: number | null;
  proof?: ReviewFindingProof;
  suggestedFix?: string;
}

export interface RejectedFinding {
  raw: unknown;
  errors: readonly ReportSchemaError[];
}

export interface FindingPartition {
  blocking: readonly ReviewFinding[];
  minor: readonly ReviewFinding[];
  rejected: readonly RejectedFinding[];
}

// Validates every raw finding against `review-finding.schema.json` before it
// is trusted: a `critical`/`important` finding lacking `proof` fails that
// schema's conditional `required` and lands in `rejected`, never `blocking`.
export function partitionFindings(findings: readonly unknown[] | undefined): FindingPartition {
  const blocking: ReviewFinding[] = [];
  const minor: ReviewFinding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const raw of findings ?? []) {
    try {
      const finding = reviewFindingValidator.validateObject(raw) as unknown as ReviewFinding;
      if (finding.severity === "minor") {
        minor.push(finding);
      } else {
        blocking.push(finding);
      }
    } catch (err) {
      if (err instanceof ReportValidationError) {
        rejected.push({ raw, errors: err.errors });
      } else {
        throw err;
      }
    }
  }

  return { blocking, minor, rejected };
}

// The repair packet `fix-spec`/`fix-quality` receive: accepted blocking
// findings only. Callers pass `partition.blocking` here, never
// `partition.minor` or `partition.rejected` — a `minor` finding is never in
// the resulting packet.
export function buildRepairPacket(blocking: readonly ReviewFinding[]): string {
  return JSON.stringify({ findings: blocking });
}

export interface ReviewerWorkspaceConfig {
  db: DatabaseSync;
  projectRoot: string;
  root: string;
  branchPrefix: string;
  taskKey: string;
  reviewedRef: () => string;
}

// Builds the `reviewerWorkspace` resolver `workflow-stages.ts`'s driver calls
// for `review-spec`/`review-quality`. Each call creates a fresh worktree at
// `config.reviewedRef()`, on a branch named from a `taskKey` of
// `<config.taskKey>-<stageId>-r<round>` so two rounds of the same review on
// the same task never collide; the returned `release` removes both the
// worktree and its branch.
export function createReviewerWorkspaceResolver(config: ReviewerWorkspaceConfig): ReviewerWorkspaceResolver {
  return async ({ runId, taskId, stageId, round }: ReviewerWorkspaceRequest): Promise<ReviewerWorkspaceHandle> => {
    const taskKey = `${config.taskKey}-${stageId}-r${round}`;
    const workspace: WorkspaceHandle = await createWorkspace({
      mode: "worktree",
      db: config.db,
      projectRoot: config.projectRoot,
      runId,
      taskId,
      taskKey,
      ref: config.reviewedRef(),
      root: config.root,
      branchPrefix: config.branchPrefix,
    });

    return {
      workspace,
      release: async () => {
        await removeWorkspace(workspace, { db: config.db, projectRoot: config.projectRoot, runId });
      },
    };
  };
}
