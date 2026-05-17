---
id: task-refinement
name: Task Refinement Workflow
triggers: [task-refinement, planning, spec-writing]
---

# Task Refinement Workflow Contract

Iterative confidence-building process that transforms a raw task into an implementation-ready brief. Two-pass analysis with architectural review and operator escalation between passes.

This workflow produces enriched task documents, not code. It is a pre-implementation quality gate.

## Roles

### analyst

- Template: `subagents/analyst-prompt.md`
- Mode: read-only analysis (must NOT write production code or create project files)
- Constraints:
  - Must read the actual source files that the task will touch — not just reason abstractly
  - Must produce a file-level implementation sketch with modification order
  - Must rate confidence across structured dimensions, not give a single pass/fail
  - Must explicitly record blockers, questions, vagueness, and risks as separate categories
  - If tempted to start implementing: STOP. The deliverable is the analysis, not code.

### architect

- Template: `subagents/architect-prompt.md`
- Mode: decision-making (may update the task document, must NOT write production code)
- Constraints:
  - Must review analyst findings and make concrete decisions — not defer everything
  - Must answer questions where the codebase provides sufficient signal
  - Must classify remaining items as operator-required or self-resolvable
  - Must not weaken analyst-identified risks without explicit justification

## Confidence Dimensions

The analyst rates each dimension as `confident`, `uncertain`, or `blocked`:

| Dimension                 | What it measures                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Requirements clarity      | Are acceptance criteria specific and testable? Can the implementer know when they're done?                                               |
| Technical feasibility     | Has the analyst verified the approach works against the actual codebase? Are there hidden constraints?                                   |
| Scope boundaries          | Is it clear what's in scope and what's not? Are there adjacent concerns that could expand the task?                                      |
| Dependency identification | Are all prerequisite tasks, external services, and shared code paths identified?                                                         |
| Risk exposure             | Are failure modes, rollback needs, and testing gaps identified and classified?                                                           |
| Agent implementability    | Can a single agent session realistically hold the full task in context and converge on a working implementation? See sizing rules below. |

A task is **implementation-ready** when all dimensions are `confident`, zero blockers remain, and the task is not classified as an umbrella/split-required parent.

## Task Sizing Rules

A task that passes all confidence dimensions can still fail if it exceeds agent working capacity. The analyst must flag `agent implementability` as `blocked` if **any** of these hold:

- The task spans **more than 2 concern axes** (e.g., schema + service + server + routes is 4 axes — too many)
- The acceptance criteria list exceeds **12 items**
- The implementation sketch requires creating or modifying **more than 10 files**
- The task requires the agent to hold **multiple independent failure classes** in context simultaneously (e.g., auth wiring + date parsing + MCP protocol compliance)

When `agent implementability` is `blocked`, the architect **must split the task** into subtasks, each with a single primary concern. Splitting is not a failure — it is the correct resolution. A well-scoped subtask that an agent can finish is worth more than an ambitious task that fails 4 times.

`agent implementability: blocked` is a terminal result for the current parent task in that workflow run. The parent task may not be marked `implementation-ready`. The only valid outcomes are:

- `split-required`: child tasks still need to be created
- `superseded-by-children`: child tasks were created and the parent was converted into an umbrella/non-dispatchable task
- `operator-escalated`: the workflow could not safely split the task without operator input

### Splitting guidelines

- Each subtask should ideally have **one concern axis** (e.g., "schema + migrations", "service layer", "server composition + routes"). The sizing rule above allows up to 2 axes, but a single axis reduces convergence risk.
- Subtasks may depend on each other — document the dependency order
- Shared test infrastructure can be a separate subtask
- Prefer 6–10 ACs per subtask over 18+ ACs in one task

## Implementer Handoff Contract

The refined task document is the implementer-facing source of truth. Refinement outputs are not optional side artifacts.

### Required section in the task brief: `Implementation Constraints`

Append this section to the refined task brief before marking it implementation-ready:

- **Reference pattern**: specific architectural patterns the implementer must follow
- **Negative scope**: explicit list of what must NOT be built in this task
- **Deployment context reminder**: environment/runtime assumptions and rollout context that constrain implementation
- **Playbook-like instructions**: Ensure that the implementation is so simple that any agent is capable of implementing without generating confusion. You have the capacity to plan ahead.

If this section is missing, the task is not implementation-ready and may not be dispatched to an implementing agent.

### Required section in the task brief: `Sizing Budget`

Append this section to the refined task brief before marking it implementation-ready:

- **Concern axes count**: enumerate the major implementation axes
- **Acceptance criteria count**: total AC count after refinement
- **Estimated file touch count**: files expected to be created or modified
- **Independent failure classes**: distinct areas that could fail separately during implementation

If any budget exceeds the sizing thresholds in this workflow, the task is not implementation-ready and must follow the split path.

### Required section in the task brief: `Execution Gates`

Append this section to the refined task brief before marking it implementation-ready:

- **Blocked by**: prerequisite tasks or concrete repo states that must exist first
- **Order constraints**: where this task belongs in execution order
- **Dispatchability**: `dispatchable`, `blocked`, or `umbrella`
- **Follow-up tasks**: child tasks created by splitting, if any

Dependency findings may not remain only in narrative prose. If a dependency or ordering constraint is real enough to affect implementation, it must be recorded in `Execution Gates` and reflected in task metadata/order before the workflow completes.

## Sequence

### Per-task

1. Dispatch `analyst` for deep confidence check:
   - Read all files the task will likely touch
   - Produce implementation sketch (files to create/modify, approach summary, suggested order). The sketch is **guidance for the implementer, not a binding contract** — the implementer may deviate if they find a better approach during implementation.
   - Rate each confidence dimension (including agent implementability)
   - Record blockers, questions, vagueness, and risks as separate lists
2. If any dimension is `blocked` or `uncertain`: dispatch `architect` to review and resolve
3. Architect reviews all analyst findings:
   - Answers questions where codebase signal is sufficient
   - Makes decisions on ambiguous scope boundaries
   - Classifies remaining unresolved items as `operator-required` or `resolved`
   - Updates the task document with decisions and rationale
   - Drafts `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` from analyst findings and current sketch
4. If `agent implementability` is `blocked`, follow the split branch immediately:
   - Create child tasks sized to fit the sizing rules
   - Update the parent task to `umbrella`/`superseded-by-children` status so it is non-dispatchable
   - Update execution order and dependency metadata so only the child tasks are dispatchable
   - Do not mark the parent task `implementation-ready`
   - Restart the per-task sequence from step 1 for each child task; the parent task's per-task sequence ends here
5. If `operator-required` items exist: escalate to operator with full context
   - Present each item with the architect's analysis of why it couldn't be self-resolved
   - Operator provides answers/decisions
   - Update the task document with operator decisions
6. Dispatch `analyst` for final confidence check:
   - Re-read files if architect/operator decisions changed the approach
   - Verify all dimensions are now `confident`
   - Verify implementation sketch is still valid after decisions
   - Confirm zero blockers remain
   - Validate `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` against the final sketch
7. If final confidence check fails: go to step 2 (architect review of new findings)
8. Architect appends finalized `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` to the task brief and marks task as `implementation-ready`.

### Post-all-tasks

1. If multiple tasks were refined in one pass: architect reviews cross-task dependencies
2. Verify no task's implementation sketch conflicts with another task's scope
3. Recommend execution order based on dependency graph

## Rules

- Steps are executed in order. No step may be skipped.
- Maximum loop iterations (step 6 → step 2): 2. If a task cannot reach `confident` across all dimensions after 2 architect passes, escalate the entire task to the operator with a recommendation to split or restructure.
- The analyst must never write production code. If the analyst produces code, the output is invalid and must be re-dispatched with a corrective instruction.
- The architect must make decisions, not defer. "Needs more thought" is not a valid resolution — either resolve it, request specific information from the operator, or classify the risk.
- A parent task with `agent implementability: blocked` may not remain `Approved` or otherwise dispatchable after refinement. The workflow must leave it as `split-required`, `blocked`, or `umbrella/superseded`.
- If the workflow creates or recommends child packets, the workflow is not complete until task documents and execution order reflect that split.
- A dependency gate discovered during refinement must be written into task metadata/order before the task can be marked dispatchable. Narrative mention alone is insufficient.

