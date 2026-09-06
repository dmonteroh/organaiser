import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";

export class ImportMarkdownError extends Error {
  uncertainties: string[];

  constructor(message: string, uncertainties: string[] = []) {
    super(message);
    this.name = "ImportMarkdownError";
    this.uncertainties = uncertainties;
  }
}

interface BoardTaskEntry {
  workflowId: string;
  stageId: string;
}

interface BoardClaims {
  files: string[];
  nonFile: string[];
}

interface BoardTask {
  id: string;
  title: string;
  briefPath: string;
  entry: BoardTaskEntry;
  dependencies: string[];
  priority: number;
  requiredWorkflowVersions: Record<string, string>;
  claims: "unknown" | BoardClaims;
  verification: string[];
  enabled: boolean;
}

interface Board {
  apiVersion: "ai-workflows.dev/v1alpha1";
  kind: "Board";
  metadata: { id: string; contractVersion: string };
  spec: { tasks: BoardTask[] };
}

export interface ImportMarkdownResult {
  board: Board;
  uncertainties: string[];
}

const TASKS_TABLE_HEADER = "| Id | Title | Brief | Status | Depends on | Parallel | Claims | Branch |";

interface TableBlock {
  header: string;
  rows: string[][];
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!isTableLine(trimmed)) return false;
  const cells = splitRow(trimmed);
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, trimmed.endsWith("|") ? -1 : undefined);
  return inner.split("|").map((cell) => cell.trim());
}

function findTableBlocks(input: string): TableBlock[] {
  const lines = input.split(/\r?\n/);
  const blocks: TableBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (isTableLine(line) && i + 1 < lines.length && isSeparatorLine(lines[i + 1] as string)) {
      const header = line.trim();
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableLine(lines[j] as string)) {
        rows.push(splitRow(lines[j] as string));
        j++;
      }
      blocks.push({ header, rows });
      i = j;
    } else {
      i++;
    }
  }
  return blocks;
}

function headerCells(header: string): string[] {
  return splitRow(header);
}

function isTasksTableHeader(header: string): boolean {
  return headerCells(header).join(" | ") === headerCells(TASKS_TABLE_HEADER).join(" | ");
}

const TRAILING_PAREN = /\s*\([^)]*\)\s*$/;

function splitCell(cell: string): string[] {
  return cell
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function mapDependencies(cell: string): string[] {
  if (cell.trim().toLowerCase() === "none") return [];
  return splitCell(cell);
}

function mapClaims(cell: string): "unknown" | BoardClaims {
  const trimmed = cell.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "none" || trimmed.toLowerCase() === "unknown") {
    return "unknown";
  }
  const parts = splitCell(cell).map((part) => part.replace(TRAILING_PAREN, "").trim());
  return { files: parts, nonFile: [] };
}

interface StatusMapping {
  enabled: boolean;
  entry: BoardTaskEntry;
  uncertainty: ((rowId: string) => string) | null;
}

const STATUS_MAP: Readonly<Record<string, StatusMapping>> = {
  drafted: {
    enabled: true,
    entry: { workflowId: "task-refinement", stageId: "analyst-initial" },
    uncertainty: null,
  },
  refining: {
    enabled: true,
    entry: { workflowId: "task-refinement", stageId: "analyst-initial" },
    uncertainty: null,
  },
  "implementation-ready": {
    enabled: true,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: null,
  },
  "in-progress": {
    enabled: true,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: (rowId: string) =>
      `task ${rowId}: no live process at import time; re-entered fresh`,
  },
  running: {
    enabled: true,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: (rowId: string) =>
      `task ${rowId}: no live process at import time; re-entered fresh`,
  },
  blocked: {
    enabled: false,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: (rowId: string) =>
      `task ${rowId}: blocked on an unresolved dependency/decision; no confident entry stage, disabled`,
  },
  "in-review": {
    enabled: false,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: (rowId: string) =>
      `task ${rowId}: ambiguous whether spec-review or quality-review; disabled`,
  },
  parked: {
    enabled: false,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: (rowId: string) =>
      `task ${rowId}: awaiting operator; no confident entry stage, disabled`,
  },
  umbrella: {
    enabled: false,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: (rowId: string) =>
      `task ${rowId}: parent/umbrella row, not directly dispatchable; disabled`,
  },
  integrated: {
    enabled: false,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: null,
  },
  superseded: {
    enabled: false,
    entry: { workflowId: "dev-workflow", stageId: "implement" },
    uncertainty: null,
  },
};

