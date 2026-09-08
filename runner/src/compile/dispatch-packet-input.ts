// Builds the `DevelopmentStageInput.packet` closure (`workflow-stages.ts:230`)
// that `dispatchEligible`'s `"implementation"` and `"integration"` branches
// (`scheduler.ts`) pass into `runDevelopmentStages` and the fallback
// `dispatchAttempt` call respectively. The `implementer` role (the
// `implement`, `fix-spec`, and `fix-quality` stages), the `integrator` role,
// and the `spec-reviewer`/`code-quality-reviewer` roles each receive a real,
// compiled packet; every other role receives the exact placeholder string
// `runAgentStage`'s own default already produces.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { compilePacket, type PacketInput, type PacketStageInput } from "./packet.ts";
import { nextAttemptRound } from "../engine/dispatch.ts";
import { DEVELOPMENT_STAGES } from "../engine/workflow-stages.ts";
import { INTEGRATION_STAGES } from "../engine/integration-stages.ts";
import { workflowAssetPath } from "../workflow-assets.ts";

const DEFAULT_IMPLEMENTER_TEMPLATE_PATH = workflowAssetPath("subagents/implementer-prompt.md");
const DEFAULT_INTEGRATOR_TEMPLATE_PATH = workflowAssetPath("subagents/integrator-prompt.md");
const DEFAULT_SPEC_REVIEWER_TEMPLATE_PATH = workflowAssetPath("subagents/spec-reviewer-prompt.md");
const DEFAULT_CODE_QUALITY_REVIEWER_TEMPLATE_PATH = workflowAssetPath("subagents/code-quality-reviewer-prompt.md");

const RESULT_CONTRACT_NOTES = [
  "- resultSchema: stage-result.schema.json",
  "- status: one of completed | questions | failed",
].join("\n");

const STAGE_VERDICTS = new Map<string, readonly string[]>(
  [...DEVELOPMENT_STAGES, ...INTEGRATION_STAGES].map((stage) => [stage.id, stage.verdicts]),
);

function reviewerResultContractNotes(stageId: string, role: string): string {
  const verdicts = STAGE_VERDICTS.get(stageId);
  if (!verdicts) {
    throw new Error(`no verdict enum registered for stage ${stageId} (role ${role})`);
  }
  return [
    "- resultSchema: stage-result.schema.json",
    "- status: one of completed | questions | failed",
    `- verdict: one of ${verdicts.join(" | ")}`,
  ].join("\n");
}

/**
 * Finds a line trimmed-equal to `## ${heading}` and collects every
 * subsequent `- `-prefixed line's trimmed, marker-stripped content, stopping
 * at the next `## `-prefixed line or end of file. Returns an empty array
 * when the heading is not present.
 */
export function extractBulletSection(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const headingLine = `## ${heading}`;
  const startIndex = lines.findIndex((line) => line.trim() === headingLine);
  if (startIndex === -1) return [];

  const items: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) items.push(line.slice(2).trim());
  }
  return items;
}

export interface DispatchPacketTask {
  id: string;
  title: string;
  briefPath: string | null;
}

export interface DispatchPacketOptions {
  db: DatabaseSync;
  runId: string;
  projectRoot: string;
}

/**
 * Returns the `(stageId, role, priorReport?) => string` closure
 * `DevelopmentStageInput.packet` expects. Built once per task dispatch; the
 * closure itself runs once per `kind: agent` stage the pipeline visits.
 */
