---
id: design-handoff-workflow
name: Design Handoff Workflow
triggers: [design-handoff, redesign-brief, ui-handoff, design-prompt]
---

# Design Handoff Workflow Contract

Produces a self-contained handoff package that lets an external design agent (for example, Claude Design) redesign an existing, implemented UI/UX area without repository access. The operator is the transport: the package must survive being pasted as text plus manually captured screenshots, with no live integration between the coding and design environments.

This workflow answers "what exists today and what must the redesign achieve?", not "what should the product do?" (that is product-spec-workflow) or "how do we build the returned design?" (that is design-intake-workflow).

## Roles

### ui-surveyor

- Template: `subagents/ui-surveyor-prompt.md`
- Mode: analytical (reads the UI source code; must NOT modify files)
- Constraints:
  - Must read the actual UI source (views, components, styles, routes) for every in-scope screen, never describe from file names, component names, or memory
  - Must describe the current state in designer-facing language: screens, flows, states, components, and tokens, not file paths or code identifiers
  - Must extract design tokens as concrete values from the code (hex colors, font sizes, spacing values), not adjectives
  - Must record interaction states per screen and rate each `implemented`, `absent`, or `unknown`; never invent behavior the code does not show
  - Must record hard constraints the redesign cannot break: available data, backend contracts, routes, platform targets
  - Supports a Follow-Up Pass: investigates only named items against the prior survey and returns a delta

### handoff-challenger

- Template: `subagents/handoff-challenger-prompt.md`
- Mode: adversarial review of the handoff package (read-only; may read the codebase to verify claims)
- Gate type: structured (package-ready | gaps-found | needs-info)
- Constraints:
  - Must review from the design agent's seat: zero repository access, only the pasted prompt text and the listed screenshots
  - Must verify every load-bearing fact lives in the prompt text; screenshots supplement text, they never replace it
  - Must verify the redesign goal, hard constraints, out-of-scope list, and return format are explicit and actionable
  - Must classify each gap as `assembly` (orchestrator fixes from existing material) or `survey` (needs new codebase investigation) so the orchestrator can route without guessing
  - Must flag forbidden claims (see Completion) as gaps
  - Supports a Re-Check Pass: verifies only changed package sections plus previously flagged items

### runtime-explorer (optional)

- Template: `subagents/runtime-explorer-prompt.md` (shared with design-intake-workflow)
- Mode: interactive observation of a running instance (drives the UI via locally available browser automation; creates only the screenshot files its capture assignments name; does not analyze the codebase)
- Dispatched only when the operator declares Runtime Access in step 1: a running or launchable instance in a `disposable` or `dev` environment plus browser automation tooling (for example Playwright). Without that declaration, this role never runs and the workflow follows the text-only path with no loss of contract.
- Constraints:
  - Must act only against the declared instance, never production
  - Must work only the named assignments: observe questions and shot-list captures
  - Must label every result `live-app`; runtime observation supplements the code survey, it never replaces it
  - Must report states it cannot trigger as `unreachable`, not guess

## The Handoff Package

The transport is pasted text plus manually captured images, so the package has exactly two parts:

| Part | What it is |
|---|---|
| Handoff prompt | One pasteable markdown block: redesign goal, current state, tokens, constraints, pain points, out-of-scope, return format |
| Screenshot shot-list | Named screens and states the operator captures manually; each shot maps to the prompt section it illustrates |

The handoff prompt must contain all of these sections:

| Section | Purpose |
|---|---|
| Redesign Goal | What the redesign must achieve and why, in the operator's terms |
| Current State | Screens, user flows, components, interaction states, and displayed content, described in text a designer can act on without seeing the code |
| Design Tokens In Use | Concrete values from the code: palette, typography, spacing, breakpoints, radius/elevation |
| Hard Constraints | What the redesign must not break: available data per screen, backend contracts, routes, platform targets, accessibility baseline |
| Known Pain Points | Operator-stated or code-evidenced UX problems the redesign should address |
| Out of Scope | Screens, flows, and behaviors the design agent must leave alone |
| Open Points | Declared unknowns the design agent may propose answers for, each explicitly marked as unknown |
| Return Format | The exact deliverable structure to hand back (see below) |

### Return Format Section

The prompt must instruct the design agent to return:

- One markdown file: design rationale, screen-by-screen description, interaction states per screen, and every assumption it made, each marked as an assumption
- HTML mockups: one file per screen (or clearly separated sections), with each interaction state rendered or described in the markdown
- An explicit list of every current-state element it removed or intentionally chose not to address

This return format is what design-intake-workflow parses. A deliverable that follows it makes intake reliable; intake tolerates deviation, but with more friction and more operator round-trips.

