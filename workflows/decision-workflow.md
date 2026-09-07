---
id: decision-workflow
name: ADR / Decision Workflow
triggers: [decision, architecture-decision, option-evaluation, technology-selection]
contractVersion: 2.0.0
runnerManifest: manifests/decision-workflow.v1.yaml
resultSchema: schemas/stage-result.schema.json
manualMode: supported
runnerMode: supported
---

# ADR / Decision Workflow Contract

Structured decision-making process that produces an evidence-backed architectural decision record. Research feeds into option comparison, a devil's advocate challenges the preferred option, and the final decision is documented as an immutable ADR.

This workflow produces a decision artifact (ADR), not code. It may reference the research-workflow for evidence gathering and the adr-madr-system skill for document formatting.

## Roles

### decision-architect

- Template: `subagents/decision-architect-prompt.md`
- Mode: task-document authority. Reviews the tradeoff matrix, selects the preferred option with a written rationale, responds to devil's advocate concerns, and produces the ADR.
- Gate type: none (producer role; `status` carries the outcome, per `conventions.md:106`)
- Constraints:
  - Must reject each alternative with a stated reason, not merely name a winner
  - Must accept or rebut every critical/important devil's-advocate concern; minor concerns are recorded, not adjudicated
  - Must produce the ADR in MADR format via the adr-madr-system skill and index it
  - Escalates to the operator only where the Sequence says so (a product or business tradeoff it cannot weigh from evidence)
- In manual mode, the orchestrator may embody this role directly rather than dispatching a subagent. In runner mode, the runner dispatches this subagent at each of its three Sequence-step positions (5, 7, 9).

### researcher

- Template: `subagents/researcher-prompt.md`
- Mode: read-only investigation (reused from research-workflow)
- Constraints:
  - Must investigate ALL candidate options, not just the preferred one
  - Must gather evidence for AND against each option
  - Must identify tradeoffs, not just advantages
  - Coverage must include: existing codebase patterns, ecosystem maturity, operational implications
- This workflow has no cross-checker; the evaluator's evidence-sufficiency check is the gate on the findings, and the researcher's Follow-Up Pass mode handles evidence-gap rounds.

### evaluator

- Template: `subagents/evaluator-prompt.md`
- Mode: read-only analysis (must NOT make the decision, only structure the comparison)
- Gate type: structured (sufficient | insufficient evidence)
- Constraints:
  - Must produce a tradeoff matrix with consistent dimensions across all options
  - Must rate each option against the decision drivers, not in the abstract
  - Must not recommend, only compare. The decision is the architect's job.
  - Must flag where evidence is weak or missing for any option, as named re-research items

### devils-advocate

- Template: `subagents/devils-advocate-prompt.md`
- Mode: adversarial review of the preferred option (read-only)
- Gate type: structured (pass | concerns-raised)
- Constraints:
  - Must argue against the preferred option using evidence, not rhetoric
  - Must identify failure modes, hidden costs, and lock-in risks specific to the preferred option
  - Must check if rejected options were fairly evaluated or strawmanned
  - If the preferred option survives scrutiny, that strengthens the decision. This is the point.

## Decision Drivers

Every decision must define its drivers up front. The evaluator uses these as comparison axes:

| Driver category | Examples |
|---|---|
| Functional fit | Does it solve the stated problem? What gaps remain? |
| Complexity cost | How much complexity does it add to the project? Learning curve? |
| Ecosystem / maturity | Community size, maintenance status, documentation quality |
| Operational impact | Deployment, monitoring, debugging, failure modes |
| Lock-in / reversibility | How hard is it to switch later? What are you committing to? |
| Alignment | Does it fit existing patterns in the codebase? Or does it introduce a new paradigm? |

Workflows may add domain-specific drivers. The evaluator must cover at least these six.

## Sequence

### Per-task

1. Define the decision question and decision drivers
   - What specific question are we answering?
   - What are the candidate options (minimum 2)? If only one viable candidate exists, include the status quo (do nothing / keep current approach) as an option; a decision needs at least one alternative.
   - What are the decision drivers and their relative weights?
