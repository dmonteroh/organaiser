---
id: dev-workflow
name: Development Workflow
triggers: [implementation, bugfix, refactor, feature]
---

# Development Workflow Contract

Two-stage review pipeline with strict gate ordering: spec compliance first, then code quality. Every task is independently verified before integration. The implementer is dispatched with full access. Reviewers are dispatched read-only: they read code and diffs and may run existing verification commands, but must not modify files. A reviewer that fixes code destroys the independence the gate exists to provide.

## Roles

### implementer

- Template: `subagents/implementer-prompt.md`
- Self-review: required (hygiene only; does not satisfy any gate)
- Verification: required (runs task-level verification commands itself; orchestrator does not re-run them per task)
- TDD: required for bugfix and refactor triggers; recommended for implementation and feature
- Constraints:
  - Must write the failing test first when TDD is active (follow the testing skill's iron laws if that skill is available)
  - Must commit work before reporting back
  - Must run the verification commands listed in the task packet and include the output verbatim in the report
  - Must include self-review checklist results in the report
  - If blocked or ambiguous: STOP and output QUESTIONS, do not guess
  - In-scope work: code that satisfies acceptance criteria, fixing failing tests, adding tests within the existing pattern, refactoring touched code minimally
  - Out-of-scope work (STOP + QUESTIONS): introducing a new test framework, a new external service, docker or CI environment dependencies, live-database harnesses, or any verification approach not already used in the repo

### spec-reviewer

- Template: `subagents/spec-reviewer-prompt.md`
- Trust implementer report: false
- Gate type: tri-state (pass | fail | needs-info)
- Constraints:
  - Must verify by reading code, not by trusting the implementer's report
  - Must compare actual implementation to requirements line by line
  - Must check for missing requirements AND extra/unrequested work
  - Cite file path and line number for every finding
  - If requirements mix automated coverage expectations with operator-run manual verification, or if satisfying a requirement would require new verification infrastructure beyond existing repo patterns, return `needs-info` with the exact ambiguity instead of inferring broader scope

### quality-reviewer

- Template: `subagents/code-quality-reviewer-prompt.md`
- Prerequisite: spec-reviewer.pass
- Trust implementer report: false
- Gate type: severity-graded (pass | needs-info | fail-with-severity(critical|important)). Minor findings never produce a `fail` verdict; they are listed under a `pass` and routed to the follow-ups file.
- Blocking severities: [critical, important]
- Non-blocking severities: [minor]
- Constraints:
  - Only dispatched after spec compliance passes
  - Reviews correctness, maintainability, safety, test quality, and verification gaps
  - Verification-gap check must confirm the implementer's claimed verification actually ran and the output matches the code as shipped
  - Minor findings are recorded but do not block the gate; they must be written to the follow-ups file (see Sequence)
  - Must distinguish missing automated logic coverage from missing operator-run manual verification; do not convert manual verification instructions into a demand for new automated infrastructure unless the requirement explicitly says so

## Sequence

### Per-task

1. Dispatch `implementer` with task packet (full requirements text, not file references; include the verification commands the implementer must run and the follow-ups file path).
2. If implementer returns QUESTIONS: answer clearly, then re-dispatch from step 1.
3. Verification barrier: wait for the implementer subagent to finish and exit, confirm no in-flight tool calls remain, confirm the implementer's report includes self-review checklist results and verbatim verification output. If either artifact is missing, re-dispatch `implementer` to supply only the missing artifacts (no re-implementation), then repeat this step.
4. If the implementer-reported verification failed: re-dispatch `implementer` with failure evidence and narrowed scope, return to step 3.
5. Dispatch `spec-reviewer` with requirements + changed files (and diff range when available).
6. If spec-reviewer returns `needs-info`: escalate the ambiguity to the operator and resolve it explicitly. If the resolution changes the acceptance criteria or requires code changes, restart from step 1 with the clarified packet; otherwise re-dispatch `spec-reviewer` with the clarified requirements (return to step 5). Do not re-run the implementer for a clarification that leaves the code untouched.
7. If spec-reviewer returns `fail`: re-dispatch `implementer` with spec-reviewer findings, return to step 3.
8. Dispatch `quality-reviewer` with change intent + trigger + changed files + implementer's claimed verification output.
9. If quality-reviewer returns `needs-info`: escalate the ambiguity to the operator and resolve it explicitly. If the resolution changes the acceptance criteria or requires code changes, restart from step 1 with the clarified packet; otherwise re-dispatch `quality-reviewer` with the clarified context (return to step 8).
10. If quality-reviewer returns `fail-with-severity: critical` or `fail-with-severity: important`: re-dispatch `implementer` with quality-reviewer findings, return to step 3.
11. Append any `minor` findings from either reviewer to the follow-ups file (see Follow-ups). Each entry must include source subagent, file path with line number, finding text, and suggested fix.
12. Record gate verdicts; mark task `ready`.

### Post-all-tasks

1. Orchestrator runs full project verification (all tests, linting, type checks).
2. If full project verification fails: dispatch `implementer` with the failure evidence for targeted fixes, return to Post-all-tasks step 1.
3. If multi-task execution: dispatch `quality-reviewer` with full implementation scope (all tasks combined). Reuses the per-task `quality-reviewer` template; dispatch with all changed paths and a combined `Summary of change intent` listing every task.
4. If the cross-task quality-reviewer returns `needs-info`: escalate to the operator, resolve explicitly, re-dispatch from Post-all-tasks step 3.
5. If the cross-task quality-reviewer finds issues at blocking severity: dispatch `implementer` for targeted fixes, return to Post-all-tasks step 1.
6. Reconcile any conflicts across task outputs.
7. Append any cross-task `minor` findings to the follow-ups file.
8. Run final integration verification after all fixes.
9. Mark all tasks `integrated`.

### Follow-ups

- Path: default is `<task-brief-name>-follow-ups.md` in the same directory as the task brief, unless the operator supplies a different path in the task packet.
- Content: append-only. One entry per minor finding, dated. Required fields: source subagent (`spec-reviewer` | `quality-reviewer`), file path with line number, finding text, suggested fix.
- The orchestrator must not roll minor findings into the completion report as resolved. The follow-ups file is the canonical record for operator review later.

### Rules

- Steps are executed in order. No step may be skipped.
- Re-dispatch loops that follow an implementer fix (per-task steps 4, 7, 10) resume from the verification barrier (step 3) to ensure fresh state.
- The orchestrator does not interpret "close enough": a gate either passes or it doesn't.
- Maximum loop iterations per gate: 3. If a gate fails 3 times, escalate to the operator with full context including all prior findings and fix attempts. This cap also applies to the post-all-tasks verification loop and the cross-task review gate.
- Spec compliance must pass before code quality review starts. Never reverse this order.
- A task cannot move to `ready` while any review has open blocking findings.
- The orchestrator must not resolve verification-scope ambiguity by assumption. If a requirement or review comment could reasonably mean either automated coverage or operator-run manual verification, ask the operator before widening the packet.
- Manual verification instructions/results and automated test coverage are separate proof surfaces. Reviewers may require both when the task says so, but they may not silently translate manual verification into a requirement for new automated infrastructure.
- Self-review is required hygiene, not a substitute for any gate. It surfaces obvious issues before external review.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "This is a trivial change, skip review" | Trivial changes have the highest skip rate and highest regression rate. Size does not predict risk. No exceptions. | all reviews |
| "The implementer already self-reviewed" | Self-review is hygiene, not a gate. Independent verification by a fresh context is structural: it catches what familiarity blinds you to. | spec-reviewer |
| "Spec reviewer passed, quality review is overkill" | Spec compliance confirms WHAT was built. Quality review confirms it was built WELL. These are orthogonal axes: passing one says nothing about the other. | quality-reviewer |
| "We're running low on context/tokens" | Token pressure does not override quality gates. If context is genuinely exhausted, escalate to the operator with full findings. Do not silently skip. | all reviews |
| "I already know this code is correct" | Training data is not verification. Confidence is not evidence. Read the code. | all reviews |
| "Tests pass, so it must be correct" | Passing tests prove the tested paths work. They say nothing about untested paths, missing requirements, or code quality. Tests are necessary but not sufficient. | quality-reviewer |
| "It's just a config/docs change" | Config changes can break deployments. Doc changes can mislead users. Review effort scales with risk, but the gate still applies. | all reviews |
| "The reviewer is wrong, I'll skip the fix" | If you believe the reviewer is wrong, provide a reasoned counter-argument and re-run the gate. Do not silently dismiss findings. | all reviews |
| "We already reviewed a similar change before" | Prior reviews cover prior code. New code requires new review. Context from previous reviews does not transfer. | all reviews |
| "Minor finding, I'll just fix it later" | Minor findings must be written to the follow-ups file for operator review. They may not be silently discarded or rolled up as "no issues". | quality-reviewer |

**Enforcement rule:** Before skipping any gate defined in the sequence, the orchestrator must check this table. If any rule matches the current justification, the gate cannot be skipped. If no rule matches but the orchestrator still wants to skip, it must escalate to the operator with an explicit justification. The default is always "run the gate."

## Completion

### Required

- All tasks marked `integrated`
- All per-task gate sequences completed with `pass` verdicts for every gate
- Post-all-tasks sequence completed (including cross-task review for multi-task executions)
- Final verification commands executed with fresh output AFTER the last change
- All verification output captured and included in the final report
- All minor findings written to the follow-ups file with required fields

### Forbidden Claims

The following phrases may never appear in completion reports:

- "should pass"
- "probably works"
- "seems correct"
- "likely fine"
- "tests were passing earlier"
- "worked when I tested it"
- "no issues expected"
- "looks good to me" (without structural evidence)
- "minor issue, can fix later" (for critical/important severity, and never as a substitute for writing the finding to the follow-ups file)
- "no further follow-ups" when minor findings exist but were not written to the follow-ups file

### Completion Self-Check

Before reporting completion, the orchestrator must verify:

1. Every task has a recorded `pass` verdict for each gate in the sequence (spec-reviewer, quality-reviewer).
2. Final integration verification was run AFTER the last change (not before, not cached).
3. No task has an unresolved `needs-info` escalation or open blocking findings.
4. All verification output is from the current state of the code, not from a prior iteration.
5. All minor findings from per-task and cross-task reviews have been written to the follow-ups file.
6. No forbidden claims appear in the completion report.

## Related Workflows

- **task-refinement-workflow**: Upstream. Implementation-ready briefs and task packets arrive from there; the follow-ups file convention travels with the packet.
- **spike-workflow**: Upstream. Adopt/adapt spike outcomes are refined through task-refinement before arriving here; spike code is reference only, never promoted directly.
- **debugging-workflow**: Upstream for unexplained bugs. When a bugfix task's root cause is unknown, prove it there first; the confirmed diagnosis becomes this workflow's task packet evidence.
- **decision-workflow**: Use when a `needs-info` escalation turns out to hinge on a significant architectural or strategic decision rather than a scope clarification.
