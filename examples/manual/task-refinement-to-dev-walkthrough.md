# Worked example: task refinement into development

This is an end-to-end run of two workflows on one small task, so you can see what to expect before you try them on your own code. It chains [task-refinement-workflow](../../workflows/task-refinement-workflow.md) (turn a rough request into an implementation-ready brief) into [dev-workflow](../../workflows/dev-workflow.md) (implement it behind independent review gates).

The task is deliberately tiny: add a `debounce` utility, with tests, to a project that already has a `throttle` helper. Small enough to read in one sitting, real enough to show every gate firing.

## How to read this

This run is a hybrid. Two steps were executed for real against a throwaway sample project, and their output is reproduced verbatim. The connective steps are reconstructed to keep the example short and deterministic. Each section is tagged:

- **[REAL]**: genuine subagent output, captured from an actual run, reproduced verbatim.
- **[ILLUSTRATIVE]**: a faithful reconstruction of what that step produces, grounded in the real artifacts around it.

One thing to set expectations on, echoed from the README: this style spends more tokens than typing the code yourself. You are buying validation, correctness, and fewer hallucinations, not speed. A two-file utility runs several subagents. That is the point, not overhead to optimize away.

A note on roles: the **operator** is you, the human. The **orchestrator** is the agent that drives a workflow and dispatches its subagents (analyst, implementer, reviewers).

## The sample project

A minimal ES module project with one existing utility, used as the pattern to match:

```
debounce-demo/
  package.json            // "type": "module", test script: node --test
  src/utils/
    throttle.js           // existing leading-edge throttle helper
    throttle.test.js      // existing test style (node:test, assert/strict)
```

`throttle.js` is leading-edge: the first call runs immediately, later calls in the window are dropped. Keep that in mind. It becomes the interesting wrinkle during refinement.

The full sample project and the task briefs from this run are included next to this walkthrough so you can read and run them: the project at [example-run/debounce-demo/](example-run/debounce-demo/), the raw task at [example-run/task-debounce.md](example-run/task-debounce.md), the refined brief at [example-run/task-debounce-refined.md](example-run/task-debounce-refined.md), and the follow-ups file at [example-run/task-debounce-refined-follow-ups.md](example-run/task-debounce-refined-follow-ups.md). Run the tests with `node --test` from `example-run/debounce-demo`.

## The starting point: a rough request

This is the raw task as a teammate might file it. Note how little it actually pins down.

```markdown
# Task: Add a debounce utility

We have a throttle helper in the utils folder. We need a debounce too.

Add a `debounce` function so we can stop firing handlers on every keystroke.
Should have tests like the throttle one.
```

It reads clear. That is the trap the refinement workflow exists to catch: clarity to a reader is not the same as implementation-readiness.

---

# Stage 1: Task refinement

Goal of this stage: reach an implementation-ready brief where every confidence dimension is `confident`, zero blockers remain, and an implementer has no decisions left to guess at.

## Step 1: Analyst confidence check **[REAL]**

The orchestrator dispatches the `analyst` subagent (read-only) with the raw task and the files it is likely to touch. The analyst must read the actual source, produce a file-level sketch, rate each confidence dimension, and list blockers, questions, vagueness, and risks separately.

Here is the real report it returned:

```text
Confidence Check Report:
- Task: Add a debounce utility (matching the existing throttle helper)
- Files Read:
  - src/utils/throttle.js (serves as the shape/style template; not modified)
  - src/utils/throttle.test.js (serves as the test-style template; not modified)
  - package.json (confirms ESM "type": "module" and node --test runner; no changes needed)
- Dimensions:
  - Requirements clarity: uncertain. Evidence: The intent and the directive to mirror throttle
    are clear, but the debounce semantics are underspecified. The brief does not state leading
    vs trailing edge. The keystroke use case implies trailing-edge (fire once after the user
    stops typing), which is the opposite edge from the existing throttle (leading-edge). "Tests
    like the throttle one" gives a style target but no acceptance criteria for return value or
    this/args forwarding.
  - Technical feasibility: confident. Evidence: throttle.js is a 14-line closure. A trailing-edge
    debounce is a standard closure over setTimeout/clearTimeout, well within the same file shape.
    The test runner and sleep helper pattern port directly. No build step, no external deps.
  - Scope boundaries: confident. Evidence: Two new files only (debounce.js and debounce.test.js).
    No other consumers import throttle, so nothing forces wider changes.
  - Dependency identification: confident. Evidence: No prerequisite work. Only shared code path is
    the conventions in throttle.js/throttle.test.js. package.json confirms ESM and the test
    command, so a new *.test.js is auto-discovered.
  - Risk exposure: uncertain. Evidence: Main risk is semantic, not technical: choosing the wrong
    edge. Trailing-edge fits the keystroke use case but is the opposite of throttle's model, so a
    naive "copy throttle's shape" could produce wrong timing. Timing tests with real timers are
    flaky if windows are too tight. A trailing-edge debounce cannot return fn's value
    synchronously, so an assertion modeled too literally on throttle's first-call test would fail.
  - Agent implementability: confident. Evidence: concern axes = 1; acceptance criteria well under
    12; files created = 2 (under 10); independent failure classes = 1. No split conditions met.
- Implementation Sketch:
  1. Create src/utils/debounce.js (new). Export function debounce(fn, wait) returning a closure
     that holds a timer id, clears any pending timer on each call, and schedules fn.apply(this,
     args) via setTimeout after wait ms (trailing-edge).
  2. Create src/utils/debounce.test.js (new). Reuse the sleep helper pattern; cover: does not fire
     within the window, fires once after the wait following a burst, repeated calls reset the timer.
- Blockers: none
- Questions:
  - Leading-edge or trailing-edge debounce? (Trailing assumed, but should be confirmed.)
  - Is a cancel() method wanted, or is the bare closure sufficient to match throttle's minimalism?
  - Should the debounced wrapper return anything? (Assumed: undefined.)
- Vagueness:
  - "Like the throttle one" specifies style, not behavior; could be misread as "leading-edge".
  - "Tests like the throttle one" does not enumerate which behaviors must be tested.
- Risks:
  - Wrong edge semantics produces a function that passes naive tests but misfits the use case.
  - Flaky timing tests if the assert margin is too small.
  - Copying throttle's return-value assertion into the debounce test would fail.
- Overall: needs-review
```

What to notice: the analyst did not just rephrase the ticket. By reading `throttle.js` it found a real trap (throttle is leading-edge, but keystroke debouncing wants trailing-edge) and surfaced two dimensions as `uncertain`. `Overall: needs-review` means the task is not ready to implement yet. The workflow now routes to the architect.

## Step 2: Architect review **[ILLUSTRATIVE]**

Because dimensions came back `uncertain`, the orchestrator dispatches the `architect` subagent. The architect resolves what the codebase can answer and escalates only what genuinely needs the operator.

Resolutions it makes from available signal:

- **Edge semantics: trailing.** The stated use case ("stop firing on every keystroke") is decisive. Fire once after input settles. Recorded with rationale so the implementer does not re-litigate it.
- **Return value: undefined.** A trailing-edge call is deferred, so it cannot forward `fn`'s result synchronously. This closes the analyst's third question.

One item it does not feel entitled to decide alone:

- **A `cancel()` method?** This is a product call about the utility's surface area, not something the codebase implies. The architect classifies it as `operator-required` rather than guessing.

## Step 3: Operator escalation **[ILLUSTRATIVE]**

The orchestrator brings the one open question to you with full context:

> The debounce helper can optionally expose a `cancel()` to drop a pending call. Throttle has no such method. Adding it widens the API. Do you want `cancel()` now, or keep it minimal and add it later if a consumer needs it?

Operator answer: keep it minimal, no `cancel()` for now. The decision is recorded in the brief. This is the whole point of the escalation gate: a product choice is made once, by the right person, and written down, instead of being silently invented at implementation time.

## Step 4: Final analyst pass **[ILLUSTRATIVE]**