export function buildDispatchPacketInput(
  task: DispatchPacketTask,
  opts: DispatchPacketOptions,
): (stageId: string, role: string, priorReport?: Record<string, unknown> | null) => string {
  return (stageId, role, priorReport) => {
    if (role !== "implementer" && role !== "integrator" && role !== "spec-reviewer" && role !== "code-quality-reviewer") {
      return `packet for task ${task.id} at stage ${stageId}`;
    }

    const buildStageInputs = (briefContent: string): PacketStageInput[] => {
      const stageInputs: PacketStageInput[] = [{ name: "task-brief", content: briefContent }];
      if (priorReport !== null && priorReport !== undefined) {
        stageInputs.push({ name: "prior-report", content: JSON.stringify(priorReport, null, 2) });
      }
      return stageInputs;
    };

    if (role === "implementer") {
      if (!task.briefPath) {
        throw new Error(`task ${task.id} has no brief_path; cannot build a real implementer packet`);
      }

      const briefContent = fs.readFileSync(path.resolve(opts.projectRoot, task.briefPath), "utf8");
      const round = nextAttemptRound(opts.db, opts.runId, task.id, stageId);

      const packetInput: PacketInput = {
        protocolVersion: "1",
        runId: opts.runId,
        taskId: task.id,
        attemptId: `${task.id}:${stageId}:${round}`,
        workflowId: "dev-workflow",
        workflowVersion: "0.0.0",
        stageId,
        roleId: role,
        objective: task.title,
        workingDirectory: opts.projectRoot,
        authorityTier: "standard",
        toolPolicy: "default",
        commandLayerPolicy: "default",
        deliverableSchema: "stage-result.schema.json",
        roleFilePath: DEFAULT_IMPLEMENTER_TEMPLATE_PATH,
        stageInputs: buildStageInputs(briefContent),
        readFirst: [],
        allowedPaths: [],
        forbiddenPaths: [],
        fileClaims: [],
        nonFileClaims: [],
        acceptanceCriteria: extractBulletSection(briefContent, "Acceptance Criteria").join("\n"),
        verificationCommands: extractBulletSection(briefContent, "Verification Commands").join("\n"),
        blockingRules: [],
        resultContractNotes: RESULT_CONTRACT_NOTES,
      };

      return compilePacket(packetInput);
    }

    if (role === "integrator") {
      let briefContent = "";
      try {
        if (task.briefPath) {
          briefContent = fs.readFileSync(path.resolve(opts.projectRoot, task.briefPath), "utf8");
        }
      } catch {
        briefContent = "";
      }
      const round = nextAttemptRound(opts.db, opts.runId, task.id, stageId);

      const packetInput: PacketInput = {
        protocolVersion: "1",
        runId: opts.runId,
        taskId: task.id,
        attemptId: `${task.id}:${stageId}:${round}`,
        workflowId: "dev-workflow",
        workflowVersion: "0.0.0",
        stageId,
        roleId: role,
        objective: task.title,
        workingDirectory: opts.projectRoot,
        authorityTier: "read-only",
        toolPolicy: "default",
        commandLayerPolicy: "default",
        deliverableSchema: "stage-result.schema.json",
        roleFilePath: DEFAULT_INTEGRATOR_TEMPLATE_PATH,
        stageInputs: buildStageInputs(briefContent),
        readFirst: [],
        allowedPaths: [],
        forbiddenPaths: [],
        fileClaims: [],
        nonFileClaims: [],
        acceptanceCriteria: extractBulletSection(briefContent, "Acceptance Criteria").join("\n"),
        verificationCommands: extractBulletSection(briefContent, "Verification Commands").join("\n"),
        blockingRules: [],
        resultContractNotes: RESULT_CONTRACT_NOTES,
      };

      return compilePacket(packetInput);
    }

    let briefContent = "";
    try {
      if (task.briefPath) {
        briefContent = fs.readFileSync(path.resolve(opts.projectRoot, task.briefPath), "utf8");
      }
    } catch {
      briefContent = "";
    }
    const round = nextAttemptRound(opts.db, opts.runId, task.id, stageId);

    const roleFilePath =
      role === "spec-reviewer" ? DEFAULT_SPEC_REVIEWER_TEMPLATE_PATH : DEFAULT_CODE_QUALITY_REVIEWER_TEMPLATE_PATH;

    const packetInput: PacketInput = {
      protocolVersion: "1",
      runId: opts.runId,
      taskId: task.id,
      attemptId: `${task.id}:${stageId}:${round}`,
      workflowId: "dev-workflow",
      workflowVersion: "0.0.0",
      stageId,
      roleId: role,
      objective: task.title,
      workingDirectory: opts.projectRoot,
      authorityTier: "read-only",
      toolPolicy: "default",
      commandLayerPolicy: "default",
      deliverableSchema: "stage-result.schema.json",
      roleFilePath,
      stageInputs: buildStageInputs(briefContent),
      readFirst: [],
      allowedPaths: [],
      forbiddenPaths: [],
      fileClaims: [],
      nonFileClaims: [],
      acceptanceCriteria: extractBulletSection(briefContent, "Acceptance Criteria").join("\n"),
      verificationCommands: extractBulletSection(briefContent, "Verification Commands").join("\n"),
      blockingRules: [],
      resultContractNotes: reviewerResultContractNotes(stageId, role),
    };

    return compilePacket(packetInput);
  };
}
