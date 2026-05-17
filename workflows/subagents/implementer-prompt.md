# Implementer Subagent Prompt (Copy/Paste Template)

Use this to dispatch an implementer subagent. It is designed to work in **non-interactive** subagent environments.

```text
Task: <one sentence, explicit outcome>.

Context:
- Why: <why this exists>
- Where: <module/service>
- Constraints: <compat/security/perf>
- Trigger: <implementation | bugfix | refactor | feature>

Scope:
- Allowed: <paths>
- Avoid: <paths>

Inputs:
- Read these files first:
  - <paths>
- Evidence:
  - <failing tests / logs / repro steps>

Verification commands (you must run these and include verbatim output in your report):
- <e.g., dotnet test>
- <e.g., yarn test>
- <e.g., yarn lint>

Follow-ups file:
- <path/to/<task-brief-name>-follow-ups.md>

Rules:
- If anything is ambiguous or conflicts: STOP and output QUESTIONS. Do not guess.
- TDD: if Trigger is `bugfix` or `refactor`, write the failing/regression test first, watch it fail, then implement. Use the `testing` skill if available.
- In-scope work: code that satisfies acceptance criteria, fixing failing tests, adding tests within the existing pattern, refactoring touched code minimally.
- Out-of-scope work (STOP + QUESTIONS): introducing a new test framework, a new external service, docker or CI environment dependencies, live-database harnesses, or any verification approach not already used in the repo.
- Do not expand scope beyond the acceptance criteria.
- Do not refactor unrelated code.
- Preserve existing APIs unless explicitly instructed.
- Adding comments to the code is okay when necessary, but they must not reference Acceptance Criteria text or text from the task (those files are not tracked).
- Commit your work before reporting back. Use the `smart-conventional-commits` skill when available. Stage only the files you changed (do not `git add -A`). Never add yourself as a co-author. If there is nothing to commit (e.g. read-only investigation), say so explicitly.

HARD CONSTRAINT:
- You must run every command listed under `Verification commands` and capture the raw output (including failures). The orchestrator will not re-run them per task; the downstream quality-reviewer gate verifies that your output matches the code as shipped.
- You must complete the Self-review checklist (below) before reporting. Skipping or fabricating any checklist item will be caught at the quality-reviewer gate.

Gate Discipline:
- Your report is consumed by independent reviewers who will read the code and re-evaluate. Do not optimize your report to "pass" review; surface every concern you have. Honest uncertainty is better than confident wrongness.
- If you discover during work that the acceptance criteria are wrong or incomplete, STOP and output QUESTIONS. Do not implement around the criteria.

Steps:
1) Inspect current state (read the listed files).
2) If TDD applies (bugfix/refactor): write the failing test first; watch it fail.
3) Implement the minimal change that satisfies the acceptance criteria.
4) Update/add tests if appropriate (within the existing test pattern).
5) Run the verification commands listed above; capture output verbatim.
6) Complete the Self-review checklist.
7) Commit your changes via the `smart-conventional-commits` skill (or an equivalent conventional commit if the skill is unavailable).

Self-review checklist (answer each item explicitly in your report):
- [ ] Reread each acceptance criterion: which file/lines satisfy it?
- [ ] Verification commands ran; output captured verbatim.
- [ ] Verification output shows no regressions in the changed scope.
- [ ] No scratch code, debug prints, TODOs, or commented-out blocks left behind.
- [ ] No unrelated files modified.
- [ ] Self-spotted risks or follow-ups noted.

Acceptance Criteria:
- [ ] <criterion>
- [ ] <criterion>

Output:
- Change summary (and Root cause if Trigger is `bugfix`).
- Files changed/moved.
- Commit hash and final commit title (or explicit "nothing to commit").
- Verification output (verbatim) for each command listed above.
- Self-review checklist with each item answered.
- Any risks or follow-ups.
- If blocked: QUESTIONS (explicit) + what info is missing.
```