With decisions recorded, the analyst re-checks. Every dimension is now `confident`: the edge is fixed, the return contract is fixed, the API surface is fixed, and the sketch still holds. Zero blockers. `Overall: implementation-ready`.

## Output of Stage 1: the refined brief

Refinement does not produce code. It produces an enriched brief that an implementer can execute without guessing. The workflow requires three sections appended before a task is implementation-ready. Here is what they look like for this task:

```markdown
## Implementation Constraints
- Reference pattern: mirror src/utils/throttle.js (ESM export function, a single closure, a short
  leading comment describing the semantics) and src/utils/throttle.test.js (node:test,
  node:assert/strict, an inline sleep helper).
- Negative scope: no cancel()/flush(); no leading-edge option; no new dependencies; do not modify
  throttle.js, package.json, or any other file.
- Deployment context reminder: ESM project ("type": "module"), Node built-in test runner only.
- Playbook-like instructions: one closure over a single timer id. On each call, clearTimeout the
  previous timer, then setTimeout a call to fn.apply(this, args) after wait ms.

## Sizing Budget
- Concern axes count: 1 (a timing utility plus its test).
- Acceptance criteria count: 6.
- Estimated file touch count: 2 (both new).
- Independent failure classes: 1 (timer scheduling).

## Execution Gates
- Blocked by: none.
- Order constraints: none (standalone).
- Dispatchability: dispatchable.
- Follow-up tasks: none.
```

The brief also now carries six concrete, testable acceptance criteria in place of "should have tests like the throttle one." That brief is the handoff into development.

---

# Stage 2: Development

Goal of this stage: implement the brief and prove it correct through two independent gates, in order: spec compliance first, then code quality. The implementer's own report is never trusted as proof; a fresh-context reviewer reads the actual code.

## Step 1: Implementer **[REAL]**

The orchestrator dispatches the `implementer` with the full requirements text (not a file reference), the verification command to run, and the follow-ups file path. The implementer writes the code and the tests, runs the tests itself, and reports verbatim output plus a self-review.

Its real change summary:

> Added a trailing-edge `debounce(fn, wait)` utility that mirrors the throttle helper's shape and test style. Each call clears any pending timer and reschedules, so a burst collapses into a single invocation `wait` ms after the last call. The wrapper returns `undefined`, and there is no cancel/flush API. `this` and the latest arguments are forwarded via `fn.apply(this, args)`.

The code it produced (`src/utils/debounce.js`):

```javascript
// Delays running `fn` until `wait` milliseconds have passed without a new call.
// Trailing-edge: only the last call in a burst runs, `wait` ms after it. Each
// call resets the timer, so a pending invocation is rescheduled rather than
// stacked. Mirrors the throttle helper's shape and test style.
export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}
```

The verbatim verification output it captured (and which was independently re-run for this document, with the same result):

```text
> debounce-demo@1.0.0 test
> node --test

✔ debounce does not run synchronously (0.617292ms)
✔ debounce runs once after the wait following the last call (71.126833ms)
✔ debounce collapses a burst into a single trailing call (70.665833ms)
✔ debounce resets the timer on each call rather than stacking (104.030958ms)
✔ debounce forwards the latest arguments and this (72.753209ms)
✔ debounce returns undefined (0.205ms)
✔ throttle runs immediately on the first call (0.375625ms)
✔ throttle drops calls inside the window (60.920584ms)
ℹ tests 8
ℹ pass 8
ℹ fail 0
```

Notice it ran the existing throttle tests too, confirming no regression, and it flagged its own residual risk honestly (real-timer tests carry inherent flakiness under heavy CI load). That candor is required: the report feeds reviewers who re-check, so optimizing the report to "look passing" only gets caught downstream.

(In a real repository the implementer also commits its work with a conventional commit, staging only the files it changed. During this run the code lived in a scratch sandbox outside version control, so the implementer skipped the commit step and said so explicitly rather than pretending. The resulting files are included here under [example-run/debounce-demo/](example-run/debounce-demo/) so you can read and run them.)

## Step 2: Spec-compliance review **[ILLUSTRATIVE]**

