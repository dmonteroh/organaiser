import { TERMINAL_DISPOSITION_VALUES } from "../../src/engine/board-predicates.ts";
import type { YamlMapping, YamlValue } from "../../src/cli/yaml.ts";
import type { FrozenCellBundle, GradingCheck } from "./types.ts";

const ID = "task-disposition";
const TERMINAL_SET = new Set<string>(TERMINAL_DISPOSITION_VALUES);

function build(outcome: GradingCheck["outcome"], detail: string | null): GradingCheck {
  return { id: ID, grader: "deterministic", outcome, detail };
}

function tasksOf(mapping: YamlMapping): YamlMapping[] {
  const tasks = mapping.tasks;
  if (!Array.isArray(tasks)) return [];
  const result: YamlMapping[] = [];
  for (const task of tasks) {
    if (typeof task === "object" && task !== null && !Array.isArray(task)) {
      result.push(task as YamlMapping);
    }
  }
  return result;
}

function taskIdOf(task: YamlMapping): string {
  const value = task.id;
  return typeof value === "string" ? value : String(value);
}

function normalizeDisposition(value: YamlValue | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return null;
  if (value === "null") return null;
  return value;
}

export function gradeTaskDisposition(bundle: FrozenCellBundle): GradingCheck {
  if (bundle.snapshot.status === "missing") return build("operational-failure", "eval-snapshot.json is missing");
  if (bundle.snapshot.status === "unparseable") {
    return build("operational-failure", `eval-snapshot.json is unparseable: ${bundle.snapshot.reason}`);
  }
  if (bundle.boardAfter.status === "missing") return build("operational-failure", "board-after.yaml is missing");
  if (bundle.boardAfter.status === "unparseable") {
    return build("operational-failure", `board-after.yaml is unparseable: ${bundle.boardAfter.reason}`);
  }
  if (bundle.stateTransitions.status === "missing") return build("operational-failure", "state-transitions.jsonl is missing");
  if (bundle.stateTransitions.status === "unparseable") {
    return build("operational-failure", `state-transitions.jsonl is unparseable: ${bundle.stateTransitions.reason}`);
  }

  if (bundle.snapshot.value.disposition !== "pass") return build("not-applicable", null);

  const tasks = tasksOf(bundle.boardAfter.value);
  if (tasks.length === 0) return build("not-applicable", null);

  const sorted = [...bundle.stateTransitions.value].sort((a, b) => a.seq - b.seq);
  const lastTerminalByTask = new Map<string, string>();
  for (const event of sorted) {
    if (event.taskId === null) continue;
    if (TERMINAL_SET.has(event.target)) {
      lastTerminalByTask.set(event.taskId, event.target);
    }
  }

  const violations: string[] = [];
  for (const task of tasks) {
    const taskId = taskIdOf(task);
    const derived = lastTerminalByTask.get(taskId) ?? null;
    const recorded = normalizeDisposition(task.disposition);
    if (derived !== recorded) {
      violations.push(
        `task ${taskId}: derived disposition ${derived === null ? "(none)" : derived}, recorded disposition ${recorded === null ? "(none)" : recorded}`,
      );
    }
  }

  if (violations.length > 0) return build("fail", violations.join("\n"));
  return build("pass", null);
}
