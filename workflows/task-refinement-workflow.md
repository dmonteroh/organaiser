---
id: task-refinement
name: Task Refinement Workflow
triggers: [task-refinement, planning, spec-writing]
contractVersion: 2.0.0
runnerManifest: manifests/task-refinement.v1.yaml
resultSchema: schemas/stage-result.schema.json
manualMode: supported
runnerMode: supported
---

# Task Refinement Workflow Contract

Iterative confidence-building process that transforms a raw task into a ready-to-implement brief. An analyst confidence check feeds an architect review, with operator escalation when needed; a final analyst check closes the loop unless the run was clean enough to take the defined fast path.

This workflow produces enriched task documents, not code. It is a pre-implementation quality gate.

## Roles

### analyst

- Template: `subagents/analyst-prompt.md`
- Mode: read-only analysis (must NOT write production code or create project files)
- Constraints:
  - Must read the actual source files that the task will touch, not just reason abstractly
  - Must produce a file-level implementation sketch with modification order
  - Must rate confidence across structured dimensions, not give a single pass/fail
  - Must explicitly record blockers, questions, vagueness, and risks as separate categories
  - If tempted to start implementing: STOP. The deliverable is the analysis, not code.

### architect

- Template: `subagents/architect-prompt.md`
- Mode: decision-making (may update its own task brief and refinement log only, must NOT write production code)
- Constraints:
  - Must review analyst findings and make concrete decisions, not defer everything
  - Must answer questions where the codebase provides sufficient signal
  - Must classify remaining items as operator-required or self-resolvable
  - Must not weaken analyst-identified risks without explicit justification
  - Owns the three required task-brief sections: must append `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` on every non-split pass
  - Owns brief hygiene: must move refinement narrative to the refinement log on every non-split pass (see Brief hygiene)
  - Board status, execution order, and child-task insertion are proposals in the report; the orchestrator (manual mode) or the runner (runner mode) applies them

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

A task is **ready-to-implement** when all dimensions are `confident`, zero blockers remain, no questions or vagueness items are unresolved, and the task is not classified as an umbrella/split-required parent.

## Task Sizing Rules

A task that passes all confidence dimensions can still fail if it exceeds agent working capacity. Each sizing measure has a **target** (the size that converges reliably) and a **hard cap** (the size past which tasks do not converge):

| Measure                     | Target | Hard cap     |
| --------------------------- | ------ | ------------ |
| Concern axes                | 1      | more than 2 (e.g., schema + service + server + routes is 4 axes, over cap)                       |
| Acceptance criteria         | 8      | more than 12 |
| Files created or modified   | 6      | more than 10 |
| Independent failure classes | 1      | more than 2 (e.g., auth wiring + date parsing + MCP protocol compliance is 3 classes, over cap)  |
| Files in the read set       | 10     | more than 20 |

Read-set numbers are recorded, not estimated: the analyst counts the files it actually read during the confidence check and notes their approximate line counts.

The analyst rates `agent implementability` from these measures:

- Any hard cap breached: rate `blocked`.
- Over target on any measure but under every cap: rate `confident`, absent other evidence against it. Over-target values are facts to record, not review triggers: each carries a one-line justification in the `Sizing Budget` (e.g., "10 ACs: single axis, all files under 100 lines"). The architect may still split when the combination of over-target measures looks risky.
- Every measure within target: rate `confident`, absent other evidence against it.

When `agent implementability` is `blocked`, the architect **must split the task** into subtasks, each with a single primary concern. Splitting is not a failure; it is the correct resolution. A well-scoped subtask that an agent can finish is worth more than an ambitious task that fails 4 times.

`agent implementability: blocked` is a terminal result for the current parent task in that workflow run. The parent task may not be marked `ready-to-implement`. The only valid outcomes are:

- `split-required`: child tasks still need to be created
- `superseded-by-children`: child tasks were created and the parent was converted into an umbrella/non-dispatchable task
- `operator-escalated`: the workflow could not safely split the task without operator input

### Splitting guidelines

- Each subtask should ideally have **one concern axis** (e.g., "schema + migrations", "service layer", "server composition + routes"). The hard cap allows up to 2 axes, but a single axis is the target and reduces convergence risk.
- Subtasks may depend on each other; document the dependency order
- Shared test infrastructure can be a separate subtask
- Prefer 6–10 ACs per subtask over 18+ ACs in one task

