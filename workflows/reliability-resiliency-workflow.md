---
id: reliability-resiliency-workflow
name: Reliability / Resiliency Analysis Workflow
triggers: [reliability-analysis, resiliency-analysis, resilience-review, failure-mode-analysis, operational-readiness]
contractVersion: 1.0.0
manualMode: supported
runnerMode: unsupported
---

# Reliability / Resiliency Analysis Workflow Contract

Structured, subagent-driven assessment of whether a system can survive faults, degrade safely, recover predictably, and be operated with confidence. The workflow produces an evidence-backed reliability artifact: failure-mode inventory, control assessment, prioritized risks, and a remediation backlog recommendation. It does not implement fixes.

This workflow answers:

- Where can the system fail?
- What currently prevents, detects, contains, or recovers from those failures?
- Which reliability gaps are real versus assumed?
- What should be fixed first to meaningfully improve resiliency?

## Roles

### reliability-investigator

- Template: `subagents/reliability-investigator-prompt.md`
- Mode: read-only investigation (may read code, configs, docs, tests, and run non-destructive verification commands)
- Constraints:
  - Must map critical user journeys and supporting system boundaries before judging controls
  - Must cite evidence for every factual claim
  - Must distinguish verified controls from inferred or assumed controls
  - Must inspect failure-handling paths, not only happy-path logic
  - Must not propose implementation details beyond remediation direction
  - Supports a Follow-Up Pass: investigates only named evidence gaps and returns a delta report

### failure-mapper

- Template: `subagents/failure-mapper-prompt.md`
- Mode: analytical synthesis (read-only)
- Constraints:
  - Must convert gathered evidence into explicit failure modes, not vague "reliability concerns"
  - Must rate each failure mode across prevention, detection, containment, recovery, and operator clarity
  - Must identify single points of failure, correlated-failure risks, and silent-failure risks explicitly
  - Must separate current-state evidence from recommended future controls
  - Must produce a system-wide matrix, not an unstructured narrative
  - Supports a Revision Pass: re-maps only named failure modes against the prior matrix and returns a delta

### resiliency-challenger

- Template: `subagents/resiliency-challenger-prompt.md`
- Mode: adversarial review of the current assessment (read-only; may read cited files to verify evidence)
- Gate type: structured (`assessment-holds` | `gaps-found` | `needs-info`)
- Constraints:
  - Must challenge optimistic control ratings and unsupported assumptions
  - Must test whether the identified controls actually help during realistic failure scenarios
  - Must look for missing operational concerns: observability, recovery runbooks, deployment safety, dependency failure behavior, and partial outage handling
  - Must identify unmodeled cross-boundary failures and shared dependencies
  - Must not accept "there is code for this" as proof that the system is resilient
  - Supports a Re-Check Pass: verifies only new or changed matrix rows plus previously flagged items

## Reliability Dimensions

Every failure mode is assessed across these dimensions:

| Dimension | What it measures |
|---|---|
| Prevention | Does the system reduce the chance of the fault occurring? |
| Detection | Will the system or operator notice the fault quickly and correctly? |
| Containment | Does the fault stay local, or does it cascade across journeys/services? |
| Recovery | Can the system recover automatically or through a clear operator action? |
| Operator clarity | Are logs, metrics, alerts, health signals, and runbooks sufficient to act confidently? |
| User impact | How badly does the fault affect core user journeys when it occurs? |

Each dimension must be rated as one of:

| Rating | Meaning |
|---|---|
| `strong` | Evidence shows the control is intentionally present and likely effective |
| `partial` | Some control exists, but it is incomplete, weak, or unevenly applied |
| `weak` | Minimal or fragile control exists; realistic failures would likely escape or spread |
| `unknown` | The assessor could not verify the state from available evidence |

## Failure Categories

The investigator and mapper must consider, at minimum, these categories:

- Dependency failures: database, queue, filesystem, auth provider, external API, network, DNS, certificates
- Resource failures: memory pressure, disk exhaustion, connection-pool saturation, thread starvation, rate limits
- Consistency failures: partial writes, duplicate processing, stale caches, ordering issues, retry safety, idempotency gaps
- Deployment and configuration failures: bad config, startup miswiring, migration drift, incompatible versions, feature-flag mistakes
- Runtime behavior failures: timeouts, unbounded retries, blocking calls, dead-letter absence, background worker stalls
- Observability and operations failures: missing health checks, silent errors, weak logs, no alert path, unclear recovery procedure
- UX degradation failures: partial availability, offline/slow behavior, backpressure messaging, safe fallback behavior

If a category truly does not apply, the report must state why.

## Evidence Standards

Every claim in the final report must be tagged as one of:

