---
id: spike-workflow
name: Spike / Prototype Workflow
triggers: [spike, prototype, proof-of-concept, exploration, time-boxed-experiment]
---

# Spike / Prototype Workflow Contract

Time-boxed exploration that intentionally writes throwaway code to answer a specific question. The output is validated learning, not production code. Every spike ends with an explicit adopt/adapt/abandon decision.

## Roles

### explorer

- Template: `subagents/explorer-prompt.md`
- Mode: experimental implementation (may write code, but in a scoped sandbox)
- Constraints:
  - Must work within the defined time/scope box
  - Must prioritize learning speed over code quality; this is intentionally throwaway
  - Must document what was learned as they go, not just at the end
  - Must stop at the scope boundary even if "almost done". Scope creep kills spikes
  - If the spike answers the question early: STOP and report. Don't keep building.

### spike-reviewer

- Template: `subagents/spike-reviewer-prompt.md`
- Mode: read-only assessment (reviews what was learned, not code quality)
- Gate type: structured (question-answered | inconclusive | needs-more-exploration)
- Constraints:
  - Reviews whether the spike ANSWERED THE QUESTION, not whether the code is good
  - Identifies what was learned and what remains unknown
  - Assesses whether findings are sufficient for the adopt/adapt/abandon decision
  - Does NOT review code quality. Spike code is throwaway by definition

## Spike Contract

Every spike must define these up front before exploration begins:

| Field | Purpose |
|---|---|
| Question | The specific question this spike answers. One question, not a wishlist. |
| Hypothesis | What we expect to find, and why. This is what we're testing. |
| Scope box | What the explorer may touch. Typically a scratch directory or worktree. |
| Time box | Maximum effort before forced checkpoint. Express as task count or scope, not wall-clock time. |
| Success signal | What evidence would confirm the hypothesis? |
| Failure signal | What evidence would disprove it? What would make us abandon? |
| Forbidden | What the explorer must NOT do (e.g., modify production code, add dependencies to the project's main dependency manifest). |

## Sequence

### Per-task

1. Define the spike contract (question, hypothesis, scope/time box, success/failure signals)
2. Dispatch `explorer` with the spike contract:
   - Work within scope box
   - Document findings incrementally
   - Stop at scope boundary or when the question is answered, whichever comes first
3. Barrier: confirm explorer session exited
4. Dispatch `spike-reviewer` to assess findings:
   - Did the spike answer the question?
   - What was learned?
   - What remains unknown?
   - Is there enough evidence for the decision gate?
   - Route on the verdict: `question-answered` goes to the decision gate (step 7); `inconclusive` goes to step 5; `needs-more-exploration` goes to step 6.
5. If spike-reviewer returns `inconclusive`:
   - Orchestrator reviews: is a second exploration pass worth the cost?
   - If yes: narrow the question, dispatch `explorer` for targeted follow-up, then go to step 3
   - If no: proceed to decision gate with partial findings
6. If spike-reviewer returns `needs-more-exploration`:
   - Escalate to operator: extend the time box or proceed with current findings?
7. Decision gate: orchestrator (or operator) decides:
   - **Adopt**: Findings are positive. Create a follow-up task, refine it through task-refinement-workflow, then build it under dev-workflow. Spike code is reference only, not promoted directly.
   - **Adapt**: Findings are partially positive. Adjust the approach based on what was learned, then create a follow-up task with the adapted design, refine it through task-refinement-workflow, and build it under dev-workflow.
   - **Abandon**: Findings disprove the hypothesis or reveal unacceptable costs. Document what was learned for future reference. Propose deleting the spike code and wait for explicit operator approval before deleting anything.
8. Record decision with rationale and link to findings
9. Resolve spike artifacts: propose which scratch code to keep as reference and which to delete, then delete only after explicit operator approval. Never delete spike code unilaterally.
10. Mark task `ready`

### Post-all-tasks

1. If multiple spikes: check for contradictory findings across spikes
2. Confirm every spike artifact is resolved: each scratch directory is either retained as marked reference or deleted with operator approval. Do not delete without approval.
3. Mark all tasks `integrated`

### Rules

- Steps are executed in order. No step may be skipped.
- The decision gate (step 7) is mandatory. Every spike ends with adopt, adapt, or abandon. "Let's keep exploring" is not a valid outcome. Either extend the time box explicitly or decide.
- Maximum exploration passes: 2. If two passes can't answer the question, the spike is inconclusive. Document findings and abandon or restructure as a research task.
- Spike code must NEVER be promoted to production directly. "Adopt" means "create a new task to build it properly," not "merge the spike."
- The spike-reviewer does NOT review code quality. Spike code is throwaway. Reviewing its quality wastes the time the spike was designed to save.
- Spike code is never deleted without explicit operator approval. The orchestrator proposes what to delete; the operator decides. Until approved, retain the code and label it as throwaway.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The spike code is good enough, let's just use it" | Spike code was written for speed, not quality. It skipped tests, reviews, and quality gates. Promoting it creates technical debt by design. Always rewrite under dev-workflow. | decision gate |
| "We're almost done, let me keep going" | Scope creep is the #1 spike failure mode. If you're past the scope box, stop and report what you've learned. The findings might already answer the question. | explorer scope |
| "The question changed during exploration" | That's a valid finding. Report it. A new question needs a new spike contract, not an extended old one. | explorer scope |
| "We don't need a spike-reviewer for this" | The reviewer checks if the question was answered, not code quality. Skipping it means no one verifies the spike actually achieved its goal. | spike-reviewer |
| "Let's skip the decision gate, it's obvious we should adopt" | If it's obvious, the gate takes 30 seconds. If it's not, you just proved why the gate exists. | decision gate |
| "I'll clean up the spike code later" | Deferred cleanup becomes mystery code in 2 weeks. Decide each artifact's disposition now: label it as kept reference, or flag it for deletion. Deciding the disposition is not deleting, so it does not need approval. Don't leave it unresolved. | cleanup |
| "It's throwaway code, I'll just delete it" | Flagging for deletion is not deletion. Spike code is removed only after explicit operator approval; the operator may want to inspect or keep it. Never delete unilaterally. | cleanup |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Spike contract was defined before exploration began
- Explorer worked within the defined scope box
- Spike-reviewer assessed whether the question was answered
- Decision gate produced an explicit adopt/adapt/abandon with rationale
- Findings documented (what was learned, what remains unknown)
- Spike artifacts resolved (code marked as reference-only, or deleted only with explicit operator approval)
- If adopt/adapt: follow-up task created (refined via task-refinement-workflow, built under dev-workflow)

### Forbidden Claims

The following phrases may never appear in spike completion reports:

- "the spike code is production-ready"
- "just needs a few tweaks to be ready"
- "we can clean it up later"
- "good enough for now"
- "let's keep exploring" (without an extended time box)
- "the question wasn't quite right but we built something useful"

### Completion Self-Check

Before marking a spike as complete, the orchestrator verifies:

1. The spike answered the original question, or documented why it couldn't.
2. If adopt/adapt: a follow-up task exists and references the spike findings.
3. Any spike-code deletion was explicitly approved by the operator.
4. No forbidden claims appear in the completion report.

## Related Workflows

- **task-refinement-workflow**: Adopt/adapt decisions create a follow-up task refined here before implementation.
- **dev-workflow**: The refined follow-up task is built under dev-workflow. Spike code is reference only.
- **research-workflow**: A spike that stays inconclusive after two passes may be restructured as a research task.
- **decision-workflow**: Use when the adopt/adapt/abandon call hinges on a blocking architectural or strategic decision.
