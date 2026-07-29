---
id: product-spec-workflow
name: Product Specification Workflow
triggers: [specification, product-spec, problem-statement, feature-definition]
---

# Product Specification Workflow Contract

Transforms a raw idea, user need, friction point, opportunity, or respec request into a precise product intent contract. Enforces the SDD Handshake Protocol: User Truth, Business Invariants, Non-Goals, evidence discipline, and the "So What?" filter.

The output is a product specification decision, not code. A successful `specified` outcome feeds into task-refinement-workflow. A non-spec outcome documents why the idea is shelved or routed elsewhere.

## Roles

### problem-definer

- Template: `subagents/problem-definer-prompt.md`
- Mode: analytical (reads codebase for context, does NOT write code)
- Constraints:
  - Must frame the problem from the user's perspective first, not the solution
  - Must distinguish evidence, assumptions, open questions, and product judgment
  - Must produce explicit User Truth, Business Invariants, and Non-Goals
  - Must apply the "So What?" filter: if it doesn't move a core metric or solve a verified friction, it fails
  - Must define testable acceptance criteria, not vague outcomes
  - Must identify what this specification says "No" to (zero-sum visibility)
  - Must return an explicit draft verdict: `proceed`, `shelve`, `needs-research`, `needs-decision`, or `needs-operator`

### spec-challenger

- Template: `subagents/spec-challenger-prompt.md`
- Mode: adversarial review from engineering's perspective (read-only: may read the codebase, backlog, and ADRs to verify claims, must not modify files)
- Gate type: tri-state (pass | gaps-found | needs-info)
- Constraints:
  - Must challenge from buildability: can engineering actually implement this as specified?
  - Must check if acceptance criteria are testable and unambiguous
  - Must check whether evidence supports User Truth and "So What?" claims
  - Must identify hidden assumptions the problem-definer may have made
  - Must check for conflicts with existing scope (other tasks, ADRs, architectural constraints)
  - Must verify Non-Goals are actually non-goals (not deferred scope disguised as exclusions)
  - Must flag forbidden vague claims (see Forbidden Claims under Completion) as gaps
  - On `needs-info`, must name each missing item and its owner (orchestrator-context | operator | research | decision) so the orchestrator can route without guessing
  - Supports a Re-Check Pass: on a re-dispatch after a revision, challenges only the revised sections plus its prior findings instead of re-challenging the full spec

## Local Capabilities

When dispatching subagents, the orchestrator should tell them to use any locally available skills, tools, or project conventions that directly improve their assigned role. Skills are optional capabilities, not required dependencies. If a skill is unavailable, the subagent must continue using this workflow contract alone.

## Final States

Each workflow run must end in exactly one state:

| State | Meaning | Next step |
|---|---|---|
| `specified` | The product intent is clear, evidenced, bounded, and challenger-approved. | Route to task-refinement-workflow. |
| `shelved` | The idea does not justify specification or engineering effort now. | Record rationale and stop. |
| `needs-research` | User truth, domain facts, market facts, or evidence are too weak. | Route to research-workflow. |
| `needs-decision` | An architectural, platform, or strategic choice blocks the spec. | Route to decision-workflow. |
| `needs-operator` | Product or business judgment with no safe default blocks the spec. | Record the question in the run's open-questions file; it joins the end-of-run batch. |

## Operator Question Bar

Most judgment calls surfaced while specifying resolve as recorded assumptions with stated defaults, not operator questions. An item may be routed to the operator only when at least one of these criteria holds:

1. It is product, permission, or business-policy judgment (who may do what, what ships, relative priority).
2. It commits a new externally visible capability or contract (new endpoint, schema field, or API behavior) not already in the task's scope.
3. A wrong default would be expensive to reverse after implementation (data migration, published contract, user-visible workflow change).
4. It contradicts a recorded operator decision, spec assumption, or ADR.

Items that meet the bar and carry a safe stated default do not block the spec: the spec proceeds with the default as a named assumption, and the question is recorded in one run-level open-questions file with context, options, impact, and the default. The operator reviews the batch once, at the end of the run; a confirmed default is bookkeeping only, a changed answer re-enters as an operator-answer re-dispatch. Only an item that meets the bar and has no safe default makes the spec `needs-operator`.

## Specification Structure

Every specification produced by this workflow must contain:

| Section | Purpose |
|---|---|
| Problem Statement | What is actually happening in the real world that needs to change? |
| User Truth | Who experiences this problem, when, and what do they do today? |
| Evidence | What supports the User Truth and "So What?" claim? |
| Assumptions and Open Questions | What is inferred, uncertain, or unresolved? |
| Business Invariants | What rules or logic must NEVER be broken? These are constraints, not features. |
| Non-Goals | What are we explicitly NOT solving? Why? |
| Proposed Solution | High-level product approach: what changes for the user? Not implementation details. |
| Acceptance Criteria | Testable conditions that define "done." Each must be verifiable by a human or automated test. |
| Success Metrics | How do we know this worked? What moves? (Even if qualitative for a solo project.) |
| Scope Impact | What existing tasks, ADRs, or plans does this affect? What are we saying "No" to by saying "Yes" to this? |