| Level | Meaning | Required for |
|---|---|---|
| `verified` | Confirmed from source code, configuration, tests, docs, or command output | Factual statements about current behavior and existing controls |
| `corroborated` | Supported by multiple independent repo sources | High-confidence risk statements and control-strength claims |
| `inferred` | Reasonable conclusion from verified evidence, but not directly stated in one place | Cascading-risk analysis, operator burden analysis |
| `unverified` | Plausible but not confirmed from available evidence | Open questions, suspected controls, missing runtime information |

The investigator assigns these levels when reporting evidence, the mapper carries them into the matrix Evidence column, and the final report preserves them. The final report must never present an `inferred` or `unverified` item as established fact.

## Sequence

### Per-task

1. Define the assessment scope:
   - System or subsystem boundaries
   - Critical user journeys and business-critical background flows
   - Reliability expectations or operating assumptions, if known; when expectations are unknown, record the assumptions used in their place
   - Explicit exclusions
2. Dispatch `reliability-investigator` per its template with the scope. If the investigator reports missing inputs, fix the scope definition or supply the missing context and re-dispatch; do not let it guess.
3. Orchestrator reviews the investigator output for coverage: are the critical journeys complete, are major dependencies and background flows represented, and are there obvious blind spots before synthesis begins? For gaps, re-dispatch the investigator in a Follow-Up Pass naming the journeys, dependencies, or evidence gaps to close, and merge the returned delta.
4. Dispatch `failure-mapper` per its template with the scope and investigator output. On a repeat pass, dispatch as a Revision Pass naming the failure modes to re-map and supplying the prior matrix plus any new evidence; merge the returned delta into the matrix.
5. Dispatch `resiliency-challenger` per its template with the scope, investigator output, and failure matrix. On a repeat pass, dispatch as a Re-Check Pass, adding the challenger's own prior report and the revised matrix with changed rows marked.
6. If the challenger returns `needs-info`, resolve each Missing For Review item by owner:
   - `orchestrator-context`: supply the missing report sections, matrix rows, or cited files and re-dispatch the challenger only.
   - `operator`: escalate. If the answer changes the assessment scope, update it and resume at the affected step (2 for evidence, 4 for the matrix).
7. If the challenger returns `gaps-found`, resolve each finding by type:
   - Overstated ratings the orchestrator accepts: downgrade the contested dimension directly in the matrix, carrying the challenger's reasoning as the evidence note. Downgrades add no new analysis, so they need no mapper dispatch and no re-check.
   - Challenges the orchestrator rejects: record the rejection rationale; it goes into the final report for operator visibility.
   - Analytical gaps (missing failure modes, missing operational concerns, or scenario challenges answerable from existing evidence): re-dispatch the mapper in a Revision Pass on the named modes only, then return to step 5 as a Re-Check Pass.
   - Evidence gaps (a rating or scenario cannot be judged from current evidence): re-dispatch the investigator in a Follow-Up Pass on the named gaps, then the mapper in a Revision Pass on the affected modes, then return to step 5 as a Re-Check Pass.
8. If operator input is needed (scope boundaries, reliability expectations, acceptance of residual risk): escalate with the current matrix and the specific question. Record the answer and resume at the step that raised the escalation.
9. When the challenger returns `assessment-holds`, or every remaining finding was resolved by downgrade or recorded rejection, or the revision cap was reached, produce the final reliability report with:
   - System scope and critical journeys
   - Coverage map of what was inspected and what was not
   - Failure-mode matrix with ratings and citations
   - Prioritized risk list with root weakness, blast radius, and remediation direction
   - Explicit unknowns and assumptions, including rejected challenges with their rationale
10. Mark task `ready`

### Post-all-tasks

1. If multiple systems or subsystems were assessed, compare shared dependencies and repeated failure patterns
2. If two assessments disagree about the same shared dependency or control, document both ratings with their evidence and record the disagreement as a cross-cutting unknown; do not silently average or overwrite either assessment
3. Consolidate recurring issues into cross-cutting remediation themes
4. Mark all `ready` tasks `integrated`

### Rules

- Steps are executed in order. No step may be skipped.
- The workflow is assessment-only. It must not produce production code changes.
- Maximum revision rounds: 2. A round is one pass through step 7 that ends in a challenger Re-Check Pass. Orchestrator downgrades, recorded rejections, needs-info resolutions, and pre-synthesis corrections do not count against the cap. At cap exhaustion, set each still-contested dimension rating to `unknown`, list the disagreement under explicit unknowns rather than pretending confidence, and run no further challenger pass.
- The assessment must begin with critical journeys and dependency boundaries, not with isolated files or services. Reliability is cross-boundary by default.
- "No issue found" is valid only when the assessor looked for specific failure classes and found evidence-backed controls.

