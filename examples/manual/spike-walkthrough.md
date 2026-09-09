# Worked example: spike workflow

This is an end-to-end run of [spike-workflow](../../workflows/spike-workflow.md) on one concrete question, so you can see what to expect before you run a spike of your own. A spike is time-boxed exploration that intentionally writes throwaway code to answer a specific question. The output is validated learning, not production code, and every spike ends with an explicit adopt, adapt, or abandon decision.

The question for this run: can a regex parse and evaluate a small search-filter language, or do we need a real parser? This is the classic "is the cheap approach good enough?" spike, and the honest answer here turns out to be "no, but part of it is."

## How to read this

This run is a hybrid. Two steps were executed for real (an `explorer` writing and running throwaway code in a sandbox, then a `spike-reviewer`), and their output is reproduced here. The decision gate is the orchestrator-and-operator step. Each section is tagged:

- **[REAL]**: genuine subagent output, captured from an actual run, reproduced verbatim.
- **[ILLUSTRATIVE]**: the decision-gate and cleanup step, grounded in the real findings.

Same caveat as the other examples, from the README: a spike spends tokens (and writes code you may throw away) to buy certainty. The payoff is that you learn whether an approach works for an hour's exploration instead of finding out after you have built it for real.

A note on roles: the **operator** is you, the human. The **orchestrator** drives the workflow and dispatches the `explorer` and `spike-reviewer`.

## The spike contract

Every spike defines its contract up front. Vague spikes sprawl; a tight contract is what makes the time-box enforceable. Here is the contract for this run:

| Field | Value |
|---|---|
| Question | Can a regex reliably parse and evaluate our search-filter mini-language (`field:value` terms with `AND`/`OR` and parentheses for grouping), or do we need a real parser? |
| Hypothesis | A regex tokenizer plus straightforward evaluation is enough for v1. Expected to handle flat queries; unknown whether it handles grouped/nested queries with correct precedence. |
| Scope box | A throwaway sandbox directory. Scratch files only. |
| Time box | Small: a scratch implementation plus a handful of representative queries (flat and nested). Stop as soon as the question is answered. |
| Success signal | A regex approach correctly evaluates all representative queries, including parenthesized ones. |
| Failure signal | The regex approach produces wrong results for, or cannot represent, grouped/nested queries (or mishandles `AND`/`OR` precedence). |
| Forbidden | No npm dependencies or parser library; no full production parser; no changes outside the sandbox. |

The throwaway scripts the explorer wrote during this run are kept next to this walkthrough at [spike-run/scratch/](spike-run/scratch/) so you can reproduce the result. From the `examples/manual` directory, run `node spike-run/scratch/eval.js` (the two regex approaches) and `node spike-run/scratch/adversarial.js` (the disproving probe).

---

# Step 1: Explorer **[REAL]**

The `explorer` writes code for learning speed, not quality, inside the scope box, and stops the moment the question is answered. Here is the real report it returned:

```text
Spike Report:
- Verdict: disproved
- Evidence:
  - Approach A (regex tokenize + left-to-right scan, no grouping): passed 11/13. Correct on all
    flat queries but FAILED both parenthesized cases by construction; e.g.
    "status:open AND (assignee:me OR priority:high)" returned false, expected true. It has no
    mechanism to represent grouping at all.
  - Approach B (regex tokenize + iterative regex collapse: replace terms with T/F, then loop
    replacing "T AND F", "T OR F", and "(T)" until stable): initially passed 13/13 representative
    cases and 9/9 stress cases against a recursive-descent reference, which looked like a confirm.
    This was misleading.
  - Adversarial probe broke Approach B: query
    "status:open OR priority:low AND (assignee:bob OR status:closed)" against
    {status:open, priority:high, assignee:alice} returned false, but the correct answer is true
    (1 mismatch over 20 evals). Trace: the string becomes "T OR F AND ( F OR F )". Because the AND
    has a "(" on its right (not a literal), the AND-first rule does not fire, so the loop wrongly
    collapses "T OR F" to "F" before the AND group resolves. The "do AND before OR" gate is global
    (is there any collapsible AND in the whole string), not per-group, so OR-collapse leaks across
    a pending AND that spans a parenthesis boundary. This is a precedence violation, the exact
    failure signal.
- What was learned:
  - Flat queries are trivially handled by regex tokenize plus a scan; that part of the hypothesis
    holds.
  - For grouped/nested queries, the "regex collapse until stable" trick can look correct on
    hand-picked cases but is not reliable: regex cannot tell whether the operand across an operator
    is a literal or a group boundary, so precedence gating fails when an AND straddles a
    parenthesis next to an OR.
  - The only way the collapse loop got close was by smuggling in non-regex structure (an outer
    loop plus paren-stripping), i.e. a hand-rolled, buggy parser pretending to be "just regex".
    Correct precedence across groups needs an actual recursive-descent (or shunting-yard)
    evaluator, which the 20-line reference in the spike does correctly.
- What remains unknown:
  - Malformed input (unbalanced parens, empty groups, unknown operators) was not exercised.
  - Tokenizer edge cases (special chars, quoted values, case-insensitive operators) not explored.
  - NOT/negation and comparison operators are out of scope but likely future asks that further
    favor a real parser.
- Scope used: throwaway Node scripts in the scope box only (eval.js, stress.js, adversarial.js);
  no dependencies; nothing outside the scope box touched.
- Suggested direction (non-binding; the decision gate decides): adapt
  - Rationale: Keep the regex for the cheap, reliable part (tokenizing into terms, AND, OR,
    parens), but do NOT use regex for evaluation/precedence. A tiny recursive-descent evaluator
    (the ~20-line reference already written and proven correct) handles grouping and AND-over-OR
    precedence with no external dependency. The pure-regex evaluation path is disproved.
- If adapt/adopt, implementation notes:
  - Use regex ONLY as the lexer. Do evaluation with recursive-descent: parseOr -> parseAnd ->
    parseAtom, where parseAtom handles "(" parseOr ")" and bare terms.
  - Pitfall: any "replace literals then iteratively collapse the string" scheme fails precedence
    when an operand is a group rather than a literal, and the bug is silent (passes naive tests).
  - Make operator matching robust (word boundaries), validate structure (unbalanced parens), and
    broaden the term-value character class beyond [A-Za-z0-9_].
```

What to notice, and this is the whole reason spikes write disposable code: Approach B **passed 13 of 13 representative cases and 9 of 9 stress cases**. If the explorer had stopped there, it would have reported "confirmed" and you would have shipped a subtly broken evaluator. It kept probing, found one adversarial query that returns the wrong boolean, and that single sound counterexample disproved the hypothesis. The spike bought you that discovery for an hour of throwaway code instead of a production incident.

# Step 2: Spike review **[REAL]**

The `spike-reviewer` does not review code quality (the code is throwaway by definition). It checks one thing: was the question answered with enough evidence to make the decision? Here is its real verdict:

```text
Spike Review:
- Verdict: question-answered
- Evidence assessment:
  - Strength: strong
  - Key evidence: The spike tests both honest interpretations of "a regex approach." Approach A
    cannot represent grouping and fails parenthesized cases by construction (11/13). Approach B
    passes all 13 representative and 9 stress cases but is broken by a single adversarial query,
    returning false when the correct answer is true (verified independently: got=false, ref=true).
    The failure is a genuine precedence violation (the stated failure signal) with a correct root
    cause. I re-ran all three scripts and reproduced every number, and hand-traced the
    counterexample to confirm the diagnosis.
  - Gaps that matter for the decision: none. A single sound counterexample is sufficient to
    disprove "correctly evaluates ALL representative queries." The listed unknowns (malformed
    input, tokenizer edges, NOT/comparison operators) are forward-looking and do not affect the
    adopt/adapt/abandon choice for the pure-regex evaluation path.
- Learning assessment:
  - Clearly documented: yes
  - Actionable for next step: yes. The lesson (regex can lex but cannot evaluate grouped
    precedence reliably; the "collapse until stable" trick is a buggy hand-rolled parser in
    disguise) is concrete, and the adapt direction (regex lexer + tiny recursive-descent) is
    specific and already validated as the reference implementation in the spike code.
- Scope assessment: within bounds. Three throwaway Node scripts in the scope box, no dependencies,
  nothing outside touched.
- Ready for decision gate: yes. The hypothesis is disproved with solid, reproduced evidence; the
  question is answered: regex alone cannot, a tiny real parser is needed. This supports "adapt".
```

