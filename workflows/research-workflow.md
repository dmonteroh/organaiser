---
id: research-workflow
name: Research Workflow
triggers: [research, analysis, investigation, comparison]
---

# Research Workflow Contract

Structured investigation process that produces evidence-backed findings. Researcher gathers and synthesizes, cross-checker verifies coverage and identifies gaps. The output is a knowledge artifact, not code.

## Roles

### researcher

- Template: `subagents/researcher-prompt.md`
- Mode: read-only investigation (may read files, search web, explore codebase, but must NOT modify project files)
- Constraints:
  - Must cite sources for every factual claim (file path + line, URL, or documentation reference)
  - Must distinguish between verified facts and inferences/interpretations
  - Must track what was searched and what wasn't (coverage map)
  - Must note contradictions between sources rather than silently picking one

### cross-checker

- Template: `subagents/cross-checker-prompt.md`
- Mode: read-only verification (independent of researcher context)
- Gate type: structured (pass | fail-with-gaps)
- Constraints:
  - Must not trust the researcher's report; verify key claims independently
  - Must check for missing sources within the dispatched scope; sources outside that scope are suggestions for the orchestrator, not gaps
  - Must identify unsupported conclusions (claims without cited evidence)
  - Must flag contradictions the researcher may have glossed over
  - Must tag every failing item in Recommendations as `re-research` or `downgrade` so the orchestrator can route it

## Evidence Standards

Every finding in the final report must meet one of these evidence levels:

| Level | Meaning | Required for |
|---|---|---|
| `verified` | Confirmed by reading source code, documentation, or authoritative reference | Factual claims, architectural statements, API behavior |
| `corroborated` | Supported by 2+ independent sources that agree | Comparisons, best-practice recommendations |
| `inferred` | Logical conclusion from verified facts, but not directly stated anywhere | Analysis, tradeoff assessments |
| `unverified` | Claimed but not yet confirmed, included for completeness | Hypotheses, leads for further investigation |

The cross-checker flags any `verified` or `corroborated` claim that lacks sufficient citation.

## Sequence

### Per-task

1. Dispatch `researcher` per its template with the research question and scope:
   - Define what sources to consult (codebase, web, documentation, specific files)
   - Define what is out of scope
   - Define what the deliverable looks like (comparison table, findings list, recommendation, etc.)
2. Researcher returns the findings report defined in its template: evidence-tagged findings with citations, contradictions, coverage map, and open questions and leads.
3. Dispatch `cross-checker` per its template with the research question, the dispatched scope, and the researcher's findings and citations. On a re-check, also pass the cross-checker's own prior report; the re-check covers only new or changed findings plus previously flagged items.
4. If cross-checker returns `fail-with-gaps`, resolve each Recommendations item by its tag:
   - `downgrade`: relabel the named claim `unverified` in the findings. Relabels add no new claims, so they need no researcher dispatch and no re-check.
   - `re-research`: re-dispatch `researcher` in follow-up mode on the named items only, passing the current findings and the item list. Merge the returned delta into the findings, then re-run step 3 as a re-check.
   - If every item was `downgrade`, apply them and proceed to step 5.
   - If the follow-up cap (Rules below) is reached and items still fail, relabel each remaining failing item `unverified` with an explicit "not confirmed" note and proceed to step 5.
5. When the cross-checker returns `pass`, or step 4 resolved all remaining items by downgrade or cap: orchestrator synthesizes the final report from the findings (consolidate and trim, do not add new claims, carry all evidence labels and "not confirmed" notes).
6. Mark task `ready`.

### Post-all-tasks

1. If multiple research tasks: check for contradictions across task findings. Document each in the consolidated summary with both positions and their citations; do not silently pick a side. If a cross-task contradiction undermines a `verified` or `corroborated` claim, downgrade that claim to `unverified` and list the conflict as an open question.
2. Produce consolidated research summary with cross-references.
3. Mark all `ready` tasks `integrated`.

### Rules

- Steps are executed in order. No step may be skipped.
- Maximum follow-up rounds: 2. A round is one scoped researcher re-dispatch plus one cross-checker re-check; downgrade-only resolutions do not count against the cap. If gaps persist after 2 rounds, include them as `unverified` items with explicit "not confirmed" notes; the task still completes.
- The researcher must never modify project files. Research output goes into the report, not the codebase.
- The cross-checker operates with a fresh context: pass the dispatched scope and the researcher's findings and citations, never the researcher's reasoning. On re-checks, also pass the cross-checker's own prior report for scoping.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "I already know this from training data" | Training data is not research. Knowledge must be verified against current sources. Cite the source or mark it `unverified`. | researcher |
| "One source is enough" | Single-source findings are fragile. For claims that will drive decisions, corroborate. | researcher |
| "No contradicting evidence found" | Did you look for contradicting evidence, or just confirming evidence? State what you searched. | researcher |
| "The researcher was thorough, skip cross-check" | Thoroughness is self-assessed. Independent verification is structural. | cross-checker |
| "This is a simple factual lookup, no cross-check needed" | Simple lookups have the highest rate of outdated or misattributed information. Verify. | cross-checker |
| "We're running low on context" | Incomplete research is worse than no research, it creates false confidence. Escalate to orchestrator if context is exhausted. | all |
| "The answer is obvious" | Obvious answers don't need a research workflow. If you're in this workflow, the answer wasn't obvious. Do the work. | all |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- All research tasks have findings with evidence-level tags
- Cross-checker verified key claims and returned `pass`, or the follow-up cap was reached and every remaining flagged item is labeled `unverified` with a "not confirmed" note
- Coverage map is complete (what was searched and what wasn't)
- All `verified` and `corroborated` claims have citations
- Open questions and unverified items are explicitly labeled

### Forbidden Claims

The following phrases may never appear in research completion reports:

- "generally known that"
- "it's common practice to"
- "most people agree"
- "obviously"
- "everyone knows"
- "based on my knowledge" (without a cited source)
- "no downsides" or "no risks" (without evidence of looking for them)

### Completion Self-Check

Before reporting research complete, the orchestrator must verify:

1. Every factual claim has a citation or is explicitly marked `inferred`/`unverified`.
2. The cross-checker ran AFTER the final researcher output (not on an earlier draft). Orchestrator relabels (downgrades and cap-exhaustion notes) add no claims and do not require a re-check.
3. The coverage map reflects what was actually searched, not what was planned to be searched.
4. Contradictions between sources are documented, not silently resolved.
5. No forbidden claims appear in the report.

If check 2 fails, re-run the cross-checker as a re-check scoped to the findings it has not seen. If any other check fails, fix it during synthesis (labels, citations, phrasing) without adding new claims, then re-run this self-check.

## Related Workflows

- **product-spec-workflow**: Upstream. Specs that end `needs-research` route their missing user, domain, or market evidence here.
- **gap-analysis-workflow**: Upstream. Investigate classifications route here when coverage cannot be determined from the map.
- **roadmap-health-workflow**: Upstream. Investigate actions on roadmap items route here.
- **decision-workflow**: Parent or downstream. May invoke this workflow to gather evidence on individual options; research findings feed decision records.
- **spike-workflow**: Sibling. Use a spike when the question needs hands-on experimentation rather than reading sources; a spike left inconclusive after its pass cap may be restructured as a research task here.