A fresh `spec-reviewer` reads the code against the six acceptance criteria, line by line. It does not trust the implementer's report. It checks for both missing requirements and extra, unrequested work.

```text
Review type: spec-compliance
- Verdict: pass
- AC1 named ESM export debounce(fn, wait): debounce.js:5. Satisfied.
- AC2 no synchronous invocation: debounce.js:11-14 (scheduled via setTimeout). Satisfied.
- AC3 runs once, wait ms after the last call: debounce.js:8-14. Satisfied.
- AC4 each call resets the timer: debounce.js:8-10 (clearTimeout then reschedule). Satisfied.
- AC5 forwards latest args and this: debounce.js:13 (fn.apply(this, args)) in an arrow callback
  that captures the call-site this. Satisfied.
- AC6 tests match throttle.test.js style: debounce.test.js (node:test, assert/strict, inline sleep).
- Missing requirements: none.
- Extra/unrequested changes: none. Negative scope respected (no cancel(), no other files touched).
```

`pass`. Spec compliance confirms WHAT was built matches the brief. It says nothing about whether it was built well, which is a separate axis, so the next gate still runs.

## Step 3: Code-quality review **[ILLUSTRATIVE]**

Only after spec compliance passes does the `quality-reviewer` run. It is severity-graded: `critical` and `important` findings block; `minor` findings do not block but must be written to the follow-ups file. It also confirms the implementer's claimed verification actually matches the shipped code.

```text
- Verdict: pass
- Correctness: timer lifecycle is sound; clearTimeout guards the null case; timer reset to null
  inside the callback prevents a stale handle. No blocking issues.
- Test quality: covers the deferral, the burst collapse, the timer reset, args/this forwarding, and
  the undefined return. Good behavioral coverage for a timing utility.
- Verification-gap check: the captured node --test output matches the shipped tests; re-run confirms
  8 passing. No gap.
- Findings:
  - minor (debounce.test.js:5): the sleep helper duplicates the one in throttle.test.js. Not a
    defect today. Suggested fix: extract a shared test helper if a third timing test appears.
```

`pass`, with one `minor` finding. The minor does not block the gate, but it is not discarded either.

## Step 4: Follow-ups file

The minor finding is appended to the follow-ups file (next to the brief), which is the canonical record for later operator triage. It is never rolled up into the completion report as "resolved".

```markdown
- 2026-05-24 | source: quality-reviewer | src/utils/debounce.test.js:5 | The sleep helper is
  duplicated from throttle.test.js:5. Not a defect; both files are self-contained today. Suggested
  fix: if a third timing test file appears, extract sleep into a shared test/helpers.js.
```

## Completion

Both gates passed in order, final verification was run after the last change, and the one minor finding is recorded. The task is marked integrated. The feature is a trailing-edge debounce with six behaviors under test, no regressions, and a written decision trail explaining why it is trailing-edge and why it has no `cancel()`.

---

# What to expect when you run this

- **The rough ticket is not the spec.** Refinement reads your actual code and converts vague intent into concrete, testable criteria plus explicit decisions. The leading-vs-trailing catch here came from reading the neighboring file, not from the ticket.
- **Decisions get made by the right party, once.** The codebase-answerable questions are resolved by the architect; genuine product calls (like `cancel()`) come to you, and the answer is recorded so it is not silently re-invented later.
- **Implementation is gated, not trusted.** The implementer self-reviews and runs tests, but that is hygiene. Independent reviewers read the real code: spec compliance first, then quality. Order is fixed and not skippable.
- **Nothing is swept under the rug.** Minor findings go to a follow-ups file, not into a "looks good" summary. Verification output is captured verbatim and re-run after the last change.
- **It costs more tokens than typing the code.** Several subagents ran to ship a two-file utility. The return is validation and a decision trail, not speed.

To go deeper, read the contracts themselves: [task-refinement-workflow](../../workflows/task-refinement-workflow.md) and [dev-workflow](../../workflows/dev-workflow.md), plus the subagent prompt templates in [../../workflows/subagents/](../../workflows/subagents/).
