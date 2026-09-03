---
id: design-intake-workflow
name: Design Intake Workflow
triggers: [design-intake, design-deliverables, design-to-tasks, mockup-intake]
contractVersion: 1.0.0
manualMode: supported
runnerMode: unsupported
---

# Design Intake Workflow Contract

Turns external design deliverables (HTML mockups plus a markdown rationale, for example from Claude Design) into delta-grounded raw tasks. Compares the delivered design against the current implementation, classifies every element on both sides, routes behavior changes to product-spec-workflow, and drafts presentation-scoped raw task briefs for task-refinement-workflow. The operator is the transport: deliverables arrive as files the operator saved, and questions back to the design agent travel as a pasted follow-up prompt.

This workflow produces raw task briefs and routing decisions, not implementation-ready briefs (that is task-refinement-workflow) and not product intent (that is product-spec-workflow).

## Roles

### design-delta-analyst

- Template: `subagents/design-delta-analyst-prompt.md`
- Mode: analytical (reads deliverable files and the codebase; must NOT modify production code)
- Constraints:
  - Must extract the design's intent from the markdown rationale first and use the HTML as evidence of it, not the reverse
  - Must read the actual current implementation of every screen the design touches, never assume from naming
  - Must classify every design element and every in-scope current element exactly once (see Delta Model); nothing unaccounted on either side
  - Must record ambiguities as numbered questions, never resolve them by assumption
  - Must verify data feasibility: content the design displays that the current system does not have is `changed-behavior`, not styling
  - Supports a Follow-Up Pass: re-examines only named elements against the prior report and returns a delta

### intake-challenger

- Template: `subagents/intake-challenger-prompt.md`
- Mode: adversarial review of the delta report (read-only; may read deliverables and codebase to verify)
- Gate type: structured (delta-sound | gaps-found | needs-info)
- Constraints:
  - Must challenge `restyled` and `unchanged` rows by opening both sides: do interactions, targets, data, and flows really match?
  - Must hunt silently-dropped elements: current elements the design neither includes nor lists as removed
  - Must verify state completeness: missing empty/loading/error states in the deliverable are recorded as ambiguities, not assumed unchanged
  - Must classify each finding as `classification` (relabel candidate with evidence) or `coverage` (elements the analyst never examined) so the orchestrator can route without guessing
  - Must flag forbidden claims (see Completion) as findings
  - Supports a Re-Check Pass: verifies only new or changed rows plus previously flagged items

### runtime-explorer (optional)

- Template: `subagents/runtime-explorer-prompt.md` (shared with design-handoff-workflow)
- Mode: interactive observation of the running current implementation (drives the UI via locally available browser automation; creates only the screenshot files its capture assignments name; does not analyze the codebase)
- Dispatched only when the operator declares Runtime Access in step 1: a running or launchable instance of the current app in a `disposable` or `dev` environment plus browser automation tooling (for example Playwright). Without that declaration, this role never runs and the workflow follows the text-only path with no loss of contract.
- Constraints:
  - Must act only against the declared instance, never production
  - Must work only named observe assignments about current behavior; designer-intent questions are not observable and stay in the follow-up prompt or with the operator
  - Must label every result `live-app`
  - Must report states it cannot trigger as `unreachable`, not guess

## Delta Model

Every element (screen, component, interaction, content block) gets exactly one classification:

| Classification | Meaning | Routing |
|---|---|---|
| `unchanged` | Exists today; the design keeps it as-is | No task |
| `restyled` | Same behavior and same data; new presentation | Raw task, route to task-refinement-workflow |
| `changed-behavior` | Interaction, flow, or data changes | Route to product-spec-workflow; behavior is product intent |
| `new` | Does not exist today | Presentation-only additions (no interaction, no new data) become raw tasks; anything carrying new interaction or data routes to product-spec-workflow |
| `removed` | Exists today; the design explicitly drops it | Operator confirms. Confirmed presentation removals join the raw tasks; confirmed behavior removals route to product-spec-workflow |
| `dropped-silently` | Exists today; the design neither includes it nor lists it as removed | Ambiguity: goes into the follow-up prompt or to the operator |
| `ambiguous` | The deliverable does not reveal intent (state missing, interaction unclear, rationale contradicts mockup) | Follow-up prompt to the design agent, or operator decision |