## Sequence

### Per-task

1. Gather operator intent:
   - Which UI area (screens, flows) is in scope, and what prompted the redesign
   - What the redesign must achieve; constraints (brand rules, timeline, must-not-change guarantees)
   - Known pain points with the current UI
   - Explicit out-of-scope items
   - If the redesign originates from a specified product intent, include the spec as input
   - Runtime Access (optional): a running or launchable instance (URL or launch instructions), its environment classification (`disposable` or `dev`), and the browser automation tooling available. If not declared, the workflow runs the text-only path.
   - Scope one package per coherent user flow or screen cluster. If the requested scope spans more, split it into multiple workflow runs before dispatching.
2. Dispatch `ui-surveyor` per its template with the scope definition and the codebase entry points (routes, view directories) the orchestrator knows. If the surveyor reports missing inputs, fix the scope or supply the entry points and re-dispatch; do not let it guess.
3. Orchestrator reviews the survey: every in-scope screen present, every state recorded or rated `unknown`, tokens concrete. Resolve `unknown` states in order:
   - If Runtime Access is declared: dispatch `runtime-explorer` with one observe assignment per unknown state and merge the observations into the survey as `live-app` evidence. If an observation contradicts the code-based survey, record the discrepancy and escalate it to the operator; do not silently overwrite either side.
   - Ask the operator to describe or screenshot the states still unknown.
   - States still unknown after that become declared Open Points in the prompt.
   For wrong or missing coverage, re-dispatch the surveyor in a Follow-Up Pass naming the items to fix. Pre-challenge corrections and runtime-explorer dispatches do not count against the revision cap.
4. Orchestrator assembles the handoff package: the prompt with all required sections (goal, pain points, and out-of-scope come from step 1; current state, tokens, and constraints come from the survey) and the shot-list derived from the screen and state inventory.
5. Dispatch `handoff-challenger` per its template with the package and the scope definition. On a repeat pass, dispatch as a Re-Check Pass, adding the challenger's own prior report and the revised package with changed sections marked.
6. If the challenger returns `needs-info`, resolve each Missing For Review item by owner:
   - `orchestrator-context`: supply the missing package sections or survey material and re-dispatch the challenger only.
   - `operator`: escalate the goal or scope judgment. Update the package with the answer and re-dispatch the challenger.
   - Neither resolution counts against the revision cap.
7. If the challenger returns `gaps-found`, resolve each finding by its gap type:
   - `assembly` (content the survey or operator input already holds, unclear wording, forbidden claims): the orchestrator fixes the package directly; no new dispatch.
   - `survey` (screens, states, or behaviors not yet investigated): re-dispatch the surveyor in a Follow-Up Pass on the named items only, merge the returned delta, re-assemble the affected sections, then return to step 5 as a Re-Check Pass. This is one revision round.
   - Maximum revision rounds: 2. On exhaustion, escalate to the operator with the remaining gaps. The operator either accepts the package with the gaps declared as Open Points (record the acceptance) or narrows the scope (resume at step 4).
8. When the challenger returns `package-ready`, or the cap-exhaustion acceptance is recorded: if Runtime Access is declared, dispatch `runtime-explorer` with one capture assignment per shot-list entry and hand the operator the produced image files for review; shots reported `unreachable` fall back to manual capture. Then deliver the package to the operator with transport instructions: capture or verify each shot on the shot-list, paste the prompt into the design agent, attach the images, send. Record where the package file lives.
9. Mark task `ready`.

### Post-all-tasks

1. If multiple packages were produced: verify their scopes do not overlap with contradictory constraints (the same screen in two packages with different must-not-change lists). Conflicts go to the operator before any package is sent.
2. Note in the summary that the design agent's returned deliverables enter design-intake-workflow; the handoff package should be kept as intake input.
3. Mark all `ready` tasks `integrated`.

### Rules

- Steps are executed in order. No step may be skipped.
- The ui-surveyor must read actual UI source. Describing screens from file names, component names, or memory is not a survey.
- The handoff prompt must be self-contained. The design agent has no repository access, and a screenshot can fail to convey: every load-bearing fact lives in text. Screenshots illustrate; text specifies.
- The package must never ask the design agent to read code, files, or repositories, and must not depend on internal jargon the prompt does not define.
- Maximum revision rounds: 2. A round is one surveyor Follow-Up Pass plus one challenger Re-Check Pass. Orchestrator assembly fixes, needs-info resolutions, and pre-challenge corrections do not count against the cap.
- Screenshot capture is manual by default: the shot-list tells the operator exactly what to capture. When Runtime Access is declared, the runtime-explorer may capture the shot-list instead, with the operator reviewing the images before transport. Either way, the prompt must stand alone even if a shot is skipped.
- The runtime-explorer is optional and additive. No gate, section, or completion requirement may depend on it: without Runtime Access, unknown states route to the operator and screenshots stay manual, with no loss of contract. Survey facts observed live carry `live-app` evidence labels; a live-app versus source-code discrepancy is an operator finding, never silently resolved.
- The Return Format section is mandatory. A handoff prompt without it is not package-ready, because the deliverable shape is the contract that makes intake work.