## Defaulted Decisions and Operator Questions

Most ambiguity found during refinement resolves as a defaulted decision, not an operator question. A defaulted decision is a call the architect makes and records: a terse constraint in the brief, the rationale and rejected alternatives in the refinement log. The operator reviews defaulted decisions by exception (veto after the fact), never by confirmation, and refinement never waits on them.

An item may be classified `operator-required` only when at least one of these criteria holds:

1. It is product, permission, or business-policy judgment (who may do what, what ships, relative priority).
2. It commits a new externally visible capability or contract (new endpoint, schema field, or API behavior) not already in the task's scope.
3. A wrong default would be expensive to reverse after implementation (data migration, published contract, user-visible workflow change).
4. It contradicts a recorded operator decision, spec assumption, or ADR.

If no criterion holds and a reasonable default exists, the architect decides and records it. If no criterion holds and no clean default exists, the architect still decides (see Rules: the architect must not defer). Items that meet the bar follow the batched escalation in the Sequence; they are collected in one run-level open-questions file and presented once, at the end of the run, never as mid-run interrupts.

## Implementer Handoff Contract

The refined task document is the implementer-facing source of truth. Refinement outputs are not optional side artifacts.

### Required section in the task brief: `Implementation Constraints`

Append this section to the refined task brief before marking it ready-to-implement:

- **Reference pattern**: specific architectural patterns the implementer must follow
- **Negative scope**: explicit list of what must NOT be built in this task
- **Deployment context reminder**: environment/runtime assumptions and rollout context that constrain implementation
- **Playbook-like instructions**: ordered, unambiguous implementation steps the implementer can follow without re-deriving the plan. Write them so a smaller or lower-effort model can execute them. For any file in the read set over roughly 500 lines, name the specific functions or regions to read and modify, not just the file path, so the implementer never has to hold the whole file in context.

If this section is missing, the task is not ready-to-implement and may not be dispatched to an implementing agent.

### Required section in the task brief: `Sizing Budget`

Append this section to the refined task brief before marking it ready-to-implement:

- **Concern axes count**: enumerate the major implementation axes
- **Acceptance criteria count**: total AC count after refinement
- **Estimated file touch count**: files expected to be created or modified
- **Independent failure classes**: distinct areas that could fail separately during implementation
- **Read scope**: number of files in the implementer's read set and the largest file's approximate line count, taken from the analyst's Files Read list, not estimated
- **Band per measure**: mark each value `within-target` or `over-target` against the sizing table. Every `over-target` value carries a one-line justification

If any measure breaches its hard cap, the task is not ready-to-implement and must follow the split path.

### Required section in the task brief: `Execution Gates`

Append this section to the refined task brief before marking it ready-to-implement:

- **Blocked by**: prerequisite tasks or concrete repo states that must exist first
- **Order constraints**: where this task belongs in execution order
- **Dispatchability**: `dispatchable`, `blocked`, or `umbrella`
- **Follow-up tasks**: child tasks created by splitting, if any
- **Claims**: file and non-file write surfaces, every dimension with a value or `none`
- **Verification commands**: the exact argument arrays the runner and implementer run

Dependency findings may not remain only in narrative prose. If a dependency or ordering constraint is real enough to affect implementation, it must be recorded in `Execution Gates` and reflected in task metadata/order before the workflow completes.

### Brief hygiene: the refinement log

The refined brief is dispatched to the implementer verbatim, so it must contain only implementer-facing content: task description, acceptance criteria, the final implementation sketch, the three required sections, and decisions stated as terse constraints (e.g., "trailing-edge; returns undefined; no cancel()").

The refinement trail moves to a companion file `<task-brief-name>-refinement-log.md` next to the brief: analyst reports, architect review rationale, operator Q&A, and superseded alternatives. The brief may reference the log; it may not inline it. If a decision needs justification in the brief, one sentence is the limit; the full rationale lives in the log.

The log is a decision record, not a transcript: terse entries for decisions with rationale, rejected alternatives, operator items, and source-verification anchors. Target roughly 60 lines per pass. Later passes append deltas only (what changed and why); they never restate or re-summarize prior passes.

The architect owns brief hygiene on every non-split pass. A brief that still carries refinement narrative is not ready-to-implement.

