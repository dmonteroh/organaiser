// Builds the `DevelopmentStageInput.packet` closure (`workflow-stages.ts:230`)
// that `dispatchEligible`'s `"implementation"` and `"integration"` branches
// (`scheduler.ts`) pass into `runDevelopmentStages` and the fallback
// `dispatchAttempt` call respectively. The `implementer` role (the
// `implement`, `fix-spec`, and `fix-quality` stages) and the `integrator`
// role each receive a real, compiled packet; every other role receives the
// exact placeholder string `runAgentStage`'s own default already produces.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { compilePacket, type PacketInput } from "./packet.ts";
import { nextAttemptRound } from "../engine/dispatch.ts";

const DEFAULT_IMPLEMENTER_TEMPLATE_PATH = fileURLToPath(
  new URL("../../../workflows/subagents/implementer-prompt.md", import.meta.url),
);

const DEFAULT_INTEGRATOR_TEMPLATE_PATH = fileURLToPath(
  new URL("../../../workflows/subagents/integrator-prompt.md", import.meta.url),
);

const RESULT_CONTRACT_NOTES = [
  "- resultSchema: stage-result.schema.json",
  "- status: one of completed | questions | failed",
].join("\n");

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
 * Returns the `(stageId, role) => string` closure `DevelopmentStageInput.packet`
 * expects. Built once per task dispatch; the closure itself runs once per
 * `kind: agent` stage the pipeline visits.
 */
export function buildDispatchPacketInput(
  task: DispatchPacketTask,
  opts: DispatchPacketOptions,
): (stageId: string, role: string) => string {
  return (stageId, role) => {
    if (role !== "implementer" && role !== "integrator") {
      return `packet for task ${task.id} at stage ${stageId}`;
    }

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
        stageInputs: [{ name: "task-brief", content: briefContent }],
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
      stageInputs: [{ name: "task-brief", content: briefContent }],
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
  };
}
