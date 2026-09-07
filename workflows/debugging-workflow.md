---
id: debugging-workflow
name: Debugging / Root-Cause Workflow
triggers: [debugging, incident, root-cause-analysis, bug-investigation]
contractVersion: 2.0.0
runnerManifest: manifests/debugging-workflow.v1.yaml
resultSchema: schemas/stage-result.schema.json
manualMode: supported
runnerMode: supported
---

# Debugging / Root-Cause Workflow Contract

Structured investigation that proves root cause before any fix is attempted. Reproduce first, isolate second, confirm third, then fix under dev-workflow. Prevents the "patch the symptom, miss the real bug" cycle.

## Roles

### investigator

- Template: `subagents/investigator-prompt.md`
- Mode: diagnostic (may read files, run tests, add temporary debug output, but must NOT apply fixes)
- Constraints:
  - Must reproduce the issue before investigating (if not reproducible, document that as a finding)
  - Must narrow the fault boundary by elimination, not guessing
  - Must produce a root cause hypothesis with cited evidence (file:line, log output, test result)
  - Must NOT fix the bug. The deliverable is the diagnosis, not the patch
  - May add temporary instrumentation (logging, assertions) to trace execution, but must flag it for cleanup

### verifier

- Template: `subagents/verifier-prompt.md`
- Mode: independent confirmation (reads code and evidence, does NOT trust investigator's conclusions; may attempt independent reproduction at their discretion)
- Gate type: structured (confirmed | alternative-hypothesis | insufficient-evidence)
- Constraints:
  - Must independently trace the execution path the investigator claims is faulty
  - Must check if the root cause explains ALL reported symptoms, not just some
  - Must look for alternative explanations the investigator may have missed
  - If the root cause is confirmed, must verify the proposed fix scope is sufficient and supply an amended fix scope when it is not (fix scope gaps do not block confirmation)
  - Supports a Re-Check Pass: on a re-dispatch after a follow-up round, re-traces only the changed causal links plus its prior gaps instead of re-verifying the full diagnosis

## Diagnostic Standards

Every root cause claim must meet these evidence requirements:

| Evidence type | When required |
|---|---|
| Reproduction | Before any investigation begins. Document exact steps, inputs, and observed vs expected behavior. If not reproducible, document what was attempted. |
| Fault isolation | Narrow the boundary: which module, which function, which line. Elimination-based, not intuition-based. |
| Causal chain | Trace from trigger to symptom: input → function → state change → incorrect output. Every link must be cited. |
| Scope assessment | What else could this root cause affect? Are there other symptoms or latent bugs from the same cause? |

## Sequence

### Per-task

1. Gather the bug report:
   - Reported symptoms and context
   - Steps to reproduce (if known)
   - Relevant logs, error messages, stack traces
   - Environment details
2. Dispatch `investigator` with the bug report per its template. The template owns the duties: reproduce, isolate, trace the causal chain, assess blast radius, propose fix scope.
3. Barrier: confirm the investigator session exited and that no temporary instrumentation remains in the tree (the investigator removes their own before reporting; the orchestrator verifies by diffing the tree against its pre-investigation state). If leftover instrumentation is found, revert it (or re-dispatch `investigator` to remove only that residue) before continuing. If the report flags instrumentation as justified to retain, decide keep-or-remove now and record the decision.
4. Route on the `Reproduction` field of the investigator's report:
   - `reproduced`: continue to step 5.
   - `not reproducible` but the report contains an evidence-cited causal chain (from logs, traces, or code reading): continue to step 5; the verifier weighs the missing reproduction under its Verdict Rule.
   - `not reproducible` with no cited causal chain: do not dispatch the verifier (it could only return `insufficient-evidence`). Escalate to the operator with the documented reproduction attempts.
5. Dispatch `verifier` with the bug report + the investigator's full report per its template. On a re-dispatch after a follow-up round, dispatch it as a Re-Check Pass: include its prior verification report and mark what changed in the diagnosis.
6. If verifier returns `alternative-hypothesis`:
   - Dispatch `investigator` in follow-up mode to evaluate the alternative, then return to step 3. This consumes one follow-up round.
7. If verifier returns `insufficient-evidence`:
   - Dispatch `investigator` in follow-up mode with the specific evidence gaps to fill, then return to step 3. This consumes one follow-up round.
8. If verifier returns `confirmed`:
   - Root cause is proven. Create a fix task under dev-workflow with:
     - Proven root cause and causal chain
     - Proposed fix scope (use the verifier's amended fix scope when one is provided)
     - Regression test requirement (the fix must include a test that reproduces the bug and passes after the fix)
9. Mark investigation task `ready`

### Investigation queue reconciliation

This step never claims the board is complete.

1. If multiple bugs investigated: check for shared root causes across investigations.
2. If shared root cause found: consolidate into a single fix task, close the per-investigation fix tasks it supersedes, and carry every regression test requirement from the superseded tasks into the consolidated task.
3. Report each investigation's final state to the board workflow: tasks marked `ready` proceed under the board's own integration reconciliation; tasks escalated to the operator stay `blocked` until resolved.

### Rules

- Steps are executed in order. No step may be skipped.
- The investigator must NEVER apply a fix. Diagnosis and repair are separate concerns. Mixing them causes incomplete root cause analysis.
- Reproduction comes before investigation. If you can't reproduce it, document that. Don't skip ahead to guessing.
- Maximum follow-up rounds: 2 (manifest authority: `manifests/debugging-workflow.v1.yaml` caps). A follow-up round is one investigator re-dispatch triggered by a non-`confirmed` verdict (steps 6-7). If the root cause is still not confirmed after 2 rounds, stop dispatching, mark the task `blocked`, and escalate to the operator with all evidence and any competing hypotheses.
- The fix task created at step 8 runs under dev-workflow, not this workflow. This workflow produces the diagnosis; dev-workflow produces the fix.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "I can see the bug, let me just fix it" | Seeing the symptom is not the same as understanding the cause. Diagnose first, then fix under dev-workflow with proper review. | investigator |
| "The fix is obvious, skip verification" | Obvious fixes to the wrong root cause create new bugs. If it's truly obvious, verification takes minutes. | verifier |
| "I can't reproduce it but I know what's wrong" | A root cause you can't reproduce is a hypothesis, not a diagnosis. Document what you tried and escalate. | investigator |
| "It's probably a race condition, hard to reproduce" | "Probably" is not proven. Add instrumentation, increase logging, run under stress. If still not reproducible, document the evidence chain and limitations. | investigator |
| "The fix will be the same regardless of root cause" | If the root cause is wrong, the fix will be incomplete. Different root causes require different tests, different scopes, and different blast radius assessments. | verifier |
| "We're running low on context, just apply the fix" | An unverified fix under context pressure is how regressions happen. Escalate to orchestrator if context is genuinely exhausted. | all |
| "The stack trace tells us everything" | Stack traces show where the error manifested, not necessarily where it originated. Trace backwards from the symptom. | investigator |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Bug reproduced (or reproduction failure documented with what was attempted)
- Root cause identified with causal chain (trigger → fault → symptom)
- Verifier independently confirmed the root cause
- Blast radius assessed (what else is affected)
- Fix task created under dev-workflow with:
  - Proven root cause reference
  - Proposed fix scope
  - Regression test requirement
- All temporary instrumentation removed (or retention approved and recorded at the step 3 barrier)

### Forbidden Claims

The following phrases may never appear in debugging completion reports:

- "probably caused by"
- "likely related to"
- "should fix the issue"
- "I think the root cause is"
- "the fix worked when I tried it" (without formal verification)
- "can't reproduce but fixed anyway"
- "the stack trace points to" (as sole evidence, without causal chain)

### Completion Self-Check

Before marking a debugging investigation as complete, the orchestrator must verify:

1. The bug was reproduced (or genuine reproduction attempts are documented).
2. The root cause has a complete causal chain, not just a suspect location.
3. The verifier confirmed the root cause AFTER the investigator completed (not concurrently).
4. The blast radius assessment was performed (not just the immediate symptom).
5. The fix task references the proven root cause and requires a regression test.
6. No temporary instrumentation remains in the codebase (except retentions the orchestrator approved and recorded at the step 3 barrier).
7. No forbidden claims appear in the report.

If any check fails, return to the step that produces the missing artifact and rerun from there. Do not mark the task `ready` with a failed check.

## Related Workflows

- **dev-workflow**: Downstream. The fix task created at step 8 runs there; the proven root cause, fix scope, and regression test requirement travel in the task packet.
- **task-refinement-workflow**: Downstream alternative. When the confirmed fix scope is large or ambiguous enough to need decomposition, refine the fix task there before dev-workflow.
- **decision-workflow**: Use when the confirmed root cause exposes a significant architectural or strategic choice about how to fix it, rather than a straightforward repair.

