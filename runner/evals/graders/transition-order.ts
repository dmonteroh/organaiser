import { TERMINAL_DISPOSITION_VALUES } from "../../src/engine/board-predicates.ts";
import { LEGAL_TRANSITIONS_BY_ID } from "./legal-order.ts";
import type { FrozenCellBundle, GradingCheck, TransitionEvent } from "./types.ts";

const ID = "transition-order";
const TERMINAL_SET = new Set<string>(TERMINAL_DISPOSITION_VALUES);

function build(outcome: GradingCheck["outcome"], detail: string | null): GradingCheck {
  return { id: ID, grader: "deterministic", outcome, detail };
}

export function gradeTransitionOrder(bundle: FrozenCellBundle): GradingCheck {
  const read = bundle.stateTransitions;
  if (read.status === "missing") return build("operational-failure", "state-transitions.jsonl is missing");
  if (read.status === "unparseable") {
    return build("operational-failure", `state-transitions.jsonl is unparseable: ${read.reason}`);
  }

  const events = read.value;
  if (events.length === 0) return build("not-applicable", null);

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const violations: string[] = [];
  const previousByTask = new Map<string, TransitionEvent>();

  for (const event of sorted) {
    const taskKey = event.taskId ?? "";
    const previous = previousByTask.get(taskKey);
    const legal = LEGAL_TRANSITIONS_BY_ID.get(event.fromStageId);

    if (!legal) {
      violations.push(`task ${taskKey || "(none)"}: seq ${event.seq} has no legal-order entry for fromStageId "${event.fromStageId}"`);
    } else if (legal.transitions[event.result] !== event.target) {
      const expected = legal.transitions[event.result] ?? "(no legal target for this result)";
      violations.push(
        `task ${taskKey || "(none)"}: seq ${event.seq} result "${event.result}" from "${event.fromStageId}" targets "${event.target}", expected "${expected}"`,
      );
    }

    if (previous && previous.target !== event.fromStageId) {
      violations.push(
        `task ${taskKey || "(none)"}: seq ${event.seq} fromStageId "${event.fromStageId}" does not match predecessor's target "${previous.target}" at seq ${previous.seq}`,
      );
    }
    if (previous && TERMINAL_SET.has(previous.target)) {
      violations.push(
        `task ${taskKey || "(none)"}: seq ${event.seq} occurs after task reached terminal disposition "${previous.target}" at seq ${previous.seq}`,
      );
    }

    previousByTask.set(taskKey, event);
  }

  if (violations.length > 0) return build("fail", violations.join("\n"));
  return build("pass", null);
}