## Sequence

### Per-task

1. Dispatch `analyst` for deep confidence check:
   - Read all files the task will likely touch
   - Produce implementation sketch (files to create/modify, approach summary, suggested order). The sketch is **guidance for the implementer, not a binding contract**: the implementer may deviate if they find a better approach during implementation.
   - Rate each confidence dimension (including agent implementability)
   - Record blockers, questions, vagueness, and risks as separate lists
   - Return an `Overall` verdict per the analyst template's Verdict Rule
2. Dispatch `architect` with the full analyst report. The architect always runs, even on a clean report, because the architect owns the three required task-brief sections. Scope the pass by the analyst verdict:
   - `split-required`: go to step 3 before drafting any sections
   - `needs-review` or `blocked`: full review. Answer questions where codebase signal is sufficient, decide ambiguous scope boundaries, classify remaining unresolved items as `operator-required` or `resolved`, record decisions in the task document as terse constraints with the rationale in the refinement log, then append `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` to the task brief
   - `implementation-ready`: light pass. Validate the sketch, then draft and append the three sections. Do not manufacture findings to review
   - On every non-split pass, finish by applying brief hygiene (see Brief hygiene: the refinement log)
3. Split branch (only when `agent implementability` is `blocked`):
   - Return child-task proposals sized to fit the sizing rules, each carrying the fields in adaptation spec section 11.3: stable proposed identifier, title, canonical brief path, parent identifier, dependencies, starting stage, initial claim set or `unknown`, acceptance criteria, and sizing budget
   - All children apply in one transaction: the orchestrator (manual mode) or the runner (runner mode) validates the entire child graph, then marks the parent `superseded` and inserts every child. A partial split never reaches the board
   - Do not mark the parent task `ready-to-implement` and do not draft the three sections for it; they are produced per child during each child's own refinement
   - Restart the per-task sequence from step 1 for each child task; the parent task's per-task sequence ends here
4. If the architect returned `needs-operator` or `operator-escalated`: do not pause the run to ask. First verify each item against the operator question bar (see Defaulted Decisions and Operator Questions); items that fail the bar return to the architect as decisions to make. For each item that meets the bar, record it in the run's open-questions file with context, options, impact, and a stated default when one exists, then continue:
   - With a safe stated default: complete the per-task sequence on the default, written into the brief as a constraint marked `defaulted-pending-operator`. The task's `Execution Gates` records `blocked-on-operator: <question>` so the Dispatch Gate holds this task only, not the run.
   - Without a safe default: mark the task `operator-escalated`, park it, and continue with other tasks.
   - Operator answers are collected once at the end of the run (see Refinement queue reconciliation), not per item. When an answer requires a split, return to step 2 for that task so the architect executes it.
5. Dispatch `analyst` for final confidence check, unless the fast path applies. Fast path: skip this step only when the first analyst pass returned `implementation-ready`, the architect changed nothing beyond appending the three sections and applying brief hygiene, and no operator-required items existed. The fast path never applies when the architect returned `needs-another-pass`; in that case include the architect's named investigation items in the dispatch.
   - Include the first-pass analyst report and the architect review in the dispatch, and state that this is the final confidence check
   - The analyst re-reads only the files affected by architect/operator decisions and carries forward unchanged first-pass findings
   - Verify all dimensions are now `confident`
   - Verify implementation sketch is still valid after decisions
   - Confirm zero blockers and no unanswered questions remain
   - Validate `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` against the final sketch, including the sizing bands and any over-target justifications
   - Verify brief hygiene per the Brief hygiene section
6. If the final confidence check fails: go to step 2 with the new findings (see loop cap in Rules)
7. Run the Completion Self-Check and mark the task `ready-to-implement`. In manual mode this stays an orchestrator action; no new subagent dispatch is needed. In runner mode it is the runner-owned `refinement-self-check` stage: it validates required sections, enums, counts, dependencies, and file existence, and it does not replace analyst judgment. Items 1, 3, 4, and 5 of the 9-item Completion Self-Check list are judgment calls a mechanical predicate cannot perform; they remain enforced by the analyst and architect stage verdicts feeding into this stage, not by the predicate itself.

### Refinement queue reconciliation

This step never claims the board is complete.

