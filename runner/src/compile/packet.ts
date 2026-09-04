// The four-section worker packet compiler (target architecture section 10; goals spec
// section 16). Compiles runner-authored header, verbatim role template, untrusted stage
// inputs, and a trailer into one packet, delimited so a later source cannot impersonate
// an earlier one.

import fs from "node:fs";

import { fileSha256 } from "./artifact-validator.ts";

export type PacketSection = "Packet Header" | "Instructions" | "Inputs" | "Result Contract";

/** One goals spec section 16 field's rendered location. */
export interface PacketFieldRendering {
  section: PacketSection;
  /** The literal bullet-key prefix (ending ": ") or the `###` subsection heading. */
  locus: string;
}

/**
 * One entry per goals spec section 16 field (all twenty-three), keyed by its snake_case
 * name. Five fields render as the fixture spellings P3d-ii already froze; the rest are
 * lines and subsections this compiler adds. Tests read this table directly rather than
 * a second hardcoded list.
 */
export const PACKET_FIELD_RENDERING: Readonly<Record<string, PacketFieldRendering>> = {
  role_id: { section: "Packet Header", locus: "- role: " },
  workflow_id: { section: "Packet Header", locus: "- workflow: " },
  stage_id: { section: "Packet Header", locus: "- stage: " },
  workflow_version: { section: "Packet Header", locus: "- contractVersion: " },
  deliverable_schema: { section: "Packet Header", locus: "- resultSchema: " },
  protocol_version: { section: "Packet Header", locus: "- protocolVersion: " },
  run_id: { section: "Packet Header", locus: "- runId: " },
  task_id: { section: "Packet Header", locus: "- taskId: " },
  attempt_id: { section: "Packet Header", locus: "- attemptId: " },
  objective: { section: "Packet Header", locus: "- objective: " },
  working_directory: { section: "Packet Header", locus: "- workingDirectory: " },
  authority_tier: { section: "Packet Header", locus: "- authorityTier: " },
  tool_policy: { section: "Packet Header", locus: "- toolPolicy: " },
  command_layer_policy: { section: "Packet Header", locus: "- commandLayerPolicy: " },
  canonical_inputs: { section: "Packet Header", locus: "### Canonical Inputs" },
  read_first: { section: "Packet Header", locus: "### Read-First" },
  allowed_paths: { section: "Packet Header", locus: "### Allowed Paths" },
  forbidden_paths: { section: "Packet Header", locus: "### Forbidden Paths" },
  file_claims: { section: "Packet Header", locus: "### File Claims" },
  non_file_claims: { section: "Packet Header", locus: "### Non-File Claims" },
  acceptance_criteria: { section: "Result Contract", locus: "### Acceptance Criteria" },
  verification_commands: { section: "Result Contract", locus: "### Verification Commands" },
  blocking_rules: { section: "Result Contract", locus: "### Blocking Rules" },
};

export interface PacketStageInput {
  name: string;
  content: string;
}

