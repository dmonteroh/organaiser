---
id: gap-analysis-workflow
name: Gap Analysis Workflow
triggers: [gap-analysis, milestone-check, mva-readiness, completeness-audit]
---

# Gap Analysis Workflow Contract

Determines whether the current task set covers a target outcome (MVA, milestone, release goal). Maps required capabilities against existing tasks, identifies what is missing, what is excess, and what needs scope changes. Produces actionable recommendations that feed into product-spec-workflow and operator prioritization.

This workflow answers "Do we have everything we need?", not "Is what we have still sound?" (that is roadmap-health-workflow) or "What order should we build it in?" (task ordering is an operator call outside this workflow).

## Roles

### coverage-mapper

- Template: `subagents/coverage-mapper-prompt.md`
- Mode: analytical (reads target definition, task files, codebase, ADRs; must NOT modify)
- Constraints:
  - Must decompose the target outcome into required capabilities (capabilities, not tasks)
  - Must read actual task scope to assess coverage, never match titles to capability names
  - Must rate each capability covered, partial, or uncovered, and identify excess tasks
  - Must check for implicit capabilities nobody listed (infrastructure, auth, error handling, testing, deployment)
  - Supports a Revision Pass: re-maps only named capabilities against the prior map and returns a delta

### gap-challenger

- Template: `subagents/gap-challenger-prompt.md`
- Mode: adversarial review of the coverage map (read-only)
- Gate type: structured (coverage-sufficient | gaps-found | needs-info)
- Constraints:
  - Must challenge `covered` ratings and `excess` classifications with specifics, spot-checking task files itself
  - Must identify capabilities the coverage-mapper missed entirely
  - Must stress-test end-to-end: if exactly these tasks were built, could a user complete the target flows?
  - Must think from the user's perspective, not the engineer's
  - Supports a Re-Check Pass: verifies only new or changed map rows plus previously flagged items

## Coverage Model

The coverage-mapper decomposes the target into capabilities at three levels:

| Level | What it represents | Example |
|---|---|---|
| Core capability | Something the user must be able to DO for the target to be met | "User can create a task via Telegram" |
| Supporting capability | Something the system needs internally to enable a core capability | "Dispatcher routes Telegram messages to the correct domain server" |
| Operational capability | Something needed for the system to run reliably | "Health checks, logging, error recovery" |

Each capability gets a coverage rating. `excess` is a task classification, not a capability rating:

| Rating | Applies to | Meaning |
|---|---|---|
| `covered` | capability | An existing task fully delivers this capability |
| `partial` | capability | An existing task touches this area but does not fully deliver it; the map names what is missing |
| `uncovered` | capability | No existing task addresses this capability |
| `excess` | task | The task serves no required capability for this target |

## Sequence

### Per-task

1. Define the target outcome:
   - What is the milestone/MVA/release goal?
   - What must a user be able to DO when this target is met? (User-facing definition)
   - What constraints apply? (Timeline, dependencies, must-not-break guarantees)
   - What is explicitly OUT of the target? (Future phases, nice-to-haves)
2. Dispatch `coverage-mapper` per its template with the target definition, the existing task list, and project context (ADRs, architecture, completed work). If the mapper reports missing inputs, fix the target definition or supply the missing context and re-dispatch; do not let it guess.
3. Orchestrator reviews the coverage map: does the capability decomposition match the target definition, and is each capability at the right level? Fix miscategorized levels by relabeling directly. For wrong or missing decomposition, re-dispatch the mapper in a Revision Pass naming the capabilities to fix.
4. Dispatch `gap-challenger` per its template with the coverage map, the target definition, and the task list. On a repeat pass, dispatch as a Re-Check Pass, adding the challenger's own prior report and the revised map with changed rows marked.
5. If the challenger returns `needs-info`, resolve each Missing For Review item by owner:
   - `orchestrator-context`: supply the missing files or map sections and re-dispatch the challenger only.
   - `operator`: escalate. If the answer changes the target definition, update it and re-dispatch the mapper in a Revision Pass on the affected capabilities before re-challenging.
6. If the challenger returns `gaps-found`, resolve each finding by type:
   - Rating challenges the orchestrator accepts (`covered` to `partial` or `uncovered`, `excess` to needed, or the reverse): relabel directly in the map, carrying the challenger's gap details. Relabels add no new analysis, so they need no mapper dispatch and no re-check.
   - Rating challenges the orchestrator rejects: record the rejection rationale; it goes into the report for operator visibility.
   - Missing capabilities (including broken flow steps and operational gaps that name a capability nobody mapped): re-dispatch the mapper in a Revision Pass on the named capabilities only, merge the returned delta into the map, then return to step 4 as a Re-Check Pass.
7. When the challenger returns `coverage-sufficient`, or every remaining finding was resolved by relabel or recorded rejection, classify each capability rated `partial` or `uncovered` and each confirmed excess task:
   - **New task needed**: capability is uncovered. Route to product-spec-workflow.
   - **Scope expansion**: capability is partial. Recommend the specific scope addition on the existing task; route the updated task to task-refinement-workflow.
   - **Split needed**: an existing task stretches across too many capabilities. Recommend the split boundaries.
   - **Kill/defer**: excess task confirmed. Recommend future-phase or cut; the removal itself is an operator call outside this workflow.
   - **Investigate**: coverage cannot be determined from the available material. Route to research-workflow.