## Anti-Rationalization Rules

| Excuse                                                  | Counter                                                                                                                                                               | Gate protected           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| "The task description is clear enough, skip analysis"   | Clarity to a reader is not the same as implementation-readiness. The analyst must verify against actual code.                                                         | analyst confidence check |
| "I already know how to implement this"                  | Prior knowledge is not the same as verified feasibility. Read the files. Every time.                                                                                  | analyst confidence check |
| "No blockers found" (without reading source files)      | An analyst who didn't read the code has no basis for claiming no blockers. Confidence without evidence is not confidence.                                             | analyst confidence check |
| "This is a small task, it doesn't need refinement"      | Small tasks with unclear scope cause the most rework. Size does not predict risk.                                                                                     | all                      |
| "The architect can figure it out during implementation" | Deferring decisions to implementation time is exactly what this workflow prevents. Decide now or escalate now.                                                        | architect review         |
| "The operator won't have context for this question"     | Frame the question with full context. The operator's job is to make product/business decisions, not to reverse-engineer your analysis.                                | operator escalation      |
| "The implementation sketch is obvious, I'll skip it"    | If it's obvious, it takes 2 minutes to write. If it's not, you just proved why it's needed.                                                                           | analyst confidence check |
| "Splitting this task will create too many small tasks"  | A task that fails 4 times costs more than 3 subtasks that each succeed on the first try. Agent throughput is maximized by right-sized work, not by ambitious scoping. | agent implementability   |
| "The agent should be able to handle all of this"        | Past evidence shows tasks with 3+ concern axes and 15+ ACs do not converge. Design for the agent you have, not the agent you wish you had.                            | agent implementability   |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- All tasks have all confidence dimensions rated `confident`
- All tasks have a file-level implementation sketch
- Zero blockers remain (all resolved by architect or operator)
- All questions answered with recorded decisions and rationale
- Task document updated with all findings, decisions, and the final implementation sketch
- Task brief includes finalized `Implementation Constraints`, `Sizing Budget`, and `Execution Gates`
- Any task that was split has child task documents created, parent task status changed to non-dispatchable umbrella/superseded, and execution order updated accordingly
- Any discovered dependency gate is reflected in structured task metadata/order, not only prose

### Forbidden Claims

The following phrases may never appear in refinement completion reports:

- "should be straightforward"
- "probably no blockers"
- "implementation details TBD"
- "will figure out during implementation"
- "seems feasible"
- "likely compatible"
- "no risks identified" (without evidence of file-level analysis)

### Completion Self-Check

Before marking a task as implementation-ready, the orchestrator must verify:

1. The analyst read the actual source files (not just the task description).
2. Every confidence dimension has a recorded rating with supporting evidence.
3. The implementation sketch names specific files and describes specific changes.
4. All operator-required items were actually presented to and resolved by the operator.
5. The final confidence check was run AFTER all decisions were made (not before).
6. `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` are appended to the task brief (not left in a separate refinement artifact).
7. If the task exceeded sizing thresholds, the parent was not marked implementation-ready and was converted into a split-required or umbrella/superseded state.
8. If the refinement identified dependency/order gates, those gates were reflected in task metadata/order before dispatch.

## Dispatch Gate

Before any implementing agent is dispatched, the orchestrator must verify all of the following:

1. No confidence dimension remains `blocked` or `uncertain`.
2. The task is not marked `umbrella`, `superseded`, or `split-required`.
3. No `operator-required` items remain unresolved.
4. `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` are present in the task brief.
5. Any child tasks referenced by the task brief actually exist as task documents.
6. Any prerequisite tasks listed in `Execution Gates` are complete enough for the current task to start.
7. Execution order metadata matches the refined task state; no parent umbrella task remains dispatchable while its child packets are the intended implementation path.

If any check fails, implementation dispatch is forbidden.