The reviewer did not take the explorer's word for it. It re-ran all three scratch scripts, reproduced the exact mismatch, and hand-traced the failing query to confirm the root cause was real and not a test artifact. That independent recheck is the gate. Verdict: `question-answered`, ready for the decision.

# Step 3: Decision gate **[ILLUSTRATIVE]**

A spike must end in a decision. "Let's keep exploring" is not an outcome; you either extend the time box explicitly or decide. With a `question-answered` verdict and a disproved hypothesis, the orchestrator (with the operator) weighs the three options:

- **Adopt**: no. The pure-regex evaluator is disproved. Adopting it would ship a silently wrong precedence bug.
- **Adapt**: yes. The spike showed exactly which part of the idea survives. Regex is a fine lexer for the mini-language; evaluation needs a tiny recursive-descent parser (parseOr to parseAnd to parseAtom), which is about 20 lines, needs no dependency, and was already proven correct as the reference in the spike. Create a follow-up task to build that properly: refine it through [task-refinement-workflow](../../workflows/task-refinement-workflow.md), then implement under [dev-workflow](../../workflows/dev-workflow.md). The spike code is reference only, never promoted directly.
- **Abandon**: no, but note that abandoning the regex-evaluation path specifically (a partial abandon) is part of the adapt decision.

Decision recorded: **adapt**, with the implementation notes carried into the follow-up task so the next agent does not rediscover the precedence trap.

## Cleanup: deletion needs operator approval

Spike code is throwaway, but it is not deleted automatically. The orchestrator proposes a disposition and waits for the operator to approve before removing anything:

> Proposed cleanup: keep `stress.js` (it contains the ~20-line recursive-descent reference that the follow-up task will build on) as marked reference. Delete the disproved experiments `eval.js` and `adversarial.js`. Approve?

The operator approves keeping the recursive-descent reference and deleting the two dead-end scripts. Nothing is deleted until that approval is given, and the decision plus the kept reference are recorded with the task.

(For this published example all three scratch scripts are retained at [spike-run/scratch/](spike-run/scratch/) so you can run them and see the result for yourself. In a real run, `eval.js` and `adversarial.js` would be removed once the operator approved, leaving only the reference.)

---

# What to expect when you run this

- **The code is meant to be thrown away.** The explorer optimized for learning speed, not quality, and most of what it wrote is now deleted. That is success, not waste.
- **A clean run of passing tests is not the answer.** Approach B passed every hand-picked and stress case before one adversarial query disproved it. Spikes exist precisely to find that out cheaply.
- **The reviewer re-runs the evidence.** It does not judge code style; it re-executed the scratch scripts and hand-traced the counterexample to confirm the question was genuinely answered.
- **You must decide.** Every spike ends in adopt, adapt, or abandon. Here the answer was a precise adapt: keep the part that works (regex as lexer), drop the part that does not (regex as evaluator), and build the rest properly under the other workflows.
- **Throwaway code is still deleted on your terms.** Cleanup proposes what to keep and what to remove, and waits for operator approval before deleting anything.
- **It costs tokens and some disposable code.** What you get back is certainty about an approach before you commit to it.

To go deeper, read the contract itself: [spike-workflow](../../workflows/spike-workflow.md), plus the [explorer](../../workflows/subagents/explorer-prompt.md) and [spike-reviewer](../../workflows/subagents/spike-reviewer-prompt.md) prompt templates.