## Priority Model

Every final finding must include a priority based on both user impact and control weakness:

| Priority | When to use it |
|---|---|
| `critical` | A realistic fault can break a critical journey, corrupt state, or create prolonged outage with weak detection/recovery |
| `high` | A realistic fault causes major degradation or high operator burden, but some mitigation exists |
| `medium` | The weakness is meaningful but bounded; impact or likelihood is limited |
| `low` | Improvement opportunity with limited immediate risk |

Priority must not be assigned from intuition alone. The report must name the affected journey, likely trigger, and missing or weak control.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The happy path is well tested, so reliability is probably fine" | Reliability is about faults, partial failures, and operator recovery. Happy-path coverage is only one signal. | reliability-investigator |
| "There is retry logic, so dependency failure is handled" | Retries can amplify outages if timeout bounds, idempotency, and backoff are weak or absent. Check the full control chain. | failure-mapper |
| "We have logs, so operators will know what happened" | Logs without signal quality, correlation, alerting, and actionability do not provide operator clarity. | resiliency-challenger |
| "This dependency is usually stable" | Reliability analysis covers bad days, not average days. Evaluate the failure mode anyway. | all |
| "There is only one service here, cascades don't apply" | Single-process systems still have cascades across storage, workers, background tasks, and user journeys. | failure-mapper |
| "We don't need to inspect deployment or configuration paths" | Many outages are introduced during startup, rollout, or misconfiguration, not steady-state code paths. | reliability-investigator |
| "Unknowns are fine, we can assume best case" | Unknown control quality is itself a risk. Preserve uncertainty explicitly. | all |
| "No incidents have happened, so the system is resilient" | Lack of observed incidents may mean lack of traffic, luck, or poor detection. Evaluate controls, not just history. | resiliency-challenger |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Assessment scope and critical journeys defined
- Relevant dependencies and background flows identified
- Investigator coverage map completed
- Failure-mode matrix produced with ratings across all reliability dimensions
- Resiliency challenger outcome resolved per per-task step 9, with contested ratings preserved as `unknown` when the revision cap was reached
- Final report distinguishes verified facts from inferred and unverified items
- Prioritized findings satisfy the Priority Model and include remediation direction
- Explicit unknowns and exclusions documented

### Forbidden Claims

The following phrases may never appear in reliability completion reports:

- "seems reliable"
- "probably resilient"
- "should recover fine"
- "covered by existing logging"
- "unlikely to fail"
- "good enough operationally"
- "best practice is already in place" (without evidence)
- "no single points of failure" (without explicit dependency analysis)

### Completion Self-Check

Before marking a reliability assessment as complete, the orchestrator must verify:

1. Critical user journeys were defined before subsystem scoring began.
2. The investigator inspected failure-handling paths, not only happy-path code.
3. Every major dependency category was considered or explicitly ruled out.
4. The failure matrix reflects the final investigator evidence, not an earlier draft.
5. The challenger reviewed the final matrix and its challenges were resolved by downgrade, recorded rejection, or preservation as explicit unknowns.
6. Every priority finding identifies the affected journey, likely trigger, and weak or missing control.
7. No forbidden claims appear in the report.

If check 1 fails, fix the scope definition, then re-dispatch the investigator in a Follow-Up Pass on the journeys the scoring missed. If check 2 or 3 fails, re-dispatch the investigator in a Follow-Up Pass on the uninspected failure paths or unruled dependency categories. If check 4 fails, re-dispatch the mapper in a Revision Pass on the stale rows, then the challenger as a Re-Check Pass. If check 5 fails, dispatch the challenger as a Re-Check Pass scoped to what it has not seen. If check 6 or 7 fails, the orchestrator fixes the report directly (finding fields, phrasing) without new dispatches. After any fix, re-run this self-check.

## Output Contract

Always return:

- Scope summary: systems, journeys, exclusions
- Coverage map: what was inspected and what was not
- Failure-mode matrix with citations and ratings
- Priority findings list
- Cross-cutting themes
- Unknowns and evidence gaps
- Remediation directions grouped by prevention, detection, containment, recovery, and operator clarity

## Related Workflows

- **product-spec-workflow**: Downstream. Remediation directions that call for new work route here for specification.
- **spike-workflow**: Downstream. Unknowns that need hands-on or runtime verification route here as time-boxed experiments.
- **debugging-workflow**: Downstream. Concrete defects surfaced during investigation route here for root-cause work.
- **gap-analysis-workflow**: Sibling. Gap-analysis checks whether the plan is complete; this workflow checks whether the system survives faults. Run both for operational readiness.