## The Follow-Up Prompt

When ambiguities and silently-dropped elements survive the delta gate, the orchestrator drafts one follow-up prompt for the design agent: numbered questions, each self-contained with the context a design agent without codebase access needs to answer it. The operator pastes it, returns the answers or updated deliverables, and the workflow resumes with a delta-analyst Follow-Up Pass on the affected elements.

Maximum follow-up rounds per run: 1. The operator may also answer any question directly instead of transporting it (they may know the intent); record the answer and relabel. Elements still unresolved after the round get an operator ruling, or are excluded from this intake run and recorded as not-intaken.

## Raw Task Briefs

After the gate clears, the orchestrator drafts raw task briefs from confirmed delta rows:

- Group by screen or component cluster: one coherent presentation concern per brief. task-refinement-workflow owns sizing and splitting, but intake must not hand it a monolith of unrelated screens.
- Each brief carries: what changes described as from → to in text, the delta rows it implements, pointers to the deliverable files and the specific mockup section as design evidence, and acceptance criteria phrased as observable outcomes.
- Raw means raw: no implementation sketch, no sizing sections, no file lists. Those are produced by task-refinement-workflow.
- Every brief cites deliverable evidence. A task with no deliverable anchor did not come from this intake.

## Sequence

### Per-task

1. Gather inputs from the operator:
   - Deliverable files: paths to the markdown rationale and every HTML mockup the operator saved
   - The originating handoff package, if design-handoff-workflow produced one; its Current State and Return Format sections anchor the comparison
   - Codebase entry points for the affected area, if no handoff package exists
   - Operator acceptance notes: anything already known to be wrong or right in the deliverable
   - Runtime Access (optional): a running or launchable instance of the current app (URL or launch instructions), its environment classification (`disposable` or `dev`), and the browser automation tooling available. If not declared, the workflow runs the text-only path.
2. Dispatch `design-delta-analyst` per its template with the deliverable paths, the handoff package (if any), and the codebase entry points. If the analyst reports missing inputs, fix them and re-dispatch; do not let it guess.
3. Orchestrator reviews the delta report: every element on both sides classified exactly once, ambiguities recorded as questions rather than resolved by assumption. Misclassifications the orchestrator can evidence from the report itself: relabel directly, recording the rationale. Structural problems (missing screens, unexamined areas): re-dispatch the analyst in a Follow-Up Pass naming the elements. Pre-challenge corrections do not count against the revision cap.
4. Dispatch `intake-challenger` per its template with the delta report, the deliverable paths, and the handoff package. On a repeat pass, dispatch as a Re-Check Pass, adding the challenger's own prior report and the revised delta table with changed rows marked.
5. If the challenger returns `needs-info`, resolve each Missing For Review item by owner:
   - `orchestrator-context`: supply the missing files or report sections and re-dispatch the challenger only.
   - `operator`: escalate. Record the answer and resume at the step that raised it.
   - Neither resolution counts against the revision cap.
6. If the challenger returns `gaps-found`, resolve each finding by its gap type:
   - `classification` challenges that turn on runtime behavior (interaction identity, state behavior), when Runtime Access is declared: the orchestrator may dispatch `runtime-explorer` to observe the current behavior before ruling. The observation decides the relabel or the recorded rejection and enters the table as `live-app` evidence. Explorer dispatches do not count against the revision cap.
   - `classification` challenges the orchestrator accepts: relabel directly in the delta table, carrying the challenger's evidence. Relabels add no new analysis, so they need no dispatch and no re-check.
   - `classification` challenges the orchestrator rejects: record the rejection rationale; it goes into the intake report for operator visibility.
   - `coverage` findings (elements or areas the analyst never examined): re-dispatch the analyst in a Follow-Up Pass on the named elements only, merge the returned delta, then return to step 4 as a Re-Check Pass. This is one revision round.
   - Maximum revision rounds: 2. On exhaustion, escalate to the operator with the competing assessments; record the operator's ruling as the final classification for each contested element and resume at step 7 without a further challenger pass.
