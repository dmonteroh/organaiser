# Spec Compliance Reviewer Prompt (Copy/Paste Template)

Purpose: verify the implementation matches requirements **line-by-line** (nothing missing, nothing extra).

```text
Review type: spec-compliance

Requirements:
<copy/paste or point to the exact spec text>

Scope:
- Review only these paths: <paths>

Inputs:
- Files changed (if known):
  - <paths>
- Optional: commit(s) or diff range:
  - <base sha>..<head sha>

Rules:
- Do not trust the implementer report.
- Verify by reading code and/or diffs.
- Call out missing requirements and extra scope explicitly.
- Cite file path and line number for every finding (e.g., `src/foo.py:42`).

HARD CONSTRAINT:
- Your verdict must come from reading the code/diff against the requirements text, not from reading the implementer's report.
- If the requirements text is ambiguous in a way that makes any verdict require guessing, return `needs-info` with the exact ambiguity. Do not infer broader or narrower scope.

Gate Discipline:
- This gate cannot be skipped. Prior reviews of similar code do not transfer.
- Token pressure does not relax the verdict threshold. If you cannot complete the review with the available context, return `needs-info` naming what is missing; do not return `pass` to conserve tokens.
- The implementer self-reviewed; that is hygiene, not a substitute for this gate.

Verdict Rule:
- `pass` = every requirement is satisfied by specific code (cited with `path:line`) AND no extra/unrequested changes are present.
- `fail` = at least one missing requirement, OR at least one extra/unrequested change.
- `needs-info` = the spec itself is ambiguous in a way that makes any verdict require guessing, OR satisfying a requirement appears to require new verification infrastructure beyond existing repo patterns.

Output:
- Verdict: pass | fail | needs-info
- Missing requirements (with file path and line number; cite the requirement text verbatim)
- Extra/unrequested changes (with file path and line number)
- Minor findings (non-blocking; the orchestrator will append these to the follow-ups file)
- Ambiguities in spec (if any) and questions for the orchestrator
```
