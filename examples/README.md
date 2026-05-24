# Examples

Worked, end-to-end runs of the workflows in [../workflows/](../workflows/), so you can see what to expect before running them on your own code. Examples are illustrative companions to the workflow contracts, not part of the contracts themselves.

Each example marks its content as either **[REAL]** (genuine subagent output captured from an actual run, reproduced verbatim) or **[ILLUSTRATIVE]** (a faithful reconstruction grounded in the real artifacts), so you always know which is which.

Some examples ship the runnable code and artifacts they were produced from, in sibling subdirectories (for example [example-run/](example-run/) and [spike-run/](spike-run/)), so you can read them yourself.

## Available examples

- [Task refinement into development](task-refinement-to-dev-walkthrough.md): chains [task-refinement-workflow](../workflows/task-refinement-workflow.md) into [dev-workflow](../workflows/dev-workflow.md) on a small task (add a `debounce` utility with tests). Shows the analyst confidence check, architect resolution, operator escalation, the implementation-ready brief, then the implementer plus the spec and quality review gates.
- [Research workflow](research-walkthrough.md): runs [research-workflow](../workflows/research-workflow.md) on a real question (cursor vs offset pagination). Shows the researcher producing evidence-tagged findings with cited URLs, an independent cross-checker re-opening the sources to verify, and the orchestrator synthesizing a final comparison and recommendation.
- [Spike workflow](spike-walkthrough.md): runs [spike-workflow](../workflows/spike-workflow.md) on a concrete question (can a regex parse a search-filter mini-language, or do we need a parser?). Shows the explorer writing throwaway code that passes naive tests before an adversarial probe disproves it, an independent spike-reviewer re-running the evidence, and an adapt decision with operator-approved cleanup.