## Anti-Rationalization Rules

| Excuse | Counter | Gate protected |
|---|---|---|
| "The screenshots will show them everything" | Screenshots show pixels, not behavior, states, data, or constraints. A fact that lives only in an image silently produces the wrong redesign when the image fails to convey it. | handoff-challenger |
| "The design agent will ask if something is unclear" | The transport is a paste. The design agent answers with a deliverable, not a conversation, and every round-trip costs an operator cycle. Make the package stand alone. | handoff-challenger |
| "I know this UI, no need to read the code" | Memory of the UI is not the UI. States, edge behaviors, and token drift live in the source, not in recollection. | ui-surveyor |
| "Describe the main screen, the rest is similar" | "Similar" hides exactly the differences a designer needs. Every in-scope screen gets its own description. | ui-surveyor |
| "Skip the return format, they'll produce something reasonable" | An unspecified deliverable is the root failure this workflow exists to fix. Reasonable-but-unparseable output makes intake manual again. | package assembly |
| "The challenger pass is overkill for one small screen" | Small screens with undocumented states cause the same operator round-trips as big ones. The gate is cheap; another transport cycle is not. | handoff-challenger |
| "We have browser automation, skip the code survey and just explore" | The live app shows behavior, not constraints. Data contracts, routes, tokens, and absent states live in the source. Runtime observation resolves unknowns and captures shots; it never replaces the survey. | ui-surveyor |

**Enforcement rule:** Before skipping any gate, the orchestrator must check this table. If any rule matches, the gate cannot be skipped.

## Completion

### Required

- Operator intent gathered: goal, scope, out-of-scope, constraints, pain points, each recorded or explicitly marked unknown
- Every in-scope screen surveyed from actual source, with interaction states recorded or declared unknown
- Handoff prompt contains every required section and is self-contained
- Shot-list names each screenshot (screen plus state) and the prompt section it illustrates
- Challenger returned `package-ready` on the final package, or the revision cap was reached and the operator's acceptance with declared Open Points is recorded
- Package delivered to the operator with transport instructions, and its file location recorded

### Forbidden Claims

The following may never appear in a handoff prompt:

- "see the code" (or any repository or file reference the design agent is expected to open)
- "the existing style" (without the concrete token values)
- "standard behavior" or "works as expected" (without describing the behavior)
- "self-explanatory"
- "etc." or "and so on" (inventories must be complete)
- "as shown in the screenshot" (for a fact stated nowhere in the text)
- "similar to" another screen (without stating the differences)

### Completion Self-Check

Before marking a handoff as complete, the orchestrator must verify:

1. The surveyor read the actual UI source files, not just directory listings or component names.
2. Every in-scope screen has a description and per-state coverage (`implemented`, `absent`, or `unknown` carried into Open Points).
3. Design tokens are concrete values, not adjectives.
4. All required prompt sections are present, including Return Format.
5. The challenger reviewed the final package version, not an earlier draft.
6. No forbidden claims appear in the prompt.
7. Every shot-list entry maps to a prompt section, and no prompt fact depends on a screenshot to be understood.
8. Runtime observations, if any, are labeled `live-app` in the survey, and every live-app versus source-code discrepancy was escalated to the operator, not silently resolved.

If check 1, 2, or 3 fails, re-dispatch the surveyor in a Follow-Up Pass on the affected items, then the challenger as a Re-Check Pass; this completes the original pass and does not count against the cap. If check 4, 6, or 7 fails, the orchestrator fixes the package directly and re-dispatches the challenger as a Re-Check Pass on the changed sections. If check 5 fails, re-dispatch the challenger on the final package. If check 8 fails, the orchestrator fixes the evidence labels directly or escalates the discrepancy. After any fix, re-run this self-check.

## Related Workflows

- **design-intake-workflow**: Downstream sibling. The design agent's returned deliverables enter there to become delta-grounded tasks; the handoff package (especially Current State and Return Format) travels with them as intake input.
- **product-spec-workflow**: Upstream, optional. When the redesign originates from a specified product intent, the spec feeds step 1 as operator input.