## Sequence

### Per-task

1. Gather raw input from the operator:
   - Trigger: what prompted this idea, need, friction point, opportunity, or respec?
   - User: who experiences the problem?
   - Current behavior: what happens today?
   - Desired change: what should be different for the user?
   - Evidence: what proves or suggests this is real?
   - Context: existing notes, conversations, or related material the operator provides.
   - Constraints: timeline, business rules, dependencies, technical limits.
   - Known non-goals: what should this explicitly not cover?
2. Gather existing project context:
   - Current backlog or task index
   - Relevant ADRs or decision records
   - Related tasks, prior specs, research notes, or roadmap constraints
   - Existing architecture constraints that affect product feasibility
3. Dispatch `problem-definer` with the operator input and project context (full text, not file references; missing items marked `unknown`). On revision passes, also include the prior draft and the challenger findings. The template owns the framing, evidence, "So What?", acceptance criteria, and scope impact duties.
4. Orchestrator reviews the draft verdict:
   - If `shelve`: record the rationale and mark final state `shelved`
   - If `needs-research`: record missing evidence and mark final state `needs-research`
   - If `needs-decision`: record the blocking decision and mark final state `needs-decision`
   - If `needs-operator`: check each item against the Operator Question Bar. Items that fail the bar go back to the `problem-definer` as assumptions to name and proceed on (return to step 3). Items that meet the bar with a safe stated default: record them in the run's open-questions file and re-dispatch `problem-definer` to proceed on the defaults as named assumptions (return to step 3). Only when an item meets the bar and has no safe default: mark final state `needs-operator` and continue with any other specs; the question joins the end-of-run batch.
   - If `proceed`: continue to the challenger gate
5. Dispatch `spec-challenger` with the full draft specification and existing project context. The template owns the challenge checks: buildability, evidence and assumptions, acceptance criteria precision, hidden assumptions, scope conflicts, non-goals, forbidden claims. On a re-dispatch after a revision, dispatch it as a Re-Check Pass: include its prior report and mark the revised sections.
6. If `spec-challenger` returns `needs-info`, route by the missing item and owner it names:
   - `orchestrator-context` (backlog, ADRs, architecture facts the orchestrator can gather): gather it and re-dispatch `spec-challenger` (return to step 5). Do not re-run the problem-definer for context that leaves the spec unchanged.
   - `research` (missing research evidence): mark final state `needs-research`.
   - `decision` (missing decision record): mark final state `needs-decision`.
   - `operator` (missing product or business judgment): apply the Operator Question Bar. With a safe stated default, record the question in the open-questions file and re-dispatch `spec-challenger` instructed to assess the spec on the default as a named assumption (return to step 5). Without a safe default, mark final state `needs-operator`; the question joins the end-of-run batch.
   Maximum `needs-info` resolutions per run: 2. If the challenger still cannot complete the review, mark the non-spec final state matching the dominant missing item.
7. If `spec-challenger` returns `gaps-found`, dispatch `problem-definer` with the prior draft and the challenger findings to revise, then return to step 4.
8. If `spec-challenger` returns `pass`, finalize the product specification and mark final state `specified`.
9. Determine next step:
   - If final state is `specified`: create or update the task entry and recommend task-refinement-workflow
   - If final state is `needs-decision`: recommend decision-workflow
   - If final state is `needs-research`: recommend research-workflow
   - If final state is `shelved` or `needs-operator`: stop after recording context

### Post-all-tasks

1. If multiple specs were produced: check for scope conflicts between them. If specs conflict, treat each affected spec as `gaps-found` (return to per-task step 7 for it; the revision cap applies). When the conflict is a priority call rather than a spec defect, record it in the open-questions file for the end-of-run batch; the affected specs keep their states and the answer is processed per step 6 below.
2. Verify no spec undermines an existing ADR without flagging it. An unflagged ADR conflict is `gaps-found` for that spec.
3. Update backlog or work index if new tasks were created
4. Mark each spec whose final state is `specified` as `integrated`. Non-spec outcomes keep their recorded final state.
5. Present the batched operator items once: every open question across all specs, each with context, options, impact, and its stated default. The run completes without waiting for answers; the run report lists `specified` specs separately from `needs-operator` ones so downstream refinement can start while the operator works the batch.
6. Process operator answers when they arrive (typically after the run): a confirmed default is orchestrator bookkeeping only (mark the question resolved, the assumption stands). A changed answer re-enters as an operator-answer re-dispatch scoped to the affected spec (it does not count toward the revision cap).

### Rules