7. Resolve remaining `ambiguous` and `dropped-silently` rows, splitting them by what can answer them:
   - Questions about what the current implementation does, when Runtime Access is declared: dispatch `runtime-explorer` with observe assignments and merge the answers back as `live-app` evidence.
   - Questions about what the design intends: the Follow-Up Prompt section. Draft the prompt, operator transports or answers directly, then analyst Follow-Up Pass on the affected elements and challenger Re-Check Pass on the changed rows.
   - Elements still unresolved get an operator ruling or are excluded and recorded as not-intaken. Neither the follow-up round nor explorer dispatches count against the revision cap.
8. Confirm every `removed` row with the operator before routing it: the design explicitly dropped the element, but the operator owns whether the drop is intended. Then draft raw task briefs per the Raw Task Briefs section and route every confirmed row per the Delta Model table. Behavior changes get a product-spec routing note that carries the deliverable evidence and the delta rows, so the spec run starts with the design's intent on record.
9. Produce the intake report:
   - Final delta table
   - Raw tasks drafted, each with its delta rows and routing to task-refinement-workflow
   - Product-spec routings with their evidence
   - Operator decisions, rejected challenges with rationale, excluded elements
   - The follow-up exchange, if one happened
10. Mark task `ready`.

### Post-all-tasks

1. If multiple deliverable sets were intaken: check for overlapping screens with conflicting classifications or conflicting tasks. Conflicts go to the operator before routing.
2. Verify every routed item reached its named workflow or is recorded for the operator.
3. Mark all `ready` tasks `integrated`.

### Rules

- Steps are executed in order. No step may be skipped.
- The analyst must read both sides: the deliverable files and the current implementation. A delta with one side assumed is not a delta.
- The markdown rationale is intent; the HTML is evidence. When they conflict, the conflict is an `ambiguous` row, not a coin flip.
- Behavior never becomes a raw task directly. `changed-behavior` rows, and `new` or `removed` rows that carry behavior or data, route through product-spec-workflow. This workflow does not specify product intent.
- Ambiguous and silently-dropped elements never become tasks. They resolve through the follow-up prompt or the operator first.
- Maximum revision rounds: 2. A round is one analyst Follow-Up Pass plus one challenger Re-Check Pass. Orchestrator relabels, needs-info resolutions, pre-challenge corrections, and the follow-up round do not count against the cap.
- Every raw task brief cites deliverable evidence: file plus section, not "the design".
- The runtime-explorer is optional and additive. No gate or completion requirement may depend on it, and it answers current-behavior questions only: the live app shows what is, not what the design meant. Designer-intent ambiguities always route to the design agent or the operator. Live observations carry `live-app` evidence labels; a live-app versus source-code discrepancy is an operator finding, never silently resolved.
- This workflow does not judge design quality. The design's merit is the operator's call; the workflow's job is faithful classification and routing.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The HTML is self-explanatory, skip the rationale" | The HTML shows one rendered state. The rationale carries intent, states, and marked assumptions. Reading only the HTML turns every unstated state into a guess. | design-delta-analyst |
| "It looks the same, mark it unchanged" | "Looks the same" compares the mockup to memory. Read the implementation; interaction and data differences hide behind identical pixels. | design-delta-analyst |
| "It's just styling" | A different tap target, a merged screen, or a new data field is behavior, not styling. Verify the interaction and the data are identical before calling it `restyled`. | intake-challenger |
| "The design didn't mention it, so it stays" | Silence is not a decision. An element the design neither keeps nor removes is `dropped-silently` and needs an answer, not an assumption. | intake-challenger |
| "The intent is obvious, I'll resolve the ambiguity myself" | "Obvious to the reader" is how redesigns ship the wrong intent. Ambiguities go to the design agent or the operator; they never resolve by assumption. | design-delta-analyst |
| "Bundle everything into one redesign task" | One umbrella task throws away the delta. Intake hands task-refinement coherent single-concern briefs, not a monolith it must re-decompose. | task drafting |
| "The behavior change is small, just make it a task" | Small behavior changes are still product decisions. Route through product-spec-workflow; the spec can be short, but the decision must be owned. | routing |
| "We can settle the ambiguity by clicking around" | The live app shows what IS, not what the design MEANT. Runtime observation answers current-behavior questions; designer-intent questions go back to the design agent or the operator. | ambiguity resolution |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Deliverable files read in full: the markdown rationale and every HTML mockup
- Every deliverable element and every in-scope current element classified exactly once
- Challenger returned `delta-sound` on the final table, or every remaining finding was resolved by relabel or recorded rejection, or the revision cap was reached and the operator's rulings are recorded
- Every `ambiguous` and `dropped-silently` row resolved via follow-up or operator, or excluded and recorded as not-intaken
- Every `removed` row confirmed with the operator before it was routed
- Raw task briefs drafted only from confirmed presentation-scoped rows, each citing deliverable evidence
- Behavior changes routed to product-spec-workflow with deliverable evidence
- Intake report produced with the final delta table, routings, decisions, and any follow-up exchange

