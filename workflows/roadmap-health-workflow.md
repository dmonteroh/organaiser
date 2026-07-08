---
id: roadmap-health-workflow
name: Roadmap Health Check Workflow
triggers: [roadmap-review, milestone-check, progress-assessment, course-correction]
---

# Roadmap Health Check Workflow Contract

Periodic assessment that asks: are we still building the right things? Compares actual progress against the plan, audits the assumptions behind the roadmap, and produces specific course corrections when reality has diverged from the plan.

This workflow does not reorder the backlog (reordering is an operator call outside this workflow). It diagnoses whether the current plan is still sound and produces actionable recommendations. It answers "Is what we have still sound?", not "Do we have everything we need?" (that is gap-analysis-workflow).

## Roles

### progress-assessor

- Template: `subagents/progress-assessor-prompt.md`
- Mode: analytical (reads task files, session logs, codebase state; must NOT modify)
- Constraints:
  - Must assess actual state, not planned state: read the code, not just the task status
  - Must identify velocity patterns (what's taking longer than expected, what went faster)
  - Must flag blocked items and silent blockers (items that look "in progress" but are stuck)
  - Must compare actual dependency resolution against the planned sequence
  - Supports a Follow-Up Pass: re-assesses only named items against its prior report and returns a delta

### assumption-auditor

- Template: `subagents/assumption-auditor-prompt.md`
- Mode: adversarial review of the plan's foundations (read-only)
- Gate type: structured (plan-sound | corrections-needed | needs-info)
- Constraints:
  - Must identify the assumptions behind the current roadmap and check each against current evidence
  - Must look for external changes (ecosystem shifts, dependency updates, new information) that invalidate plan assumptions
  - Must check if early task outcomes revealed things that change the value of later tasks
  - Must NOT propose a new roadmap: only flag where the current one is unsound and classify findings for routing
  - Supports a Scoped Re-Audit: audits only named items against its prior report and returns a delta

## Health Check Dimensions

The progress-assessor evaluates the roadmap on these axes:

| Dimension | What it measures |
|---|---|
| Progress fidelity | Does actual progress match planned progress? Where are the gaps? |
| Velocity trend | Are things taking longer or shorter than expected? Is there a pattern? |
| Blocker inventory | What is currently blocked? What is silently stuck? What is at risk of blocking? |
| Dependency health | Have dependencies resolved as expected? Are downstream items still viable? |
| Scope drift | Have completed tasks stayed within their original scope? Has scope crept? |
| Waste detection | Has any completed work become irrelevant due to changed circumstances? |

## Sequence

### Per-task

1. Define the health check scope:
   - What milestone or time period are we reviewing?
   - What triggered this check? (Scheduled, gut feeling, blocker hit, milestone reached)
   - What is the current state of the work index?
2. Dispatch `progress-assessor` per its template with the review scope (milestone, trigger, work index) and the planned state. If it reports missing inputs, supply them and re-dispatch; do not let it guess.
3. Dispatch `assumption-auditor` per its template with the progress report, the original roadmap with rationale, and project context (ADRs, completed work, external context).
4. If the assumption-auditor returns `needs-info`, resolve each Missing For Review item by owner:
   - `orchestrator-context`: supply the missing roadmap sections or project context and re-dispatch the auditor only.
   - `progress-data`: re-dispatch the progress-assessor in a Follow-Up Pass on the named items, then re-dispatch the auditor with the delta.
   - `operator`: escalate. Record the answer and re-dispatch the auditor with it.
   - Auditor re-dispatches after a needs-info resolution run as a Scoped Re-Audit and do not count against the audit cap.
5. If the assumption-auditor returns `plan-sound`, skip to step 7.
6. If the assumption-auditor returns `corrections-needed`, the orchestrator reviews each recommendation and classifies it:
   - **Resequence**: order needs to change (recommend the new order; the reordering itself is an operator call)
   - **Respec**: a planned item needs its specification revised (route to product-spec-workflow)
   - **Kill**: a planned item is no longer justified (document rationale; the removal itself is an operator call)
   - **Add**: a new need emerged from what we learned (route to product-spec-workflow)
   - **Investigate**: not enough information to decide (route to research-workflow)
   - Recommendations the orchestrator rejects: record the rejection rationale; it goes into the report for operator visibility.
7. If operator input is needed for course corrections: escalate with full context. Record the answer and resume at the step that raised the escalation.
8. Produce the health check report:
   - Planned vs actual comparison on all health check dimensions
   - Assumption audit results with evidence
   - Each finding classified with its action and routing (resequence, respec, kill, add, investigate, or stay-the-course)
   - Rejected recommendations with rationale
9. Mark task `ready`.

### Post-all-tasks

1. If multiple health checks: synthesize into an overall project health summary. If two health checks produce contradictory recommendations for the same item, escalate both to the operator; the affected tasks stay `ready` until the operator resolves the contradiction.
2. Verify all recommended actions have been routed to the appropriate workflow or recorded for the operator.
3. Mark all `ready` tasks `integrated`.

### Rules

- Steps are executed in order. No step may be skipped.
- The progress-assessor must check actual codebase state, not just task status labels. A task marked "approved" that has no code written has a different meaning than one with a half-finished PR.
- Maximum assumption-auditor passes: 1 full audit. Scoped Re-Audits after a needs-info resolution or a self-check failure complete the original pass and do not count. This is a diagnostic workflow, not a fix workflow. It identifies problems and routes them elsewhere.
- "Stay the course" is a valid and valuable outcome, but it must be evidence-backed, not assumed.
- Course corrections route to other workflows (product-spec, research) or to the operator (reordering, removal). This workflow diagnoses; it does not fix.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "We're on track" (without checking actual state) | Feeling on-track and being on-track are different. Read the code, read the task files, compare against the plan. | progress-assessor |
| "It's too early to assess" | If you have completed work, you have data. Even a single completed task reveals velocity, scope accuracy, and assumption validity. | all |
| "The plan is fine, nothing has changed" | Have you checked? External dependencies evolve, early tasks reveal hidden complexity, and assumptions age. Verify, don't assume. | assumption-auditor |
| "We'll course-correct when something breaks" | Reactive course correction is expensive. A planned health check catches drift early, when corrections are cheap. | all |
| "Reviewing takes time away from building" | Building the wrong thing takes more time. A 2-hour health check that prevents a week of wasted work is a net positive. | all |
| "We already know what needs to change" | Then the health check will confirm it in 30 minutes and produce a documented recommendation. If you're wrong, it'll catch that too. | all |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Actual progress compared against planned progress on all health check dimensions
- Assumption audit completed for all upcoming planned items
- Each finding classified with a specific action (resequence, respec, kill, add, investigate, or stay-the-course)
- Action items routed to appropriate workflows or recorded for the operator
- Rejected recommendations recorded with rationale
- Health check report produced with evidence for all findings

### Forbidden Claims

The following phrases may never appear in health check reports:

- "generally on track" (without dimension-by-dimension evidence)
- "no concerns" (without having checked each dimension)
- "minor delays, nothing to worry about" (without velocity trend analysis)
- "the plan still makes sense" (without assumption verification)
- "we'll catch up" (without evidence of what changes to enable catching up)
- "slight scope creep but manageable" (without quantifying the creep)

### Completion Self-Check

Before marking a health check as complete, the orchestrator must verify:

1. The progress-assessor read actual codebase state and task files (not just status labels).
2. The assumption-auditor checked assumptions against current evidence (not the evidence available when the plan was made).
3. Every finding has a specific, routed action (not a vague "we should look into this").
4. "Stay the course" findings have evidence, not just absence of counter-evidence.
5. No forbidden claims appear in the report.

If check 1 fails, re-dispatch the progress-assessor in a Follow-Up Pass on the unverified items, then the assumption-auditor as a Scoped Re-Audit if the delta changes any assumption's evidence. If check 2 or 4 fails, re-dispatch the assumption-auditor as a Scoped Re-Audit on the affected items; this completes the original pass and does not count against the audit cap. If check 3 or 5 fails, the orchestrator fixes the report directly (classification, routing, phrasing) without new dispatches. After any fix, re-run this self-check.

## Related Workflows

- **product-spec-workflow**: Downstream. Respec and add actions route here for specification.
- **research-workflow**: Downstream. Investigate actions route here.
- **gap-analysis-workflow**: Sibling. Roadmap-health checks soundness, gap-analysis checks completeness. Run both for a full picture.

## Skill Dependencies

- **tracks-conductor-protocol**: For updating the work index after course corrections.

These are references, not injected context. Roles load them as needed.