1. If multiple tasks were refined in one pass: architect reviews cross-task dependencies
2. Verify no task's implementation sketch conflicts with another task's scope
3. Recommend execution order based on dependency graph; cross-task dependencies are returned as board proposals, not direct board edits
4. Present the batched operator items once: every open question across all tasks, each with context, options, impact, and its stated default. The run completes without waiting for answers; the run report lists dispatchable tasks separately from operator-blocked tasks so implementation can start while the operator works the blockers.
5. Process operator answers when they arrive (typically after the run):
   - A confirmed default is orchestrator bookkeeping only: mark the question resolved, drop the `blocked-on-operator` gate and the `defaulted-pending-operator` marker, no subagent dispatch. When every answer confirms its default, the whole batch resolves this way.
   - A changed answer re-enters refinement scoped to the affected brief only: one architect pass with the answer, then the final analyst check only if the change altered the sketch or any of the three sections.

## Rules

- Steps are executed in order. A step may be skipped only under a skip condition the sequence itself defines (the step 5 fast path).
- Maximum loop iterations (step 5 → step 2): 2 (manifest authority: `manifests/task-refinement.v1.yaml` caps). If a task cannot reach `confident` across all dimensions after 2 architect passes, park the task as `operator-escalated` (runner state: `parked`) with a recommendation to split or restructure recorded in the open-questions file; it joins the end-of-run batch.
- The analyst must never write production code. If the analyst produces code, the output is invalid and must be re-dispatched with a corrective instruction.
- The architect must make decisions, not defer. "Needs more thought" is not a valid resolution: either resolve it, request specific information from the operator, or classify the risk.
- A parent task with `agent implementability: blocked` may not remain `Approved` or otherwise dispatchable after refinement. The workflow must leave it as `split-required`, `blocked`, or `umbrella/superseded`.
- If the workflow creates or recommends child packets, the workflow is not complete until task documents and execution order reflect that split.
- A dependency gate discovered during refinement must be written into task metadata/order before the task can be marked dispatchable. Narrative mention alone is insufficient.
- Operator questions are batched, never synchronous. No dispatch or step may wait mid-run on an operator answer; the open-questions file plus the end-of-run presentation is the only escalation channel.
- The run report must count defaulted decisions recorded and operator questions asked, and, once answers arrive, how many defaults the operator changed. If across recent runs roughly 9 in 10 questions come back confirmed unchanged, the operator question bar is being applied too loosely: tighten classification instead of asking more.

## Anti-Rationalization Rules

| Excuse                                                  | Counter                                                                                                                                                               | Gate protected           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| "The task description is clear enough, skip analysis"   | Clarity to a reader is not the same as implementation-readiness. The analyst must verify against actual code.                                                         | analyst confidence check |
| "I already know how to implement this"                  | Prior knowledge is not the same as verified feasibility. Read the files. Every time.                                                                                  | analyst confidence check |
| "No blockers found" (without reading source files)      | An analyst who didn't read the code has no basis for claiming no blockers. Confidence without evidence is not confidence.                                             | analyst confidence check |
| "This is a small task, it doesn't need refinement"      | Small tasks with unclear scope cause the most rework. Size does not predict risk.                                                                                     | all                      |
| "The architect can figure it out during implementation" | Deferring decisions to implementation time is exactly what this workflow prevents. Decide now or escalate now.                                                        | architect review         |
| "The operator won't have context for this question"     | Frame the question with full context. The operator's job is to make product/business decisions, not to reverse-engineer your analysis.                                | operator escalation      |
| "Better to confirm this default with the operator"      | A confirmed default changes nothing and costs an interaction. If the item fails the operator question bar, record the decision and move on; decisions do not become questions for reassurance. | operator question bar    |
| "The operator is available, just ask now"               | Mid-run synchronous questions stall every other task and force answers without reading time. Questions batch to the end of the run; the operator answers while dispatchable tasks are already being implemented. | batched escalation       |
| "The implementation sketch is obvious, I'll skip it"    | If it's obvious, it takes 2 minutes to write. If it's not, you just proved why it's needed.                                                                           | analyst confidence check |
| "Splitting this task will create too many small tasks"  | A task that fails 4 times costs more than 3 subtasks that each succeed on the first try. Agent throughput is maximized by right-sized work, not by ambitious scoping. | agent implementability   |
| "The agent should be able to handle all of this"        | Past evidence shows tasks beyond the hard caps (3+ concern axes, 13+ ACs) do not converge. Over-cap tasks split. Design for the agent you have, not the agent you wish you had. | agent implementability   |
| "The architect barely changed anything, skip the final check" | The fast path is defined precisely: clean first pass, no changes beyond the three appended sections and brief hygiene, no operator items. Any decision, scope change, or operator answer invalidates it. Check the condition, not the vibe. | final confidence check   |
| "The rationale is useful context, leave it in the brief" | The implementer executes constraints; it does not re-litigate decisions. Narrative in the brief inflates the dispatch packet and buries the acceptance criteria. It belongs in the refinement log. | brief hygiene            |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- All dispatchable tasks have all confidence dimensions rated `confident` (umbrella/superseded parents are exempt; their children must satisfy this instead)
- All dispatchable tasks have a file-level implementation sketch
- Every task is either ready-to-implement or explicitly parked (`blocked-on-operator`, `operator-escalated`, or a recorded prerequisite gate) with its question in the batched open-questions file; no blocker is unaccounted for
- Every question is either answered with a recorded decision and rationale, or recorded in the open-questions file with context, options, impact, and stated default
- The run report separates dispatchable tasks from operator-blocked tasks and includes the defaulted-decisions vs operator-questions counts
- Task document updated with all decisions (as terse constraints) and the final implementation sketch; findings and rationale recorded in the refinement log
- Task brief includes finalized `Implementation Constraints`, `Sizing Budget`, and `Execution Gates`
- Task brief contains only implementer-facing content; the refinement trail lives in `<task-brief-name>-refinement-log.md`
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

