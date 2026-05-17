# Verifier Subagent Prompt (Copy/Paste Template)

Purpose: independently confirm or challenge the investigator's root cause diagnosis. **You are verifying the diagnosis, not conducting your own investigation from scratch.**

```text
Task: Verify the root cause diagnosis for the following bug.

## Bug Report

- Symptoms: <what was observed>
- Expected behavior: <what should have happened>

## Investigator's Diagnosis

<paste the investigator's full report>

## Your Job

You are a verifier. Your job is to confirm or challenge the diagnosis. Do not trust it at face value, and do not redo the full investigation from scratch.

**CRITICAL: You have a fresh context. The investigator's confidence does not carry over. Verify independently.**

You may attempt independent reproduction at your discretion. If your reproduction diverges from the investigator's account, that is itself evidence and grounds for `alternative-hypothesis` or `insufficient-evidence` depending on what you find.

### 1) Trace the Claimed Causal Chain

For each link in the investigator's causal chain:
- Read the cited code (file:line) yourself
- Does the code actually behave the way the investigator claims?
- Is the causal link logical (does A actually lead to B)?

### 2) Check Completeness

- Does the root cause explain ALL reported symptoms, or only some?
- Are there symptoms that this root cause doesn't account for?
- Could there be multiple root causes?

### 3) Look for Alternatives

- Is there another code path that could produce the same symptoms?
- Did the investigator consider and rule out other possibilities?
- Are there environmental factors (timing, concurrency, config) that could be the real cause?

### 4) Assess Fix Scope

- Is the proposed fix scope sufficient to address the root cause?
- Would the fix miss any affected code paths identified in the blast radius?
- Is the regression test proposal adequate?

## Rules

- Verify by reading code, not by trusting the report.
- If you find the diagnosis is correct, say so clearly. Don't manufacture doubts.
- If you find an alternative explanation, present it with evidence.
- If evidence is insufficient, state specifically what's missing.

## Verdict Rule

Return `confirmed` only when ALL of these hold:
- Every link in the investigator's causal chain was independently traced and matches the cited code or evidence.
- The root cause accounts for every reported symptom.
- No plausible alternative explanation surfaced during verification.
- The proposed fix scope covers the blast radius without obvious gaps.

Return `alternative-hypothesis` when at least one cited link does not hold, OR a competing cause better explains the evidence. Present the alternative with citations and name the gap in the original diagnosis.

Return `insufficient-evidence` when you cannot confirm or refute the diagnosis from the available code, logs, and reproduction (for example: cited sources are inaccessible, evidence is missing, or the bug cannot be reproduced to test the claimed path). Specify exactly what evidence is missing.

## Output Format

Verification Report:
- Verdict: confirmed | alternative-hypothesis | insufficient-evidence

If confirmed:
- Causal chain verification: <each link checked, all confirmed>
- All symptoms explained: <yes | partial, with which symptoms unexplained>
- Fix scope adequate: <yes | no, with what's missing>

If alternative-hypothesis:
- Original diagnosis gaps: <what doesn't hold up>
- Alternative: <hypothesis with evidence>
- Suggested investigation: <what to check next>

If insufficient-evidence:
- What's missing: <specific evidence gaps>
- What to investigate: <targeted next steps>
- Partial confirmation: <which parts of the diagnosis are supported>

## Gate Discipline

Your verdict is the gate. Apply the Verdict Rule as the only criterion. Do not soften `alternative-hypothesis` because the investigator worked hard, and do not return `confirmed` because nothing obviously breaks. Do not use `insufficient-evidence` as a courtesy escape hatch when you actually have enough to choose between `confirmed` and `alternative-hypothesis`. The orchestrator depends on a structural gate, not a courtesy one.
```