8. If operator input is needed (product tradeoffs on what is in or out of the target): escalate with the coverage map and the specific tradeoff. Record the answer and resume at the step that raised the escalation.
9. Produce the gap analysis report:
   - Full coverage map
   - Specific action per gap (new task, scope expansion, split, kill/defer, investigate) with its routing
   - Rejected challenges with rationale
   - Task count: original vs revised
10. Mark task `ready`.

### Post-all-tasks

1. If multiple targets were analyzed: check for shared gaps across targets. Consolidate each shared gap into a single routed recommendation so downstream workflows do not create duplicate tasks.
2. Verify every recommended action was routed to its named workflow or recorded for the operator.
3. Note in the consolidated summary that confirming actual coverage requires re-running this workflow after the routed actions complete; do not block on it.
4. Mark all `ready` tasks `integrated`.

### Rules

- Steps are executed in order. No step may be skipped.
- The coverage-mapper must read actual task scope. Matching task titles to capability names is not coverage analysis.
- Maximum revision rounds: 2. A round is one coverage-mapper Revision Pass plus one gap-challenger Re-Check Pass. Orchestrator relabels, needs-info resolutions, and pre-challenge corrections do not count against the cap. If the challenger still reports new missing capabilities after 2 rounds, escalate to the operator with the full coverage map and the competing assessments; record the operator's ruling as the final rating for each contested item and resume at step 7 without a further challenger pass.
- Capabilities must be defined from the user's perspective first, then decomposed into supporting and operational layers. Starting from the engineering layer misses user-facing gaps.
- Excess tasks are findings, not failures. A task created before the target was defined may not serve this specific target; that is information, not a mistake.
- This workflow produces recommendations. Actual task creation goes through product-spec-workflow; task removal and reordering are operator calls.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The task list was designed for this target, it's complete" | Plans drift. Tasks were written at a point in time. New information, completed work, and implementation choices all create gaps. Check the actual coverage. | coverage-mapper |
| "We can add missing pieces during implementation" | Unplanned work during implementation is scope creep. If something is needed, plan it now so the cost is visible. | coverage-mapper |
| "That capability is covered by task X" (without reading task X) | Read the task scope. Does it actually deliver the capability, or just work in the same area? "Database schema" does not automatically cover "data migration." | gap-challenger |
| "Operational capabilities aren't needed for MVA" | An MVA that crashes, loses data, or can't be debugged is not viable. Operational capabilities scale with ambition, but the baseline is non-negotiable. | coverage-mapper |
| "We don't need to check end-to-end, each task has acceptance criteria" | Individual task criteria prove each piece works. They don't prove the pieces work together. End-to-end verification catches integration gaps that per-task criteria miss. | gap-challenger |
| "The excess tasks are for future phases, just ignore them" | Are you sure they're not serving an implicit capability you forgot to list? Check before dismissing. If truly excess for this target, mark them explicitly as future-phase. | gap-challenger |
| "This analysis will take too long, we should just start building" | Building without confirming completeness is how you discover missing pieces at integration time, when the cost is 10x higher. | all |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Target outcome defined with user-facing capabilities
- All capabilities decomposed into core, supporting, and operational levels
- Every existing task read and mapped against capabilities
- Coverage ratings assigned with evidence (not title-matching)
- Gap-challenger returned `coverage-sufficient` on the final coverage map, or every remaining finding was resolved by relabel or recorded rejection, or the revision cap was reached and the operator's ruling is recorded
- End-to-end user flows verified against the coverage map
- Every gap classified with a specific action (new task, scope expansion, split, kill/defer, investigate)
- Recommendations routed to appropriate workflows or recorded for the operator

### Forbidden Claims

The following phrases may never appear in gap analysis reports:

- "should be covered by" (without verifying the actual task scope)
- "probably not needed for MVA"
- "we can figure that out later"
- "implicitly covered" (if it's not in a task's scope, it's not covered)
- "close enough to complete"
- "just needs a few more tasks" (without specifying which)
- "the happy path works" (without checking error handling, auth, and operational needs)

### Completion Self-Check

Before marking a gap analysis as complete, the orchestrator must verify:

1. Capabilities were defined from the user's perspective first (not decomposed from engineering concerns).
2. Every existing task was read (actual scope, not just title) and mapped to capabilities.
3. The gap-challenger reviewed the final coverage map. Orchestrator relabels and recorded rejections add no new analysis and do not require a re-check.
4. End-to-end user flows were walked through against the coverage map.
5. Implicit capabilities (auth, error handling, deployment, observability) were checked.
6. Every gap has a specific, routed action, not a vague "needs work."
7. No forbidden claims appear in the report.

If check 1, 2, or 5 fails, re-dispatch the coverage-mapper in a Revision Pass naming the affected capabilities or unread tasks, then the gap-challenger as a Re-Check Pass. If check 3 or 4 fails, re-dispatch the gap-challenger as a Re-Check Pass scoped to what it has not seen. If check 6 or 7 fails, the orchestrator fixes the report directly (classification, routing, phrasing) without new dispatches. After any fix, re-run this self-check.

## Related Workflows

- **product-spec-workflow**: Downstream. "New task needed" actions route here for specification.
- **task-refinement-workflow**: Downstream. Scope expansions and newly specified tasks route here to become implementation-ready.
- **research-workflow**: Downstream. Investigate actions route here when coverage cannot be determined from the map.
- **roadmap-health-workflow**: Sibling. Gap-analysis checks completeness, roadmap-health checks soundness. Run both for a full picture.