function boardSchemaPath(): string {
  return fileURLToPath(new URL("../../../workflows/schemas/board.schema.json", import.meta.url));
}

function validateBoardAgainstSchema(board: unknown, uncertainties: readonly string[]): void {
  const schema = JSON.parse(fs.readFileSync(boardSchemaPath(), "utf8")) as object;
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
    throw new ImportMarkdownError(`board failed schema validation: ${summary}`, [...uncertainties]);
  }
}

function checkUniqueIdsAndAcyclic(tasks: readonly BoardTask[], uncertainties: readonly string[]): void {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new ImportMarkdownError(`duplicate task id: ${task.id}`, [...uncertainties]);
    }
    seen.add(task.id);
  }

  const byId = new Map<string, BoardTask>(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();

  function visit(id: string, chain: string[]): void {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      throw new ImportMarkdownError(`dependency cycle detected: ${[...chain, id].join(" -> ")}`, [...uncertainties]);
    }
    state.set(id, "visiting");
    const task = byId.get(id);
    if (task) {
      for (const dep of task.dependencies) {
        if (!byId.has(dep)) continue;
        visit(dep, [...chain, id]);
      }
    }
    state.set(id, "done");
  }

  for (const task of tasks) {
    visit(task.id, []);
  }
}

function metadataIdFromOutputPath(outputPath: string): string {
  const base = path.basename(outputPath, path.extname(outputPath));
  return base.length > 0 ? base : "imported-board";
}

export function importMarkdown(input: string, outputPath: string): ImportMarkdownResult {
  const uncertainties: string[] = [];
  const blocks = findTableBlocks(input);

  const tasksTables: TableBlock[] = [];
  const skippedTables: TableBlock[] = [];
  for (const block of blocks) {
    if (isTasksTableHeader(block.header)) {
      tasksTables.push(block);
    } else {
      skippedTables.push(block);
    }
  }

  if (tasksTables.length !== 1) {
    throw new ImportMarkdownError(
      `expected exactly one Tasks table (header "${TASKS_TABLE_HEADER}"), found ${tasksTables.length}`,
      [...uncertainties],
    );
  }

  for (const skipped of skippedTables) {
    uncertainties.push(`skipped table with header "${skipped.header}" (not the recognized Tasks table shape)`);
  }

  const tasksTable = tasksTables[0] as TableBlock;
  const tasks: BoardTask[] = [];

  tasksTable.rows.forEach((row, index) => {
    const ordinal = index + 1;
    const [idCell, titleCell, briefCell, statusCell, dependsCell, , claimsCell] = row;
    const id = (idCell ?? "").trim();
    const title = (titleCell ?? "").trim();
    const briefPath = (briefCell ?? "").trim();
    const status = (statusCell ?? "").trim();

    const mapping = STATUS_MAP[status];
    if (!mapping) {
      throw new ImportMarkdownError(`task ${id}: unrecognized Status value "${status}"`, [...uncertainties]);
    }
    if (mapping.uncertainty) {
      uncertainties.push(mapping.uncertainty(id));
    }

    uncertainties.push(`task ${id}: priority defaulted to ${ordinal * 100} (no source column)`);
    uncertainties.push(`task ${id}: verification defaulted to [] (no source column)`);
    uncertainties.push(`task ${id}: requiredWorkflowVersions defaulted to {} (no source column)`);

    tasks.push({
      id,
      title,
      briefPath,
      entry: { workflowId: mapping.entry.workflowId, stageId: mapping.entry.stageId },
      dependencies: mapDependencies(dependsCell ?? ""),
      priority: ordinal * 100,
      requiredWorkflowVersions: {},
      claims: mapClaims(claimsCell ?? ""),
      verification: [],
      enabled: mapping.enabled,
    });
  });

  const board: Board = {
    apiVersion: "ai-workflows.dev/v1alpha1",
    kind: "Board",
    metadata: {
      id: metadataIdFromOutputPath(outputPath),
      contractVersion: "1.0.0",
    },
    spec: { tasks },
  };

  validateBoardAgainstSchema(board, uncertainties);
  checkUniqueIdsAndAcyclic(board.spec.tasks, uncertainties);

  return { board, uncertainties };
}
