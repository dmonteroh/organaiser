# Workflow Authoring Conventions

How the files in this catalog stay consistent: what is deliberately duplicated and must stay in sync, what may exist only once, and how repeated mechanisms are named. This file is for authoring and maintenance, including your own edits after copying workflows into a project. No workflow depends on it at runtime; every workflow and subagent template remains fully self-contained.

## Self-Contained Templates

Subagent prompt files under `subagents/` are copy/paste templates. They are dispatched into fresh agent contexts without the workflow file, and often without file access. Two consequences:

- Every rule a subagent must obey lives inline in its template. Never replace template text with a reference to another file.
- Rules that both the orchestrator enforces and the subagent obeys exist twice on purpose: once in the workflow (the enforcement side) and once in the template (the behavior side). That duplication is a feature. It is called parity here, and it is verified, never deleted.

## Contract Layers

Every runnable workflow's contract is authored across three layers: policy markdown (the workflow file and its subagent templates), a YAML manifest (stage topology and orchestration), and a JSON Schema (result and artifact syntax). Each layer is authoritative for a different concern.

| Concern | Authority |
|---|---|
| Meaning and rationale | Markdown workflow |
| Stage topology | Manifest |
| Result syntax | JSON Schema |
| Role field semantics | Role prompt |
| Runtime state | Runner database |
| Human status view | Generated board |

Authoring rule: a verdict enum is authored once, in the result schema, and copied verbatim into the template's `Verdict Rule` and the manifest's `verdicts` list. CI diffs the copies.

Some notes below cite planning codes from this project's own planning process: `P<n>` names a phase number and `D<n>` names a decision record. They are historical annotations, not part of any workflow's contract.

### Workflow ids

Thirteen workflow ids, recorded verbatim as authored in each file's frontmatter:

- `debugging-workflow`
- `decision-workflow`
- `design-handoff-workflow`
- `design-intake-workflow`
- `dev-workflow`
- `gap-analysis-workflow`
- `product-spec-workflow`
- `reliability-resiliency-workflow`
- `research-workflow`
- `roadmap-health-workflow`
- `spike-workflow`
- `task-board`
- `task-refinement`

`task-refinement` is declared in `task-refinement-workflow.md` and does not match its filename stem; the manifest name `task-refinement.v1.yaml` already depends on that spelling. All thirteen ids are unique. No id is renamed by this register.

### Role ids

Seven role ids, one per runnable template:

- `implementer`, template `subagents/implementer-prompt.md`, owned by `dev-workflow`.
- `spec-reviewer`, template `subagents/spec-reviewer-prompt.md`, owned by `dev-workflow`.
- `code-quality-reviewer`, template `subagents/code-quality-reviewer-prompt.md`, owned by `dev-workflow`.
- `analyst`, template `subagents/analyst-prompt.md`, owned by `task-refinement-workflow`.
- `architect`, template `subagents/architect-prompt.md`, owned by `task-refinement-workflow`.
- `problem-definer`, template `subagents/problem-definer-prompt.md`, owned by `product-spec-workflow`.
- `spec-challenger`, template `subagents/spec-challenger-prompt.md`, owned by `product-spec-workflow`.

Role ids are scoped to these seven runnable templates. `decision-workflow.md` uses the bare id `architect` for an orchestrator-side role with no `Template:` line; this is outside the register's uniqueness scope while `decision-workflow` has no manifest, and any later manifest for it must qualify the id.

The `integrator` role is deliberately outside this register. `runner/src/engine/scheduler.ts:770` synthesizes the string `"integrator"` for the board's fallback `integration` dispatch, and its template is `subagents/integrator-prompt.md`. No manifest stage declares the role, so it has no owning workflow `Roles` entry, no golden packet, and no manifest stage for the golden-packet parity suite to resolve. Registering it would fail `test/workflow-parity/golden.test.mjs`. Its `Runner Protocol` section is copied from `code-quality-reviewer-prompt.md` with a reworded role-identifier line, so it is also outside the `Runner Protocol` parity family below.

### Verdict enums

Each role's verdict values, copied verbatim from its template's `Verdict Rule`:

- `analyst`: `implementation-ready`, `needs-review`, `blocked`, `split-required`.
- `architect`: `all-resolved`, `needs-operator`, `needs-another-pass`, `split-required`, `superseded-by-children`, `operator-escalated`.
- `problem-definer`: `proceed`, `shelve`, `needs-research`, `needs-decision`, `needs-operator`.
- `spec-challenger`: `pass`, `gaps-found`, `needs-info`.
- `spec-reviewer`: `pass`, `fail`, `needs-info`.
- `code-quality-reviewer`: `pass`, `fail-with-severity: <level>`, `needs-info`.
- `implementer`: `verdicts: none`.
- `integrator`: `verdicts: none`. Its outcome is the flat `status` enum. See the Role ids note.

`implementer` is a producer role with no verdict enum. Its outcome is decided by the runner-owned verification barrier and the two review gates, and its `status` field is owned by the stage-result schema authored in P2.

## Deliberate Parity: Keep and Verify

A parity family is a block of contract text that exists in more than one file and must stay in sync. When you edit any member of a family, update every member in the same change, and verify by diffing the members against each other. Wording drift between members is a defect.

| Family | Members |
|---|---|
| Forbidden-claims lists | `research-workflow` with `cross-checker`; `decision-workflow` with `devils-advocate`; `gap-analysis-workflow` with `gap-challenger`; `product-spec-workflow` with `spec-challenger`; `design-intake-workflow` with `intake-challenger`; `design-handoff-workflow` with `handoff-challenger`; `reliability-resiliency-workflow` with `resiliency-challenger` (scan) and `reliability-investigator`/`failure-mapper` (producer-side ban); `roadmap-health-workflow` with `assumption-auditor` (scan) and `progress-assessor` (producer-side ban) |
| Verdict enums and gate types | Each workflow's `Roles` gate-type line with its template's `Verdict Rule` and `Output Format` verdict line |
| Gate Discipline blocks | Selected anti-rationalization rows mirrored into templates so a standalone dispatch keeps its skip-resistance (`analyst`, `architect`, `spec-reviewer`, `code-quality-reviewer`, `problem-definer`, `spec-challenger`, `researcher`, `cross-checker`, `spike-reviewer`, `investigator`, `verifier`, `implementer`) |
| Task sizing table | `task-refinement-workflow` Task Sizing Rules with `analyst` section 3 and `architect` section 6 |
| Operator question bar (4 criteria) | `task-refinement-workflow` Defaulted Decisions with `architect` section 1 and `product-spec-workflow` Operator Question Bar |
| Three required brief sections | `task-refinement-workflow` Implementer Handoff Contract with `architect` section 6 |
| Evidence standards and levels | `research-workflow` with `researcher`; `reliability-resiliency-workflow` with `reliability-investigator` section 5 and `failure-mapper` |
| Reliability dimensions, ratings, priority model | `reliability-resiliency-workflow` with `failure-mapper` |
| Delta classification enum | `design-intake-workflow` Delta Model with `design-delta-analyst` |
| Routing enum (resequence/respec/kill/add/investigate/stay-the-course) | `roadmap-health-workflow` with `assumption-auditor` |
| Owner taxonomies on `needs-info` | Each workflow's resolution step with its challenger template's Verdict Rule and Missing For Review block |
| In-scope / out-of-scope work lists | `dev-workflow` Roles with `implementer` Rules |
| Comment prohibition (two-tier severity split) | `implementer` with `spec-reviewer` (untracked-artifact citations block at the spec gate) and `code-quality-reviewer` (other violations are Important at the quality gate) |
| Missing-inputs stop rules | Workflow dispatch steps ("do not let it guess") with template HARD CONSTRAINTS ("stop and report the missing inputs") |
| Read-only constraints | Workflow `Roles` Mode lines with template HARD CONSTRAINTS |
| Scoped repeat passes | Workflow `Roles` "Supports a ... Pass" lines and dispatch steps with template pass sections |
| Identifier parity | workflow markdown frontmatter with manifest |
| Verdict parity | role prompt with result schema and manifest `verdicts` |
| Outcome parity | manifest transition with terminal outcome |
| Stage parity | none, authority `manifest (P2)` (see note below) |
| Ownership | retry cap; skip predicate; artifact schema; question schema; runner versus worker authority (see note below) |
| Runner Protocol | `implementer`, `spec-reviewer`, `code-quality-reviewer`, `analyst`, `architect`, `problem-definer`, `spec-challenger` |

