# Code Quality Reviewer Prompt (Copy/Paste Template)

Purpose: verify the implementation is well-built: correct, maintainable, tested, and safe.

Only run this after spec compliance passes (or if explicitly asked to review quality regardless).

```text
Review type: code-quality

Scope:
- Review only these paths: <paths>

Inputs:
- Summary of change intent:
  - <1-3 bullets>
- Implementer's claimed verification output:
  - <paste or reference>
- Optional: diff range:
  - <base sha>..<head sha>

Checks:
- Correctness: edge cases, error handling, concurrency, idempotency (if relevant)
- Maintainability: naming, structure, duplication, complexity
- Safety: secrets/logging, unsafe defaults, dangerous operations
- Tests: presence, quality, and whether they actually validate behavior
- Verification gap:
  - Did the implementer's claimed verification actually run, and does the output match the code as shipped?
  - Is there a missing test for the changed code path?
  - Is there a missing assertion that proves the bug stays fixed (for bugfix triggers)?
  - Is there a missing regression test for previously failing behavior?

Rules:
- Do not trust the implementer report.
- Distinguish missing automated logic coverage from missing operator-run manual verification. Do not convert manual verification instructions into a demand for new automated infrastructure unless the requirement explicitly says so.

HARD CONSTRAINT:
- Severity thresholds may not be relaxed for any reason in the Anti-Rationalization table of the parent workflow.
- A `Minor` finding may not be silently dropped or rolled up as "no issues"; the orchestrator must append it to the follow-ups file.

Gate Discipline:
- This gate cannot be skipped. Spec-reviewer.pass does not imply quality-reviewer.pass; they are orthogonal axes.
- Token pressure does not relax the verdict threshold. If you cannot complete the review with the available context, return `needs-info` naming what is missing; do not return `pass` to conserve tokens.

Verdict Rule:
- `pass` = no Critical or Important findings; any Minor findings are listed for the follow-ups file.
- `fail-with-severity: <level>` = at least one Critical or Important finding. State the highest severity explicitly in the verdict line (e.g., `fail-with-severity: critical`).
- `needs-info` = required context (diff, implementer verification output, or spec) is missing in a way that makes any verdict require guessing.

Severity definitions:
- Critical = bug, safety hole, secret leak, data loss risk, or anything that ships a defect to users.
- Important = correctness or test-quality gap that would ship a defect under foreseeable conditions; missing regression test for a fixed bug; missing assertion for new behavior.
- Minor = style, maintainability, or naming issue with no correctness impact.

Output:
- Verdict: pass | needs-info | fail-with-severity: <critical | important | minor>
- Findings ordered by severity (Critical/Important/Minor), each with file path and line number
- Concrete fixes (file path and line number)
- What to verify (commands)
```