2. Dispatch `researcher` per its template with the decision question, the candidate options as scope, and a per-option findings deliverable format.
3. Dispatch `evaluator` per its template with the research findings, the candidate options, and the weighted decision drivers.
4. If the evaluator returns `insufficient` evidence:
   - Re-dispatch `researcher` in follow-up mode with the evaluator's re-research items as the gap list, merge the returned delta into the findings, then re-dispatch `evaluator` as a re-evaluation pass with the merged findings and its prior matrix.
   - Maximum evidence rounds: 1 (manifest authority: manifests/decision-workflow.v1.yaml's caps.evidenceRounds) (a round is one researcher follow-up plus one evaluator re-evaluation). If evidence is still `insufficient` after the round, proceed with the `unknown` ratings standing; the architect must name each remaining gap in the rationale or escalate the decision to the operator.
5. Architect reviews the tradeoff matrix and selects a preferred option with a written rationale, including reasons for rejecting each alternative.
6. Dispatch `devils-advocate` per its template against the preferred option, passing the rationale, the tradeoff matrix, the research findings, and the rejected options. On a repeat pass, also pass all prior devil's advocate reports.
7. If devils-advocate returns `concerns-raised`:
   - Architect responds to each critical and important concern: accept (adjust the decision or add a mitigation) or rebut (with evidence). Minor concerns are recorded in the ADR as known tradeoffs without adjudication.
   - Record every response; they go into the ADR (consequences, mitigations, or rejection rationale).
   - If the responses change the preferred option: return to step 6 with the new preferred option.
   - If all concerns are accepted or rebutted without changing the preferred option: proceed to step 8.
8. If operator input is needed (a product or business tradeoff the architect cannot weigh from evidence): escalate with the decision question, matrix, rationale, and open concerns. Record the operator's answer in the ADR and resume at the step that raised the escalation.
9. Produce the ADR artifact using the adr-madr-system skill format and index it in the ADR README. The ADR records the drivers, considered options, decision outcome, concern responses, and remaining risks.
10. Mark task `ready`.

### Decision queue reconciliation

This step never claims the board is complete.

1. If multiple decisions were made: check for contradictions between decisions. If found, surface to the operator with both ADRs; the affected tasks stay `ready` (not `integrated`) until the operator resolves which decision stands or one ADR is superseded.
2. Verify no decision undermines a prior accepted ADR without explicitly superseding it. If one does, add the supersedes relation per the adr-madr-system skill; if the conflict is substantive rather than formal, escalate to the operator as in step 1.
3. Report each decision's final state to the board workflow.

### Rules

- Steps are executed in order. No step may be skipped.
- The evaluator must never recommend. Recommendations without adversarial review create confirmation bias.
- The devils-advocate must argue with evidence. Rhetorical objections without citations are invalid.
- Maximum decision loops (step 7 back to step 6): 2 (manifest authority: manifests/decision-workflow.v1.yaml's caps.decisionLoops). If the preferred option changes twice, escalate the full decision context (matrix, rationale history, all devil's advocate reports) to the operator. The operator's choice becomes the decision; record their rationale and the disposition of open concerns in the ADR and resume at step 9 without a further devil's advocate pass.
- The architect makes the decision, not the evaluator or the devils-advocate. Roles inform; the architect decides.
- The ADR is immutable once accepted. Future changes supersede, not edit.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The answer is obvious, skip evaluation" | Obvious answers don't need a decision workflow. If you're here, evaluate properly. | evaluator |
| "We only have one real option" | If there's only one option, document why alternatives were rejected. A decision with no alternatives is an assumption, not a decision. | researcher |
| "The preferred option is clearly best, skip devil's advocate" | That's exactly when the devil's advocate is most valuable: unchallenged preferences hide blind spots. | devils-advocate |
| "The devil's advocate is just being contrarian" | Check: are the concerns evidence-backed? If yes, address them. If actually unsupported, rebut with evidence. | devils-advocate |
| "We need to move fast, skip the full process" | Fast decisions with poor foundations create slow projects. The rework cost of a bad architectural decision exceeds the cost of this workflow. | all |
| "We can always change this later" | Can you? What's the actual switching cost? If it's low, document that. If it's high, that's a lock-in risk the devil's advocate should examine. | devils-advocate |
| "Everyone uses X, it's the safe choice" | Popularity is not evaluation. What are the tradeoffs for YOUR project, YOUR constraints, YOUR team size? | evaluator |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Decision question and drivers defined
- All candidate options researched with equal depth
- Tradeoff matrix produced with evidence citations
- Devil's advocate review completed on the preferred option
- All critical and important concerns addressed (accepted with mitigation or rebutted with evidence); minor concerns recorded in the ADR as known tradeoffs
- ADR artifact produced in MADR format
- ADR indexed in the ADR README

### Forbidden Claims

The following phrases may never appear in decision reports:

- "industry standard" (without citing which standard and why it applies)
- "best practice" (without evidence it's best for THIS context)
- "no downsides"
- "future-proof"
- "the only option"
- "everyone recommends"
- "we can always switch later" (without a documented switching cost)

### Completion Self-Check

Before marking a decision as complete, the orchestrator must verify:

1. All candidate options received research of comparable depth (not just the preferred one).
2. The tradeoff matrix covers all six driver categories (or documents why one doesn't apply).
3. The devil's advocate review ran AFTER the preferred option was selected (not before).
4. Every critical and important devil's advocate concern has a recorded response (accepted or rebutted), and minor concerns appear in the ADR as known tradeoffs.
5. The ADR follows MADR format and is indexed.
6. No forbidden claims appear in the decision report.

If check 1 fails, re-dispatch the researcher in follow-up mode on the under-researched options, then the evaluator as a re-evaluation pass; this does not count against the step-4 evidence cap. If check 2 fails, re-dispatch the evaluator naming the missing driver categories. If check 3 fails, re-run the devil's advocate against the selected option and resume at step 7. If check 4 fails, the architect records the missing responses; if a response changes the decision, resume at step 7. If check 5 or 6 fails, the orchestrator fixes the ADR document directly (format, index entry, phrasing) without new dispatches, then re-runs this self-check.

## Related Workflows

- **research-workflow**: Sub-workflow. Invoke it for deep investigation of individual options when the researcher dispatch in step 2 is not enough; its findings feed the evaluator.
- **product-spec-workflow**: Upstream. Specs that end `needs-decision` route their blocking architectural, platform, or strategic choice here.
- **task-refinement-workflow**: Upstream. Operator-required items that are significant architectural or strategic decisions route here for their own decision record.
- **dev-workflow**: Upstream and downstream. `needs-info` escalations that hinge on an architectural choice route here; the accepted ADR feeds implementation tasks back into dev-workflow.
- **debugging-workflow**: Upstream. Confirmed root causes that expose a significant choice about how to fix route here.
- **spike-workflow**: Sibling. Use a spike when an option's viability needs hands-on experimentation rather than evidence comparison; spike findings feed the researcher's report.

## Skill Dependencies

- **adr-madr-system**: ADR document formatting, indexing, and supersedes semantics. Used at step 9 and in the decision queue reconciliation's supersede checks.
- **brainstorming**: When the decision question itself is unclear or candidate options need discovery before evaluation.

These are references, not injected context. Roles load them as needed.