Stage parity note: P1 registers no stage ids. Two known non-1:1 mapping cases are recorded here as evidence, not as members, and are not written into any workflow file. First, the proposed stage ids `architect-light`, `architect-full`, and `architect-split` (P2 proposals) all map to the single `architect` entry in `task-refinement-workflow.md`'s Roles section and to a single Sequence dispatch step, so three stages correspond to one manual step. Second, the proposed stage ids `gather-context` and `orchestrator-route` (P2 proposals) have no correspondingly named step in `product-spec-workflow.md`'s current Sequence, because both are runner-side stages.

Ownership sub-concerns, each with its authoritative layer:

- Retry cap: authority manifest, in the stage's `retry` block. Workflow prose may state the cap and names the manifest as the authority.
- Skip predicate: authority manifest, declared per stage and testable from persisted state. No workflow prose decides whether a stage is skipped.
- Artifact schema: authority JSON Schema. The manifest names which artifacts a stage requires; the schema fixes their shape.
- Question schema: authority JSON Schema, `open-question.schema.json`. Workflow prose states when to ask; the schema fixes the field set.
- Runner versus worker authority: authority manifest, in the stage's `authority` field. The role prompt restates the boundary for the worker and names the manifest as the authority.

## One Rule, One Home

Within a single file, each rule has exactly one owner section; every other mention is a short reference to it, or is deleted. Restating a rule in three sections does not enforce it three times; it creates three copies that drift.

Homes, by rule type:

- Loop caps, cap exemptions, and round definitions live in the workflow's `Rules` section. Sequence steps reference the cap ("if the cap is reached"); they do not restate its number or exemption list.
- For the three runnable workflows, loop caps live in the manifest's `retry` and `caps` blocks; the workflow's `Rules` section states the cap in prose and names the manifest as the authority.
- A procedure lives in the section that defines it (a barrier step, a named convention section). Later steps reference it.
- Checklists (`Completion` Required, `Completion Self-Check`, `Dispatch Gate`) verify rules. A checklist item may name the fields it checks, but it never restates a rule's full definition or condition; it points at the owning step or section.
- A template's `Verdict Rule` clause that prevents misgrading (for example, what does not count toward a verdict) is part of the enum's interface, not a restatement.
- Anti-rationalization rows are quality contracts and stay inline and full-length; they are the recorded counter-argument, not duplication of the gate they protect.

## Scoped Repeat Passes

One mechanism, three role-based names:

- **Follow-Up Pass**: evidence producers re-investigating named gaps (researcher, explorer, investigator roles, assessors, analysts, surveyors).
- **Revision Pass**: artifact producers revising a draft against named findings (mappers, problem-definer).
- **Re-Check Pass**: adversarial checkers re-verifying only changed items plus their own prior findings (challengers, cross-checker, verifier).

Every pass follows the same shape: inputs include the subagent's own prior report; work only the named or changed items; return a delta; never restate unchanged findings. The pass scoping is what makes revision caps enforceable (a capped round is defined by these passes), so it is contract, not optional token hygiene.

## Open Items

Recorded asymmetries and pending decisions, so audits do not rediscover them:

- Gate Discipline blocks are absent from `explorer`, `evaluator`, `devils-advocate`, `coverage-mapper`, `gap-challenger`, `design-delta-analyst`, `ui-surveyor`, `intake-challenger`, `handoff-challenger`, and the health-cluster templates. Whether each omission is deliberate has not been decided.
- No subagent-side forbidden-claims scan exists for `spike-workflow`, `debugging-workflow`, `dev-workflow`, or `task-refinement-workflow`; their lists are enforced by the orchestrator self-check alone.
- `spike-reviewer` handles follow-up input as inline prose instead of a named pass section.
- Repeat-pass naming outliers pending alignment: `evaluator` (Re-Evaluation Pass), `investigator` (Follow-up Rounds), `devils-advocate` (unnamed repeat handling), `problem-definer` (lowercase "revision passes").
- Read-only HARD CONSTRAINT wording is now byte-identical across the four read-only runnable templates (`spec-reviewer`, `code-quality-reviewer`, `analyst`, `spec-challenger`); it still varies among read-only-flavored non-runnable templates, for example `handoff-challenger` and `reliability-investigator`.
- Trial-gated removal candidates (kept until a trial run shows they are no longer needed): the implementer edit-hygiene and re-read-the-brief rules, the "running low on context" anti-rationalization rows, the Enforcement-rule sentence under every Anti-Rationalization table (it duplicates "No step may be skipped"), the roadmap-health rows that argue whether to run the workflow at all, the spike "clean up later" row, and the verification-log Purpose rationale in `dev-workflow`.
- The nine manual-only workflows have no manifest, by decision D3.
