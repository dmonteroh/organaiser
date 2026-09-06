import { loadAndValidateBoardShape, BoardShapeError, type Board, type BoardTask } from "./schema.ts";

export interface BoardValidationDiagnostic {
  path: string;
  message: string;
}

export interface BoardValidationResult {
  valid: boolean;
  errors: BoardValidationDiagnostic[];
}

function isEmptyClaimSet(claims: BoardTask["claims"]): boolean {
  if (claims === "unknown") return false;
  if (claims === null || typeof claims !== "object") return true;
  const files = Array.isArray(claims.files) ? claims.files : [];
  const nonFile = Array.isArray(claims.nonFile) ? claims.nonFile : [];
  return files.length === 0 && nonFile.length === 0;
}

function checkUniqueIds(tasks: readonly BoardTask[], errors: BoardValidationDiagnostic[]): Set<string> {
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      errors.push({ path: `/spec/tasks[id=${task.id}]/id`, message: `duplicate task id: ${task.id}` });
      continue;
    }
    seen.add(task.id);
  }
  return seen;
}

function checkDependenciesResolve(
  tasks: readonly BoardTask[],
  knownIds: ReadonlySet<string>,
  errors: BoardValidationDiagnostic[],
): void {
  for (const task of tasks) {
    for (const dep of task.dependencies ?? []) {
      if (!knownIds.has(dep)) {
        errors.push({
          path: `/spec/tasks[id=${task.id}]/dependencies`,
          message: `task "${task.id}" depends on unknown task id "${dep}"`,
        });
      }
    }
  }
}

function checkAcyclic(tasks: readonly BoardTask[], errors: BoardValidationDiagnostic[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, "visiting" | "done">();
  const reportedCycles = new Set<string>();

  function visit(id: string, chain: readonly string[]): void {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const cycle = [...chain, id].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        reportedCycles.add(cycle);
        errors.push({ path: "/spec/tasks", message: `dependency cycle detected: ${cycle}` });
      }
      return;
    }
    state.set(id, "visiting");
    const task = byId.get(id);
    if (task) {
      for (const dep of task.dependencies ?? []) {
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

function checkClaimsPresent(tasks: readonly BoardTask[], errors: BoardValidationDiagnostic[]): void {
  for (const task of tasks) {
    if (task.claims === undefined) {
      errors.push({ path: `/spec/tasks[id=${task.id}]/claims`, message: `task "${task.id}" is missing claims` });
      continue;
    }
    if (isEmptyClaimSet(task.claims)) {
      errors.push({
        path: `/spec/tasks[id=${task.id}]/claims`,
        message: `task "${task.id}" has an empty claims object; use "unknown" or a non-empty {files, nonFile} set`,
      });
    }
  }
}

function checkBriefAndEntry(tasks: readonly BoardTask[], errors: BoardValidationDiagnostic[]): void {
  for (const task of tasks) {
    if (typeof task.briefPath !== "string" || task.briefPath.trim().length === 0) {
      errors.push({
        path: `/spec/tasks[id=${task.id}]/briefPath`,
        message: `task "${task.id}" has no non-empty briefPath`,
      });
    }
    const workflowId = task.entry?.workflowId;
    const stageId = task.entry?.stageId;
    const entryWellFormed =
      typeof workflowId === "string" &&
      workflowId.trim().length > 0 &&
      typeof stageId === "string" &&
      stageId.trim().length > 0;
    if (!entryWellFormed) {
      errors.push({
        path: `/spec/tasks[id=${task.id}]/entry`,
        message: `task "${task.id}" has a malformed entry.{workflowId, stageId} pair`,
      });
    }
  }
}

function checkVerificationChecks(tasks: readonly BoardTask[], errors: BoardValidationDiagnostic[]): void {
  for (const task of tasks) {
    (task.verification ?? []).forEach((check, index) => {
      if (typeof check === "string") {
        errors.push({
          path: `/spec/tasks[id=${task.id}]/verification[${index}]`,
          message:
            `task "${task.id}" has a bare-string verification check; goals-spec 9.2 requires an explicit ` +
            `shell execution mode (an argv or shell form)`,
        });
      }
    });
  }
}

export function validateBoard(board: unknown): BoardValidationResult {
  let shaped: Board;
  try {
    loadAndValidateBoardShape(board);
    shaped = board as Board;
  } catch (err) {
    if (err instanceof BoardShapeError) {
      return { valid: false, errors: err.errors };
    }
    throw err;
  }

  const errors: BoardValidationDiagnostic[] = [];
  const tasks = shaped.spec.tasks;

  const knownIds = checkUniqueIds(tasks, errors);
  checkDependenciesResolve(tasks, knownIds, errors);
  checkAcyclic(tasks, errors);
  checkClaimsPresent(tasks, errors);
  checkBriefAndEntry(tasks, errors);
  checkVerificationChecks(tasks, errors);

  return { valid: errors.length === 0, errors };
}