Before marking a task as ready-to-implement, the orchestrator must verify:

1. The analyst read the actual source files (not just the task description).
2. Every confidence dimension has a recorded rating with supporting evidence.
3. The implementation sketch names specific files and describes specific changes.
4. Every operator-required item passed the operator question bar and is either resolved with the answer applied, or recorded in the batched open-questions file with its task gated accordingly. No item was escalated mid-run.
5. The final confidence check was run AFTER all decisions were made (not before), or the step 5 fast path condition was met.
6. `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` are appended to the task brief (not left in a separate refinement artifact).
7. If the task breached a sizing hard cap, the parent was not marked ready-to-implement and was converted into a split-required or umbrella/superseded state. Any over-target value under its cap carries a one-line justification in the `Sizing Budget`.
8. If the refinement identified dependency/order gates, those gates were reflected in task metadata/order before dispatch.
9. The brief contains only implementer-facing content; analyst reports, rationale, and operator Q&A are in the refinement log, not the brief.

## Dispatch Gate

Before any implementing agent is dispatched, the orchestrator must verify all of the following:

1. No confidence dimension remains `blocked` or `uncertain`.
2. The task is not marked `umbrella`, `superseded`, or `split-required`.
3. No `operator-required` items remain unresolved.
4. `Implementation Constraints`, `Sizing Budget`, and `Execution Gates` are present in the task brief.
5. Any child tasks referenced by the task brief actually exist as task documents.
6. Any prerequisite tasks listed in `Execution Gates` are complete, or the operator has explicitly approved starting before they finish.
7. Execution order metadata matches the refined task state; no parent umbrella task remains dispatchable while its child packets are the intended implementation path.
8. The brief carries no refinement narrative (analyst reports, architect rationale, operator Q&A); those live in the refinement log.
9. Claims and verification commands are present in `Execution Gates`.

If any check fails, implementation dispatch is forbidden.

## Related Workflows

- **product-spec-workflow**: Upstream. A `specified` product intent arrives here for implementation planning.
- **spike-workflow**: Upstream. Adopt/adapt decisions create follow-up tasks refined here before implementation.
- **gap-analysis-workflow**: Upstream. Newly created tasks from gap analysis are made ready-to-implement here.
- **design-intake-workflow**: Upstream. Presentation-scoped raw tasks drafted from external design deliverables are made ready-to-implement here.
- **dev-workflow**: Downstream. Ready-to-implement briefs are built there; the three appended sections travel with the task packet. The refinement log does not travel: it is an operator-facing record, not implementer input.
- **decision-workflow**: Use when an operator-required item is a significant architectural or strategic decision that deserves its own decision record.

