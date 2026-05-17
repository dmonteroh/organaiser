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
  - Must check for missing sources the researcher didn't consult
  - Must identify unsupported conclusions (claims without cited evidence)
  - Must flag contradictions the researcher may have glossed over

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

1. Dispatch `researcher` with research question and scope:
   - Define what sources to consult (codebase, web, documentation, specific files)
   - Define what the deliverable looks like (comparison table, findings list, recommendation, etc.)
2. Researcher produces findings report with:
   - Evidence-level tags on every claim
   - Coverage map (what was searched, what wasn't)
   - Contradictions section (or "none found")
   - Open questions and leads not yet pursued
3. Dispatch `cross-checker` with the research question + researcher's report:
   - Independently verify key claims
   - Check for missing sources
   - Identify unsupported conclusions
   - Flag gaps in the coverage map
4. If cross-checker returns `fail-with-gaps`:
   - Re-dispatch `researcher` on the named gaps only
   - When researcher returns, re-run step 3 against the updated findings
   - Bounded by the loop cap in the Rules below
5. If cross-checker returns `pass`:
   - Orchestrator synthesizes the final report from verified findings (consolidate and trim, do not add new claims)
6. Mark task `ready`

### Post-all-tasks

1. If multiple research tasks: check for contradictions across task findings
2. Produce consolidated research summary with cross-references
3. Mark all tasks `integrated`

### Rules

- Steps are executed in order. No step may be skipped.
- Maximum follow-up rounds: 2. If gaps persist after 2 rounds, include remaining gaps as `unverified` items in the final report with explicit "not confirmed" labels.
- The researcher must never modify project files. Research output goes into the report, not the codebase.
- The cross-checker operates with a fresh context: do not pass the researcher's reasoning, only their findings and citations.

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
- Cross-checker has verified key claims and returned `pass`
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
2. The cross-checker ran AFTER the final researcher output (not on an earlier draft).
3. The coverage map reflects what was actually searched, not what was planned to be searched.
4. Contradictions between sources are documented, not silently resolved.
5. No forbidden claims appear in the report.