export interface PacketInput {
  protocolVersion: string;
  runId: string;
  taskId: string;
  attemptId: string;
  workflowId: string;
  workflowVersion: string;
  stageId: string;
  roleId: string;
  objective: string;
  workingDirectory: string;
  authorityTier: string;
  toolPolicy: string;
  commandLayerPolicy: string;
  deliverableSchema: string;
  /** Path to the role template file, read from disk for `## Instructions` and hashed for the role binding. */
  roleFilePath: string;
  /**
   * The value shown in the frozen `- template: <v>` line. Defaults to `roleFilePath`.
   * Kept separate so a caller can display the role template's canonical repository-
   * relative path while `roleFilePath` itself resolves to wherever the file actually
   * lives on disk (the golden fixtures freeze the former).
   */
  templateDisplayPath?: string;
  stageInputs: readonly PacketStageInput[];
  readFirst: readonly string[];
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
  fileClaims: readonly string[];
  nonFileClaims: readonly string[];
  acceptanceCriteria: string;
  verificationCommands: string;
  blockingRules: readonly string[];
  /**
   * The Result Contract's schema/status/verdict boilerplate, verbatim (not a section 16
   * field; supplied whole so it can be reproduced without this compiler re-deriving
   * per-role verdict enums it has no other reason to know).
   */
  resultContractNotes: string;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function heading(name: PacketSection, body: string): string {
  return `## ${name}\n\n${body}`;
}

// Guards against untrusted stage-input content that mimics the untrusted-block
// delimiter or a runner-authored role-binding line, so it cannot be misread as
// closing the block early or as a second, forged binding.
function escapeUntrustedContent(content: string): string {
  return content
    .replace(/<<<UNTRUSTED/g, "\\<<<UNTRUSTED")
    .replace(/UNTRUSTED>>>/g, "\\UNTRUSTED>>>")
    .replace(/^(Role file: )/gm, "\\$1")
    .replace(/^(Role sha256: )/gm, "\\$1");
}

function renderStageInput(input: PacketStageInput): string {
  const safeContent = escapeUntrustedContent(input.content);
  return [
    `### Input: ${input.name} (untrusted)`,
    "",
    `<<<UNTRUSTED ${input.name}`,
    safeContent,
    "UNTRUSTED>>>",
  ].join("\n");
}

function renderPacketHeader(input: PacketInput): string {
  const roleSha256 = fileSha256(input.roleFilePath);
  const scalars = [
    `- role: ${input.roleId}`,
    `- workflow: ${input.workflowId}`,
    `- stage: ${input.stageId}`,
    `- contractVersion: ${input.workflowVersion}`,
    `- resultSchema: ${input.deliverableSchema}`,
    `- template: ${input.templateDisplayPath ?? input.roleFilePath}`,
    `- Role file: ${input.roleFilePath}`,
    `- Role sha256: ${roleSha256}`,
    `- protocolVersion: ${input.protocolVersion}`,
    `- runId: ${input.runId}`,
    `- taskId: ${input.taskId}`,
    `- attemptId: ${input.attemptId}`,
    `- objective: ${input.objective}`,
    `- workingDirectory: ${input.workingDirectory}`,
    `- authorityTier: ${input.authorityTier}`,
    `- toolPolicy: ${input.toolPolicy}`,
    `- commandLayerPolicy: ${input.commandLayerPolicy}`,
  ].join("\n");

  const subsections = [
    `### Canonical Inputs\n${bullets(input.stageInputs.map((stageInput) => stageInput.name))}`,
    `### Read-First\n${bullets(input.readFirst)}`,
    `### Allowed Paths\n${bullets(input.allowedPaths)}`,
    `### Forbidden Paths\n${bullets(input.forbiddenPaths)}`,
    `### File Claims\n${bullets(input.fileClaims)}`,
    `### Non-File Claims\n${bullets(input.nonFileClaims)}`,
  ].join("\n\n");

  return heading("Packet Header", `${scalars}\n\n${subsections}`);
}

function renderInstructions(input: PacketInput): string {
  const templateBody = fs.readFileSync(input.roleFilePath, "utf8").replace(/\s+$/, "");
  return heading("Instructions", templateBody);
}

function renderInputs(input: PacketInput): string {
  const blocks = input.stageInputs.map(renderStageInput).join("\n\n");
  return heading("Inputs", blocks);
}

function renderResultContract(input: PacketInput): string {
  const body = [
    input.resultContractNotes.replace(/\s+$/, ""),
    `### Acceptance Criteria\n\n${input.acceptanceCriteria.replace(/\s+$/, "")}`,
    `### Verification Commands\n\n${input.verificationCommands.replace(/\s+$/, "")}`,
    `### Blocking Rules\n${bullets(input.blockingRules)}`,
  ].join("\n\n");
  return heading("Result Contract", body);
}

export function compilePacket(input: PacketInput): string {
  return [
    renderPacketHeader(input),
    renderInstructions(input),
    renderInputs(input),
    renderResultContract(input),
  ].join("\n\n");
}

const TOP_LEVEL_HEADING_LINES: ReadonlySet<string> = new Set(
  (["Packet Header", "Instructions", "Inputs", "Result Contract"] as const).map((name) => `## ${name}`),
);

/**
 * Extracts one `## <heading>` region (heading line through, but excluding, the next
 * top-level heading line or end of file), trimmed of trailing blank lines. Only the
 * four canonical top-level headings end a region: an untrusted stage input may itself
 * contain a `## `-prefixed markdown heading (real task briefs do), and that must not be
 * mistaken for a packet section boundary.
 */
export function extractPacketSection(text: string, section: PacketSection): string {
  const lines = text.split("\n");
  const startIndex = lines.findIndex((line) => line === `## ${section}`);
  if (startIndex === -1) {
    throw new Error(`section not found: ${section}`);
  }
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (TOP_LEVEL_HEADING_LINES.has(lines[i])) {
      endIndex = i;
      break;
    }
  }
  return lines
    .slice(startIndex, endIndex)
    .join("\n")
    .replace(/\s+$/, "");
}
