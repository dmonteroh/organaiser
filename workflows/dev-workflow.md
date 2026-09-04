---
id: dev-workflow
name: Development Workflow
triggers: [implementation, bugfix, refactor, feature]
contractVersion: 2.0.0
runnerManifest: manifests/development.v1.yaml
resultSchema: schemas/stage-result.schema.json
manualMode: supported
runnerMode: supported
---

# Development Workflow Contract

Two-stage review pipeline with strict gate ordering: spec compliance first, then code quality. Every task is independently verified before integration. The implementer is dispatched with full access. Reviewers are dispatched read-only: they read code and diffs and may run existing verification commands, but must not modify files. A reviewer that fixes code destroys the independence the gate exists to provide.

## Roles

### implementer

- Template: `subagents/implementer-prompt.md`
- Self-review: required (hygiene only; does not satisfy any gate)
- Verification: required. The implementer runs task-level verification and records output. In runner mode the runner reruns the declared checks after the worker exits and its result is the gate. In manual mode the orchestrator may rerun them when in doubt.
- TDD: required for bugfix and refactor triggers; recommended for implementation and feature
- Constraints:
  - Must write the failing test first when TDD is active (follow the testing skill's iron laws if that skill is available)
  - Must commit work on the assigned task branch before reporting back
  - Must run the verification commands listed in the worker packet, write the full raw output to the verification log file, and quote failures plus the final summary lines verbatim in the report
  - Must rebuild any failed file edit from a fresh read of the target file; edits are never reconstructed from memory of an earlier read
  - Must include self-review checklist results in the report
  - If blocked or ambiguous: STOP and output QUESTIONS, do not guess
  - In-scope work: code that satisfies acceptance criteria, fixing failing tests, adding tests within the existing pattern, refactoring touched code minimally
  - Out-of-scope work (STOP + QUESTIONS): introducing a new test framework, a new external service, docker or CI environment dependencies, live-database harnesses, or any verification approach not already used in the repo

### spec-reviewer

- Template: `subagents/spec-reviewer-prompt.md`
- Session: fresh process at the reviewed commit, no write authority over the reviewed tree
- Trust implementer report: false
- Gate type: tri-state (pass | fail | needs-info)
- Constraints:
  - Must verify by reading code, not by trusting the implementer's report
  - Must compare actual implementation to requirements line by line
  - Must check for missing requirements AND extra/unrequested work
  - Cite file path and line number for every finding
  - If requirements mix automated coverage expectations with operator-run manual verification, or if satisfying a requirement would require new verification infrastructure beyond existing repo patterns, return `needs-info` with the exact ambiguity instead of inferring broader scope

### code-quality-reviewer

- Template: `subagents/code-quality-reviewer-prompt.md`
- Session: fresh process at the reviewed commit, no write authority over the reviewed tree
- Prerequisite: spec-reviewer.pass
- Trust implementer report: false
- Gate type: severity-graded (pass | needs-info | fail-with-severity: <critical | important>). Minor findings never produce a `fail` verdict; they are listed under a `pass` and routed to the follow-ups file.
- Blocking severities: [critical, important]
- Non-blocking severities: [minor]
- Constraints:
  - Only dispatched after spec compliance passes
  - Reviews correctness, maintainability, safety, test quality, and verification gaps
  - Verification-gap check must confirm the implementer's claimed verification actually ran (reading the verification log against the report summary, re-running commands when in doubt) and the output matches the code as shipped
  - Minor findings are recorded but do not block the gate; they must be written to the follow-ups file (see Sequence)
  - Must distinguish missing automated logic coverage from missing operator-run manual verification; do not convert manual verification instructions into a demand for new automated infrastructure unless the requirement explicitly says so

## Sequence

### Per-task

1. Dispatch `implementer` with the worker packet. Inline verbatim the parts that must never be lossy: acceptance criteria, hard constraints, and the verification commands the implementer must run. Pass the task brief by path as the canonical source for everything else (a path can be re-read after context loss; inlined prose cannot). Include the follow-ups file path and the verification log path.
2. If implementer returns QUESTIONS: answer clearly, then re-dispatch from step 1.
3. Verification barrier: wait for the implementer subagent to finish and exit, confirm no in-flight tool calls remain, confirm the implementer's report includes self-review checklist results and the verification summary (failures plus final summary lines), and confirm the full output was written to the verification log. If any artifact is missing, re-dispatch `implementer` to supply only the missing artifacts (no re-implementation), then repeat this step. In runner mode the barrier is runner-owned: it confirms process exit, no live descendants, artifact presence, and reruns declared checks.
4. If the implementer-reported verification failed: re-dispatch `implementer` with failure evidence and narrowed scope, return to step 3.
5. Dispatch `spec-reviewer` with requirements + changed files (and diff range when available).
6. If spec-reviewer returns `needs-info`: do not pause the run to ask. Check the ambiguity against the operator question bar; for an item that meets the bar, record it in the open-questions file with context, options, impact, and a stated default when one exists, then continue. With a safe default: apply it. If the resolution changes the acceptance criteria or requires code changes, restart from step 1 with the clarified worker packet; otherwise re-dispatch `spec-reviewer` with the clarified requirements (return to step 5). Do not re-run the implementer for a clarification that leaves the code untouched. Without a safe default: park the task and continue with other tasks.
7. If spec-reviewer returns `fail`: re-dispatch `implementer` with spec-reviewer findings, return to step 3.
8. Dispatch `code-quality-reviewer` with change intent + trigger + changed files + implementer's verification summary + the verification log path.
9. If code-quality-reviewer returns `needs-info`: do not pause the run to ask. Check the ambiguity against the operator question bar; for an item that meets the bar, record it in the open-questions file with context, options, impact, and a stated default when one exists, then continue. With a safe default: apply it. If the resolution changes the acceptance criteria or requires code changes, restart from step 1 with the clarified worker packet; otherwise re-dispatch `code-quality-reviewer` with the clarified context (return to step 8). Without a safe default: park the task and continue with other tasks.
10. If code-quality-reviewer returns `fail-with-severity: critical` or `fail-with-severity: important`: re-dispatch `implementer` with code-quality-reviewer findings, return to step 3.
11. Append any `minor` findings from either reviewer to the follow-ups file (see Follow-ups). Each entry must include source subagent, file path with line number, finding text, and suggested fix. In runner mode the runner appends once per task and attempt; reviewers never append.
12. Record gate verdicts; mark task `ready-to-integrate`.

### Integration-batch barrier

Runs for one ready integration batch: full affected verification and cross-task review, then advances the batch's destination. In manual mode the orchestrator runs this barrier directly.

1. Orchestrator runs full verification for the batch (all tests, linting, type checks affected by the batch).
2. If verification fails: dispatch `implementer` with the failure evidence for targeted fixes, return to Integration-batch barrier step 1.
3. If multi-task execution, or if any `implementer` fix was dispatched during this barrier: dispatch `code-quality-reviewer` with full batch scope (all tasks in the batch combined, plus any barrier fixes). Reuses the per-task `code-quality-reviewer` template; dispatch with all changed paths and a combined `Summary of change intent` listing every task and fix. No implementer change may reach `ready-to-integrate` without passing quality review, regardless of task count.
4. If the cross-task code-quality-reviewer returns `needs-info`: escalate to the operator, resolve explicitly, re-dispatch from Integration-batch barrier step 3.
5. If the cross-task code-quality-reviewer finds issues at blocking severity: dispatch `implementer` for targeted fixes, return to Integration-batch barrier step 1.
6. Reconcile any conflicts across the batch's task outputs.
7. Append any cross-task `minor` findings to the follow-ups file.
8. Run final affected verification after all fixes.
9. Advance the batch's destination; mark its tasks `integrated`.

### Board-close barrier

Runs only when no task can progress automatically. It is the only step that contributes to board success. In manual mode the orchestrator runs this barrier directly.

1. Confirm every dispatchable task has reached a terminal disposition or is legitimately parked or waiting-operator; if a task can still progress, return to the Integration-batch barrier for it instead.
2. Run final full project verification (all tests, linting, type checks) with fresh output after the last change.
3. Validate every task holds an acceptable terminal disposition (`integrated`, `superseded`, `shelved`, or explicitly cancelled), and no task is `parked` or `waiting-operator` without a recorded question.
4. Validate task worktrees, open questions, and runner state are clean and reconciled.
5. Mark the board closed.

### Follow-ups

- Path: default is `<task-brief-name>-follow-ups.md` in the same directory as the task brief, unless the operator supplies a different path in the worker packet.
- Content: append-only. One entry per minor finding, dated. Required fields: source subagent (`spec-reviewer` | `code-quality-reviewer`), file path with line number, finding text, suggested fix.
- The orchestrator must not roll minor findings into the completion report as resolved. The follow-ups file is the canonical record for operator review later.

### Verification log

- Path: default is `<task-brief-name>-verification.log` in the same directory as the task brief, unless the operator supplies a different path in the worker packet.
- Content: append-only. The implementer writes the full raw output of every verification command there, under a dated header per dispatch. The report quotes only failures and the final summary lines verbatim; the log holds the rest.
- Purpose: keeps bulky command output out of subagent transcripts (where it accelerates context compaction) while preserving the raw evidence for the code-quality-reviewer's verification-gap check.

### Rules

- Steps are executed in order. No step may be skipped.
- Every re-dispatch is a fresh subagent context carrying the full original worker packet plus the new findings or failure evidence, never a continuation of a prior subagent conversation. A fresh context re-reads current file state instead of trusting stale memory of it.
- The orchestrator does not interpret "close enough": a gate either passes or it doesn't.
- Maximum loop iterations per gate: 3 (manifest authority: `development.v1.yaml` caps). At the cap, park the task with all prior findings and fix attempts, and continue unrelated tasks. This cap also applies to the Integration-batch barrier's verification loop and the cross-task review gate. The QUESTIONS loop (per-task step 2) and the missing-artifacts barrier loop (per-task step 3) carry the same cap: after 3 rounds each, park the task instead of re-dispatching.
- Spec compliance must pass before code quality review starts. Never reverse this order.
- A task cannot move to `ready-to-integrate` while any review has open blocking findings.
- The orchestrator must not resolve verification-scope ambiguity by assumption. If a requirement or review comment could reasonably mean either automated coverage or operator-run manual verification, ask the operator before widening the packet.
- Reviewers never repair their own findings. A repair receives only accepted blocking findings.
- An artifact repair dispatch is report-only and may not change product code.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "This is a trivial change, skip review" | Trivial changes have the highest skip rate and highest regression rate. Size does not predict risk. No exceptions. | all reviews |
| "The implementer already self-reviewed" | Self-review is hygiene, not a gate. Independent verification by a fresh context is structural: it catches what familiarity blinds you to. | spec-reviewer |
| "Spec reviewer passed, quality review is overkill" | Spec compliance confirms WHAT was built. Quality review confirms it was built WELL. These are orthogonal axes: passing one says nothing about the other. | code-quality-reviewer |
| "We're running low on context/tokens" | Token pressure does not override quality gates. If context is genuinely exhausted, escalate to the operator with full findings. Do not silently skip. | all reviews |
| "I already know this code is correct" | Training data is not verification. Confidence is not evidence. Read the code. | all reviews |
| "Tests pass, so it must be correct" | Passing tests prove the tested paths work. They say nothing about untested paths, missing requirements, or code quality. Tests are necessary but not sufficient. | code-quality-reviewer |
| "It's just a config/docs change" | Config changes can break deployments. Doc changes can mislead users. Review effort scales with risk, but the gate still applies. | all reviews |
| "The reviewer is wrong, I'll skip the fix" | If you believe the reviewer is wrong, provide a reasoned counter-argument and re-run the gate. Do not silently dismiss findings. | all reviews |
| "We already reviewed a similar change before" | Prior reviews cover prior code. New code requires new review. Context from previous reviews does not transfer. | all reviews |
| "Minor finding, I'll just fix it later" | Minor findings must be written to the follow-ups file for operator review. They may not be silently discarded or rolled up as "no issues". | code-quality-reviewer |
| "The runner will catch it" | The runner reruns checks and validates reports. It does not read your code for you. Reviews still run. | all reviews |

**Enforcement rule:** Before skipping any gate defined in the sequence, the orchestrator must check this table. If any rule matches the current justification, the gate cannot be skipped. If no rule matches but the orchestrator still wants to skip, it must escalate to the operator with an explicit justification. The default is always "run the gate."

## Completion

### Required

- Every task holds an acceptable terminal disposition (`integrated`, `superseded`, `shelved`, or explicitly cancelled), and no task is `parked` or `waiting-operator`
- All per-task gate sequences completed with `pass` verdicts for every gate
- Integration-batch barrier completed for every batch (including cross-task review whenever it is required), and the Board-close barrier completed
- Final verification commands executed with fresh output AFTER the last change
- All verification output captured: failures and final summary lines in the final report, full raw output in the verification log
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

1. Every task has a recorded `pass` verdict for each gate in the sequence (spec-reviewer, code-quality-reviewer).
2. Final integration verification was run AFTER the last change (not before, not cached).
3. No task has an unresolved `needs-info` escalation or open blocking findings.
4. All verification output is from the current state of the code, not from a prior iteration.
5. All minor findings from per-task and cross-task reviews have been written to the follow-ups file.
6. No forbidden claims appear in the completion report.

## Related Workflows

- **task-refinement-workflow**: Upstream. Implementation-ready briefs and worker packets arrive from there; the follow-ups file convention travels with the packet. This workflow assumes briefs that respect task-refinement's sizing budget; an oversized brief is a reason to send the task back for splitting, not to dispatch it.
- **spike-workflow**: Upstream. Adopt/adapt spike outcomes are refined through task-refinement before arriving here; spike code is reference only, never promoted directly.
- **debugging-workflow**: Upstream for unexplained bugs. When a bugfix task's root cause is unknown, prove it there first; the confirmed diagnosis becomes this workflow's worker packet evidence.
- **decision-workflow**: Use when a `needs-info` escalation turns out to hinge on a significant architectural or strategic decision rather than a scope clarification.
- **task-board-workflow**: Upstream composition contract. It sequences and dispatches the tasks this workflow executes and owns board-wide state across tasks.
