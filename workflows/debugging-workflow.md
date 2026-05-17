---
id: debugging-workflow
name: Debugging / Root-Cause Workflow
triggers: [debugging, incident, root-cause-analysis, bug-investigation]
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
  - If the root cause is confirmed, must verify the proposed fix scope is sufficient

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
2. Dispatch `investigator` for reproduction + diagnosis:
   - Reproduce the issue first (or document reproduction failure)
   - Narrow the fault boundary through elimination
   - Trace the causal chain from trigger to symptom
   - Produce root cause hypothesis with evidence
   - Assess blast radius (what else is affected)
   - Propose fix scope (which files need to change)
3. Barrier: confirm the investigator session exited and that no temporary instrumentation remains in the tree (the investigator removes their own before reporting; the orchestrator verifies)
4. Dispatch `verifier` with the bug report + investigator's diagnosis:
   - Independently trace the claimed faulty path
   - Check if root cause explains all symptoms
   - Look for alternative explanations
   - Assess if proposed fix scope is sufficient
5. If verifier returns `alternative-hypothesis`:
   - Dispatch `investigator` to evaluate the alternative, then return to step 3
6. If verifier returns `insufficient-evidence`:
   - Dispatch `investigator` with specific evidence gaps to fill, then return to step 3
7. If verifier returns `confirmed`:
   - Root cause is proven. Create a fix task under dev-workflow with:
     - Proven root cause and causal chain
     - Proposed fix scope
     - Regression test requirement (the fix must include a test that reproduces the bug and passes after the fix)
8. Mark investigation task `ready`

### Post-all-tasks

1. If multiple bugs investigated: check for shared root causes across investigations
2. If shared root cause found: consolidate into a single fix task
3. Mark all tasks `integrated`

### Rules

- Steps are executed in order. No step may be skipped.
- The investigator must NEVER apply a fix. Diagnosis and repair are separate concerns. Mixing them causes incomplete root cause analysis.
- Reproduction comes before investigation. If you can't reproduce it, document that. Don't skip ahead to guessing.
- Maximum follow-up rounds: 2. If the root cause cannot be confirmed after 2 rounds, escalate to the operator with all evidence and any competing hypotheses.
- The fix task created at step 7 runs under dev-workflow, not this workflow. This workflow produces the diagnosis; dev-workflow produces the fix.
- Temporary instrumentation (debug logging, assertions) must be removed before the investigation is complete.

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
- All temporary instrumentation removed

### Forbidden Claims

The following phrases may never appear in debugging completion reports:

- "probably caused by"
- "likely related to"
- "should fix the issue"
- "I think the root cause is"
- "the fix worked when I tried it" (without formal verification)
- "can't reproduce but fixed anyway"
- "the stack trace points to"  (as sole evidence, without causal chain)

### Completion Self-Check

Before marking a debugging investigation as complete, the orchestrator must verify:

1. The bug was reproduced (or genuine reproduction attempts are documented).
2. The root cause has a complete causal chain, not just a suspect location.
3. The verifier confirmed the root cause AFTER the investigator completed (not concurrently).
4. The blast radius assessment was performed (not just the immediate symptom).
5. The fix task references the proven root cause and requires a regression test.
6. No temporary instrumentation remains in the codebase.
7. No forbidden claims appear in the report.