- Steps are executed in order. No step may be skipped.
- Operator context gathering is required, but incomplete answers are allowed. Missing context must be preserved as `unknown`, not invented.
- The "So What?" gate is a legitimate kill point. Not every idea deserves a specification. Shelving is a valid outcome.
- Maximum revision loops from challenger findings back to `problem-definer`: 2. Only `gaps-found` revisions count toward this cap; `needs-info` resolutions (capped separately in step 6) and operator-answer re-dispatches do not. If a spec cannot pass the challenger after 2 revisions, stop and return the non-spec state matching the dominant unresolved gap: `needs-research` for missing evidence, `needs-decision` for a blocking choice, otherwise `needs-operator`.
- The problem-definer must never describe implementation. "Use PostgreSQL JSONB" is not a spec; "structured data must be queryable by field" is.
- Acceptance criteria must be testable. "Users should have a good experience" is not a criterion. "User can complete X in under Y steps" is.
- Unsupported product claims are not allowed. If a User Truth or "So What?" claim rests on weak evidence, record it as an assumption and choose the appropriate non-spec state unless the operator explicitly accepts it.
- Operator questions are batched, never synchronous. No step may wait mid-run on an operator answer; the open-questions file plus the end-of-run presentation is the only escalation channel.
- The run report must count defaulted assumptions recorded and operator questions asked, and, once answers arrive, how many defaults the operator changed. If across recent runs roughly 9 in 10 questions come back confirmed unchanged, the Operator Question Bar is being applied too loosely: tighten classification instead of asking more.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The solution is obvious, skip the problem framing" | Obvious solutions to poorly framed problems solve the wrong thing. Frame the problem first. | problem-definer |
| "We already discussed this, just write it up" | Discussion is not specification. Informal agreement has implicit assumptions. Make them explicit. | problem-definer |
| "The acceptance criteria are clear enough" | "Clear enough" means different things to the spec writer and the implementer. If the challenger can't write a test from the criteria, they're not clear enough. | spec-challenger |
| "This is a small feature, it doesn't need a full spec" | Small features with vague specs cause the most rework. The spec can be short, but it must be precise. | all |
| "Non-goals will be obvious to the team" | Unwritten non-goals become "I thought we were doing that too" at review time. Write them down. | problem-definer |
| "We need to move fast, skip the challenger" | Specs that fail the challenger fail harder during implementation. 30 minutes of challenge saves days of rework. | spec-challenger |
| "The engineering team can figure out the details" | That's implementation details (task-refinement). But acceptance criteria, invariants, and non-goals are YOUR job. Don't delegate the "What." | problem-definer |
| "We know users want this" | Claims about users need evidence, a named assumption, or operator ownership. Do not smuggle guesses into User Truth. | problem-definer |
| "Better to confirm this with the operator" | A confirmed default changes nothing and costs an interaction. If the item fails the Operator Question Bar, name the assumption and proceed; if it passes with a safe default, record the question and still proceed. | operator question bar |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required For Every Final State

- Operator input gathered or explicitly marked unknown
- Evidence, assumptions, and open questions documented
- "So What?" filter applied
- Final state recorded as `specified`, `shelved`, `needs-research`, `needs-decision`, or `needs-operator`
- Next step determined and recorded

### Required For `specified`

- Problem Statement, User Truth, Evidence, Business Invariants, and Non-Goals are all explicitly documented
- Acceptance criteria are testable; each can be verified by a human or automated test
- Spec-challenger reviewed the final version and returned `pass`
- Scope impact assessed against existing backlog and ADRs
- Recommended next step is task-refinement-workflow

### Required For Non-Spec States

- `shelved`: rationale documents why the idea does not justify specification or engineering effort now
- `needs-research`: missing evidence is specific enough to route into research-workflow
- `needs-decision`: blocking decision is specific enough to route into decision-workflow
- `needs-operator`: operator question is framed with context, options, and impact, recorded in the run's open-questions file, and had no safe default to proceed on

### Forbidden Claims

The following phrases may never appear in product specifications:

- "intuitive" or "user-friendly" (without measurable criteria)
- "fast" or "performant" (without a target metric)
- "simple" (without defining what simplicity means in this context)
- "flexible" or "extensible" (without specifying what must flex and what must not)
- "best practice" (without citing which practice and why it applies here)
- "users want" (without evidence, interviews, data, or at minimum a stated assumption)
- "and more" or "etc." (scope must be explicit, not open-ended)

### Completion Self-Check

Before marking a specification as complete, the orchestrator must verify:

1. Every section in the Specification Structure is filled (or explicitly marked N/A with rationale).
2. Evidence, assumptions, and open questions are separated.
3. The "So What?" filter was applied and its result matches the final state.
4. If final state is `specified`, the spec-challenger reviewed the final version, not an earlier draft.
5. Non-Goals are genuine exclusions, not deferred features disguised as non-goals.
6. Acceptance criteria can be turned into test cases without further clarification.
7. No forbidden claims appear in the specification.

If any self-check item fails, do not finalize: treat the failure as `gaps-found` and return to per-task step 7 (counts toward the revision cap). If the cap is exhausted, mark `needs-operator` with the unresolved items.

## Related Workflows

- **task-refinement-workflow**: Use after `specified` when implementation planning is needed.
- **decision-workflow**: Use when the specification surfaces a blocking architectural, platform, or strategic decision.
- **research-workflow**: Use when User Truth, domain facts, market facts, or evidence are too weak to specify honestly.
- **design-intake-workflow**: Upstream. Behavior changes found in external design deliverables arrive here for specification, carrying the deliverable evidence.