### Forbidden Claims

The following may never appear in intake reports or raw task briefs:

- "matches the design" (without naming the deliverable file and section)
- "minor visual tweaks" (without listing each one)
- "the design implies" (unstated intent is an ambiguity, not evidence)
- "no behavior changes" (without walking the interactions on both sides)
- "the rest is unchanged" (without accounting for every element in scope)
- "pixel-perfect" (fidelity targets must name what is measured)
- "the designer probably meant" (ask, do not guess)

### Completion Self-Check

Before marking an intake as complete, the orchestrator must verify:

1. The analyst read the deliverable files and the current implementation source, not one side.
2. The delta table accounts for every element on both sides exactly once.
3. The intake-challenger reviewed the final delta table. Orchestrator relabels and recorded rejections add no new analysis and do not require a re-check.
4. No task was drafted from an unresolved `ambiguous` or `dropped-silently` row, and no `removed` row was routed without operator confirmation.
5. Every `changed-behavior` row (and behavior-carrying `new`/`removed` row) has a product-spec routing, not a raw task.
6. Every raw task brief cites deliverable evidence and contains no implementation sketch or sizing content.
7. No forbidden claims appear in the report or the briefs.
8. Any follow-up exchange is recorded in the intake report.
9. Runtime observations, if any, are labeled `live-app` in the delta table, and every live-app versus source-code discrepancy was escalated to the operator, not silently resolved.

If check 1 or 2 fails, re-dispatch the analyst in a Follow-Up Pass on the affected elements, then the challenger as a Re-Check Pass; this completes the original pass and does not count against the cap. If check 3 fails, re-dispatch the challenger as a Re-Check Pass scoped to what it has not seen. If check 4, 5, 6, 7, 8, or 9 fails, the orchestrator fixes the report, briefs, routing, or evidence labels directly without new dispatches, escalating any discrepancy to the operator. After any fix, re-run this self-check.

## Related Workflows

- **design-handoff-workflow**: Upstream sibling. Its Return Format defines the deliverable shape this workflow parses; its Current State section anchors the delta.
- **task-refinement-workflow**: Downstream. Presentation-scoped raw tasks are made implementation-ready there.
- **product-spec-workflow**: Downstream. Behavior changes and behavior-carrying additions or removals route there for specification.
