# Task Board: organaiser runner

Status only. No narrative. Rationale, findings, and evidence go in each task's refinement log, follow-ups file, or verification log next to its brief. This board is the manual-mode source of truth until the runner's `board import-markdown` replaces it. Keep the table shapes below unchanged so the importer can read them later.

Destination branch: `feat/organaiser-runner` (create from `main` after `feat/workflow-conventions` is merged).
Briefs: `tmp/new-workflow-version/05-briefs/`. Refinement writes `<brief>-refinement-log.md`, `<brief>-follow-ups.md`, and `<brief>-verification.log` next to each brief.
Plan: `tmp/new-workflow-version/README.md` (read `00-decisions.md` and `04-phase-plan.md` before refining any task).

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `drafted` | Brief exists, not refined |
| `refining` | Refinement dispatched |
| `umbrella` | Split into children, not dispatchable |
| `implementation-ready` | Refined, Dispatch Gate passes |
| `blocked` | A dependency or decision holds it |
| `in-progress` | Implementer dispatched |
| `in-review` | Spec or quality review in flight |
| `integrated` | Merged to the destination branch, worktree removed |
| `parked` | Gate cap reached, awaiting operator |
| `superseded` | Replaced by other tasks |

## Decisions

| Id | Decision | Status |
| --- | --- | --- |
| Q2 | Node floor `>=24.16.0`, CI matrix `24.x` | `confirmed` |
| Q3 | `ajv` is the runner's only runtime dependency | `confirmed` |
| Q5 | Claude `--permission-mode auto`, Codex `--full-auto`; reviewers read-only | `confirmed` |
| Q6 | Manifests for the nine manual-only workflows ship this version, scheduled last | `confirmed` |
| Q9 | Moot: Q13 drops the only consumer of `order.csv`. Other Ralph assets stay synthetic | `confirmed` |
| Q10 | Supervisor polls at `waiting-operator` for a bounded window, holding no worker open | `confirmed` |
| Q12 | Per-vendor overlay files configured in `orga.yaml` | `confirmed` |
| Q13 | `board import-csv` dropped, P4.10 superseded | `confirmed` |
| D16 | Repository and package `organaiser`, command `orga` | `confirmed` |
| D17 | Committed `orga.yaml` and `orgaw`, everything else under gitignored `.orga/` | `confirmed` |

## Tasks

Order: P0, then P1, then P2. P3 and P4 may run in parallel after P2 and P0. P5 after P2 and P4. P6 and P7 in parallel after P5. P8 after P6 and P7. P9 after P8. P10 last, added by operator answer Q6. Refinement may run in parallel for any row.

Every phase brief is an umbrella and is expected to split. Add one row per child under its parent, keyed `<parent>.<n>` (for example `P5.1`), with its own brief file in `05-briefs/`.

| Id | Title | Brief | Status | Depends on | Parallel | Claims | Branch |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | Scaffold the TypeScript runner package | `05-briefs/P0-scaffold.md` | `integrated` | none | no | `runner/`, `.github/workflows/`, `.gitignore` | `feat/organaiser-runner` |
| P1 | Stable identifiers and parity CI | `05-briefs/P1-identifiers-and-parity.md` | `umbrella` | P0 | no | `workflows/*.md` frontmatter, `workflows/conventions.md`, `test/workflow-parity/` | |
| P1.1 | Contract layers and the identifier register | `05-briefs/P1.1-identifier-register.md` | `integrated` | P0 | no | `workflows/conventions.md` | `feat/organaiser-runner` |
| P1.2 | Runner frontmatter on the three runnable workflows | `05-briefs/P1.2-runnable-frontmatter.md` | `integrated` | P1.1 | with P1.3 | `workflows/dev-workflow.md`, `workflows/task-refinement-workflow.md`, `workflows/product-spec-workflow.md` | `feat/organaiser-runner` |
| P1.3 | Runner frontmatter on the nine manual-only workflows | `05-briefs/P1.3-manual-only-frontmatter.md` | `integrated` | P1.1 | with P1.2 | the nine manual-only `workflows/*-workflow.md` | `feat/organaiser-runner` |
| P1.4 | Static parity test and its CI job | `05-briefs/P1.4-static-parity-test.md` | `integrated` | P1.2, P1.3 | no | `test/workflow-parity/`, `.github/workflows/ci.yml` | `feat/organaiser-runner` |
| P2 | Schemas and manifests for the runnable subset | `05-briefs/P2-schemas-and-manifests.md` | `integrated` | P1 | no | `workflows/schemas/`, `workflows/manifests/`, `test/workflow-parity/` | |
| P2a | JSON Schemas for the runnable subset | `05-briefs/P2a-schemas.md` | `integrated` | P1 | no | `workflows/schemas/` | `feat/organaiser-runner` |
| P2b | Manifests for the runnable subset and verdict parity | `05-briefs/P2b-manifests.md` | `integrated` | P2a | no | `workflows/manifests/`, `test/workflow-parity/static.test.mjs` | |
| P2b-i | Product-spec and task-refinement manifests | `05-briefs/P2b-i-product-spec-and-refinement-manifests.md` | `integrated` | P2a | with P2b-ii, P2b-iii | `workflows/manifests/product-spec.v1.yaml`, `workflows/manifests/task-refinement.v1.yaml` | `feat/organaiser-runner` |
| P2b-ii | Development and integration manifests | `05-briefs/P2b-ii-development-and-integration-manifests.md` | `integrated` | P2a | with P2b-i, P2b-iii | `workflows/manifests/development.v1.yaml`, `workflows/manifests/integration.v1.yaml` | `feat/organaiser-runner` |
| P2b-iii | Task-board manifest | `05-briefs/P2b-iii-task-board-manifest.md` | `integrated` | P2a | with P2b-i, P2b-ii | `workflows/manifests/task-board.v1.yaml` | `feat/organaiser-runner` |
| P2b-iv | Static-test transition and verdict parity | `05-briefs/P2b-iv-static-test-parity-extension.md` | `integrated` | P2b-i, P2b-ii, P2b-iii | no | `test/workflow-parity/static.test.mjs` | `feat/organaiser-runner` |
| P2c | State-machine model tests over the manifests | `05-briefs/P2c-model-tests.md` | `integrated` | P2b | no | `test/workflow-parity/model.test.mjs` | `feat/organaiser-runner` |
| P3 | Workflow prose and template edits | `05-briefs/P3-workflow-and-template-edits.md` | `superseded` | P2 | with P4 | `workflows/dev-workflow.md`, `workflows/task-refinement-workflow.md`, `workflows/product-spec-workflow.md`, `workflows/task-board-workflow.md`, `workflows/conventions.md`, seven runnable templates, `test/workflow-parity/golden/` | |
| P3a | Development workflow and its three templates | `05-briefs/P3a-dev-cluster.md` | `integrated` | P2 | with P3b, P3c, P3d-i | `workflows/dev-workflow.md`, `workflows/subagents/implementer-prompt.md`, `workflows/subagents/spec-reviewer-prompt.md`, `workflows/subagents/code-quality-reviewer-prompt.md` | `feat/organaiser-runner` |
| P3b | Task-refinement workflow and its two templates | `05-briefs/P3b-refinement-cluster.md` | `integrated` | P2 | with P3a, P3c, P3d-i | `workflows/task-refinement-workflow.md`, `workflows/subagents/analyst-prompt.md`, `workflows/subagents/architect-prompt.md` | `feat/organaiser-runner` |
| P3c | Product-spec workflow and its two templates | `05-briefs/P3c-product-spec-cluster.md` | `integrated` | P2 | with P3a, P3b, P3d-i | `workflows/product-spec-workflow.md`, `workflows/subagents/problem-definer-prompt.md`, `workflows/subagents/spec-challenger-prompt.md` | `feat/organaiser-runner` |
| P3d-i | The task-board workflow and its registry consequences | `05-briefs/P3d-i-task-board-workflow.md` | `integrated` | P2 | with P3a, P3b, P3c | `workflows/task-board-workflow.md`, `workflows/conventions.md` Workflow ids register, `test/workflow-parity/static.test.mjs` | `feat/organaiser-runner` |
| P3d-ii | Golden packet fixtures and their test | `05-briefs/P3d-ii-golden-packets.md` | `integrated` | P3a, P3b, P3c | no | `test/workflow-parity/golden/`, `test/workflow-parity/golden.test.mjs` | `feat/organaiser-runner` |
| P3e | Conventions reconciliation and the cross-child parity diff | `05-briefs/P3e-conventions-reconciliation.md` | `integrated` | P3a, P3b, P3c, P3d-i, P3d-ii | no | `workflows/conventions.md` | `feat/organaiser-runner` |
| P4 | Ralph v2 extraction with characterization tests | `05-briefs/P4-ralph-extraction.md` | `integrated` | P0 | with P3 | `runner/src/`, `runner/test/` | |
| P4.1 | Process supervisor and the shared test workspace helper | `05-briefs/P4.1-process-supervisor.md` | `integrated` | P0 | no | `runner/src/adapters/process-supervisor.ts`, `runner/test/helpers/workspace.ts` | `feat/organaiser-runner` |
| P4.2 | Transition predicates from the pure acceptance function | `05-briefs/P4.2-predicates.md` | `integrated` | P4.1 | wave 2 | `runner/src/engine/predicates.ts` | `feat/organaiser-runner` |
| P4.3 | Accreting evidence store from the ledger | `05-briefs/P4.3-evidence.md` | `integrated` | P4.1 | wave 2 | `runner/src/store/evidence.ts` | `feat/organaiser-runner` |
| P4.4 | Read-only git helpers | `05-briefs/P4.4-git-reads.md` | `integrated` | P4.1 | wave 2 | `runner/src/git/git.ts` | `feat/organaiser-runner` |
| P4.5 | Report validator off TypeBox, and the legacy contract importer | `05-briefs/P4.5-report-validator.md` | `integrated` | P4.1 | wave 2 | `runner/src/compile/report-validator.ts`, `runner/src/board/legacy-import.ts` | `feat/organaiser-runner` |
| P4.6 | Claude and Codex command builders and stream extractors | `05-briefs/P4.6-vendor-command-builders.md` | `integrated` | P4.1 | wave 2 | `runner/src/adapters/claude.ts`, `runner/src/adapters/codex.ts` | `feat/organaiser-runner` |
| P4.7 | Runner-owned verification with declared checks | `05-briefs/P4.7-verification.md` | `integrated` | P4.1, P4.5 | wave 3 | `runner/src/engine/verification.ts` | `feat/organaiser-runner` |
| P4.8 | Artifact, role-binding, and dispatch-log validation | `05-briefs/P4.8-artifact-validator.md` | `integrated` | P4.1, P4.5 | wave 3 | `runner/src/compile/artifact-validator.ts` | `feat/organaiser-runner` |
| P4.9 | Replay over artifact references, with a relocatable fixture | `05-briefs/P4.9-replay-and-artifact-refs.md` | `integrated` | P4.1, P4.2, P4.3, P4.4 | wave 3 | `runner/src/reports/replay.ts`, `runner/src/store/artifact-ref.ts` | `feat/organaiser-runner` |
| P4.10 | Legacy CSV queue importer | `05-briefs/P4.10-legacy-csv.md` | `superseded` | P4.1 | n/a | `runner/src/board/legacy-csv.ts` | |
| P4.11 | Configuration surface with file precedence | `05-briefs/P4.11-cli-config.md` | `integrated` | P4.1 | wave 2 | `runner/src/cli/config.ts` | `feat/organaiser-runner` |
| P5 | Store, supervisor, serial scheduler, fake adapter | `05-briefs/P5-runner-core.md` | `superseded` | P2, P4 | no | none | |
| P5a | Store, shared types, event journal, project bootstrap | `05-briefs/P5a-store.md` | `integrated` | P2, P4 | first, alone | `runner/src/store/types.ts`, `runner/src/store/migrations.ts`, `runner/src/store/db.ts`, `runner/src/store/events.ts`, `runner/src/store/init.ts`, `runner/test/store-db.test.ts`, `runner/test/store-events.test.ts`, `runner/test/store-init.test.ts` | `feat/organaiser-runner` |
| P5b | Run lease, detached supervisor, tick shell, startup reconciliation | `05-briefs/P5b-lease-and-supervisor.md` | `integrated` | P5a | with P5c | `runner/src/store/lease.ts`, `runner/src/engine/tick.ts`, `runner/src/engine/reconcile.ts`, `runner/src/engine/supervisor.ts`, `runner/src/engine/supervisor-spawn.ts`, `runner/test/lease.test.ts`, `runner/test/tick-shell.test.ts`, `runner/test/supervisor-detach.test.ts`, `runner/test/reconcile.test.ts` | `task/P5b` |
| P5c | Process adapter contract, fake adapter, packet compiler | `05-briefs/P5c-fake-adapter-and-compiler.md` | `integrated` | P2, P4 | with P5b | `runner/src/adapters/adapter.ts`, `runner/src/adapters/fake.ts`, `runner/src/compile/packet.ts`, `runner/evals/fake-bin/`, `runner/test/fake-adapter.test.ts`, `runner/test/packet-compiler.test.ts` | `feat/organaiser-runner` |
| P5d | Serial fixed-point scheduler, board predicates, atomic dispatch | `05-briefs/P5d-scheduler.md` | `integrated` | P5a, P5b, P5c | with P5e | `runner/src/engine/board-predicates.ts`, `runner/src/engine/predicate-registry.ts`, `runner/src/engine/dispatch.ts`, `runner/src/engine/scheduler.ts`, `runner/src/engine/supervisor.ts` (one line), `runner/test/board-predicates.test.ts`, `runner/test/dispatch-idempotency.test.ts`, `runner/test/scheduler.test.ts` | `task/P5d` |
| P5e | Pause, cancel, kill, and the process-group termination sequence | `05-briefs/P5e-pause-cancel-kill.md` | `integrated` | P5a, P5b | with P5d | `runner/src/adapters/process-group.ts`, `runner/src/adapters/process-supervisor.ts` (extraction), `runner/src/engine/termination.ts`, `runner/src/engine/control-commands.ts`, `runner/src/engine/supervisor.ts` (one line), `runner/test/termination.test.ts`, `runner/test/pause-cancel.test.ts`, `runner/test/kill.test.ts` | `feat/organaiser-runner` |
| P5f | CLI command surface, exit codes, and the Stage A fixture suite | `05-briefs/P5f-cli-and-fixtures.md` | `integrated` | P5a, P5b, P5c, P5d, P5e | no, strictly last | `runner/bin/orga.ts`, `runner/src/cli/exit-codes.ts`, `runner/src/cli/commands.ts`, `runner/src/cli/dry-run.ts`, `runner/evals/fixtures/`, `runner/test/cli.test.ts`, `runner/test/fixtures.test.ts` | `feat/organaiser-runner` |
| P6 | Claude and Codex adapters, doctor, live single task | `05-briefs/P6-vendor-adapters.md` | `superseded` | P5 | with P7 | none | |
| P6a | Vendor profiles, readiness probe, and `orga doctor` | `05-briefs/P6a-vendor-profiles-and-doctor.md` | `integrated` | P5 | with P6b, P7 | `runner/src/cli/yaml.ts`, `runner/src/cli/profiles.ts`, `runner/src/cli/doctor.ts`, `runner/src/adapters/probe.ts`, `runner/src/adapters/probe-io.ts`, `runner/src/adapters/known-bad.json`, `runner/evals/fixtures/12-known-bad-version-refused.ts`, `runner/test/vendor-profiles-and-doctor.test.ts`, `runner/src/cli/commands.ts` (dispatch row only) | `feat/organaiser-runner` |
| P6b | Vendor-neutral adapter substrate, classifier, capture format | `05-briefs/P6b-vendor-adapter-substrate.md` | `integrated` | P5 | with P6a, P7 | `runner/src/adapters/jsonl.ts`, `runner/src/adapters/classify.ts`, `runner/src/adapters/vendor-adapter.ts`, `runner/src/adapters/captures.ts`, `runner/evals/fixtures/13-adapter-stream-cases.ts`, `runner/test/fixtures/adapter-substrate/`, `runner/test/adapter-substrate.test.ts` | `feat/organaiser-runner` |
| P6c | Claude adapter and captures | `05-briefs/P6c-claude-adapter-and-captures.md` | `integrated` | P6a, P6b | with P6d, P7 | `runner/src/adapters/claude-adapter.ts`, `runner/evals/captures/claude/2.1.245/`, `runner/test/claude-adapter.test.ts` | `feat/organaiser-runner` |
| P6d | Codex adapter and captures | `05-briefs/P6d-codex-adapter-and-captures.md` | `integrated` | P6a, P6b | with P6c, P7 | `runner/src/adapters/codex-adapter.ts`, `runner/evals/captures/codex/0.46.0/`, `runner/test/codex-adapter.test.ts` | `feat/organaiser-runner` |
| P6e | Adapter selection, P6 fixture registration, `live-single-task` | `05-briefs/P6e-live-single-task.md` | `integrated` | P6a, P6b, P6c, P6d | no | `runner/src/adapters/select.ts`, `runner/evals/fixtures/14-live-single-task.ts`, `runner/evals/registry.json`, `runner/test/adapter-selection.test.ts`, `runner/src/engine/scheduler.ts` (three named regions), `runner/src/engine/supervisor.ts` (tick-body construction only), `runner/test/fixtures.test.ts` (added registrations only) | `feat/organaiser-runner` |
| P6f | Claude vendor adapter: fix the `--json-schema` argument | `05-briefs/P6f-claude-json-schema-fix.md` | `integrated` | P6b, P6c | with P6g | `runner/src/adapters/vendor-adapter.ts`, `runner/src/adapters/claude-adapter.ts`, `runner/test/claude-adapter.test.ts` | `feat/organaiser-runner` |
| P6g | Live dispatch packet: wire a real packet and complete AC7 | `05-briefs/P6g-live-dispatch-packet.md` | `integrated` | P6e, P5c, P6f, P7c-i, P7c-ii | no | `runner/src/engine/scheduler.ts` (implementation branch only), `runner/evals/fixtures/14-live-single-task.ts`, `runner/src/compile/dispatch-packet-input.ts`, `runner/test/scheduler.test.ts`, `runner/evals/fixtures/03-board-not-drained.ts` | `feat/organaiser-runner` |
| P7 | Worktrees, claims, verification barrier, reviews, integration | `05-briefs/P7-git-and-gates.md` | `umbrella` | P5 | with P6 | none | |
| P7a | Worktree lifecycle, workspace seam, and claim validation | `05-briefs/P7a-worktrees-and-claims.md` | `superseded` | P5 | with P7b | none | |
| P7a-i | Worktree lifecycle, the workspace mode seam, and claim validation | `05-briefs/P7a-i-workspace-and-claims-library.md` | `integrated` | P5 | with P7b | `runner/src/git/workspace.ts`, `runner/src/git/claims.ts`, `runner/test/workspace.test.ts`, `runner/test/claims.test.ts`, `runner/src/cli/config.ts`, `runner/test/config.test.ts` | `feat/organaiser-runner` |
| P7a-ii | Real dispatch eligibility and the scheduler's workspace wiring | `05-briefs/P7a-ii-dispatch-eligibility-and-workspace-wiring.md` | `integrated` | P7a-i | with P7b | `runner/src/engine/dispatch.ts`, `runner/src/engine/scheduler.ts`, `runner/test/dispatch-idempotency.test.ts`, `runner/test/scheduler.test.ts` | `feat/organaiser-runner` |
| P7a-iii | Operator-checkout invariant helper and the two worktree fixtures | `05-briefs/P7a-iii-checkout-invariant-and-worktree-fixtures.md` | `integrated` | P7a-ii | with P7b | `runner/evals/fixtures/11-out-of-claim-write.ts`, `runner/evals/fixtures/12-unrelated-dirty-checkout.ts`, `runner/evals/fixtures/harness.ts`, `runner/evals/fixtures/test-supervisor.ts`, `runner/test/fixtures.test.ts` (added registrations only) | |
| P7b | Runner-owned verification barrier | `05-briefs/P7b-verification-barrier.md` | `integrated` | P5 | with P7a | `runner/src/engine/barrier.ts`, `runner/test/barrier.test.ts` | `feat/organaiser-runner` |
| P7c | `development.v1` stage machine, fresh-session reviews, repairs, idempotent minors | `05-briefs/P7c-reviews-repairs-and-minors.md` | `superseded` | P7a-iii, P7b | no | none | |
| P7c-i | The `development.v1` mirror and the stage driver | `05-briefs/P7c-i-development-mirror-and-stage-driver.md` | `integrated` | P7a-iii, P7b | no | `runner/src/engine/workflow-stages.ts`, `runner/test/workflow-stages.test.ts` | `feat/organaiser-runner` |
| P7c-ii | Durable gate caps and the scheduler's `implementation` wiring | `05-briefs/P7c-ii-gate-durability-and-scheduler-wiring.md` | `integrated` | P7c-i | no | `runner/src/engine/scheduler.ts` (four named regions), `runner/src/engine/workflow-stages.ts`, `runner/test/scheduler.test.ts`, `runner/test/gate-caps.test.ts`, `runner/evals/fixtures/13-gate-caps.ts`, `runner/test/fixtures.test.ts` (added registration only) | `feat/organaiser-runner` |
| P7c-iii | Fresh-session reviewer worktrees and finding routing | `05-briefs/P7c-iii-fresh-session-reviews-and-finding-routing.md` | `integrated` | P7c-ii | no | `runner/src/engine/review-stages.ts`, `runner/test/review-stages.test.ts`, `runner/src/engine/workflow-stages.ts`, `runner/evals/fixtures/14-review-gates.ts`, `runner/evals/fixtures/15-fresh-reviewer.ts`, `runner/test/fixtures.test.ts` (added registrations only) | `feat/organaiser-runner` |
| P7c-iv | The idempotent minor-findings append | `05-briefs/P7c-iv-idempotent-minor-findings-append.md` | `integrated` | P7c-iii | no | `runner/src/engine/minor-findings.ts`, `runner/test/minor-findings.test.ts`, `runner/src/store/migrations.ts` (version 2), `runner/src/engine/workflow-stages.ts`, `runner/src/cli/config.ts`, `runner/evals/fixtures/16-minor-findings.ts`, `runner/test/fixtures.test.ts`, `runner/test/store-db.test.ts` | `feat/organaiser-runner` |
| P7d | `integration.v1` execution, compare-and-swap, conflicts, cleanup | `05-briefs/P7d-integration.md` | `integrated` | P7a-iii, P7b, P7c-iv | no | `runner/src/git/integrate.ts`, `runner/src/engine/integration-stages.ts`, `runner/test/integrate.test.ts`, `runner/test/integration-stages.test.ts`, `runner/evals/fixtures/17-destination-and-conflict.ts`, `runner/evals/fixtures/18-cleanup-and-recovery.ts`, `runner/src/engine/scheduler.ts`, `runner/test/fixtures.test.ts` | `feat/organaiser-runner` |
| P7e | The `in-place` workspace mode | `05-briefs/P7e-in-place-mode.md` | `superseded` | P7a-i, P7c-iv, P7d | no, strictly last | none | |
| P7e-i | The workspace-mode selector | `05-briefs/P7e-i-workspace-mode-selector.md` | `integrated` | P7a, P7c, P7d | no | `runner/src/cli/config.ts`, `runner/src/engine/scheduler.ts` (one field, one call site), `runner/evals/fixtures/harness.ts` (one type), `runner/evals/fixtures/test-supervisor.ts`, `runner/test/config.test.ts`, `runner/test/scheduler.test.ts` | `feat/organaiser-runner` |
| P7e-ii | The `in-place` mode body (implementation-stage half) | `05-briefs/P7e-ii-in-place-mode.md` | `integrated` | P7e-i, P7a, P7c, P7d | no | `runner/src/git/in-place.ts`, `runner/test/in-place.test.ts`, `runner/evals/fixtures/19-in-place.ts`, `runner/src/git/workspace.ts` (one branch), `runner/src/cli/commands.ts`, `runner/test/fixtures.test.ts` | `feat/organaiser-runner` |
| P7e-iii | The `in-place` mode's integration and review path | `05-briefs/P7e-iii-in-place-integration.md` | `integrated` | P7e-ii, P7c, P7d | no, strictly last | `runner/src/engine/integration-stages.ts`, `runner/src/git/integrate.ts`, `runner/src/engine/scheduler.ts` (routing hardcode), `runner/test/integration-stages.test.ts`, `runner/test/integrate.test.ts`, `runner/evals/fixtures/19-in-place.ts` | `feat/organaiser-runner` |
| P8 | Board workflow, renderer, importer, parallel scheduling | `05-briefs/P8-board-and-parallelism.md` | `umbrella` | P6, P7 | no | none | |
| P8a | Board schema validation and the renderer | `05-briefs/P8a-board-validate-and-render.md` | `integrated` | P6, P7 | no | `runner/src/board/schema.ts`, `runner/src/board/validate.ts`, `runner/src/board/render.ts`, `runner/src/cli/commands.ts`, `runner/src/engine/scheduler.ts`, `runner/test/board-validate.test.ts`, `runner/test/board-render.test.ts`, `runner/test/scheduler.test.ts` | `feat/organaiser-runner` |
| P8b | The `board import-markdown` migration command | `05-briefs/P8b-board-import-markdown.md` | `integrated` (real-world backtick-cell gap recorded as a follow-up, needs its own refinement) | P6, P7 | with P8a | `runner/src/board/import-markdown.ts`, `runner/src/cli/commands.ts`, `runner/test/import-markdown.test.ts` | `feat/organaiser-runner` |
| P8b-i | `board import-markdown` reads the real board's backticked cells | `05-briefs/P8b-i-import-markdown-backtick-cells.md` | `in-progress` | P8b | with P8c-i-a review | `runner/src/board/import-markdown.ts`, `runner/test/import-markdown.test.ts`, one new checked-in board fixture | `task/P8b-i` |
| P8c-i | Dispatch eligibility + disjoint-claim concurrency | `05-briefs/P8c-i-dispatch-eligibility-and-concurrency.md` | `superseded` (further split in progress: file-count cap breach found) | P6, P7 | with P8c-ii | | |
| P8c-ii | Split-transaction + staleness routing | `05-briefs/P8c-ii-split-transaction-and-staleness.md` | `implementation-ready` (waits for P8c-i-a and P8c-i-b, both touch `scheduler.ts`) | P6, P7 | no, shares `scheduler.ts` with both P8c-i-a and P8c-i-b | `runner/src/store/migrations.ts`, `runner/src/store/types.ts`, `runner/src/engine/task-split.ts`, `runner/src/engine/scheduler.ts`, `runner/src/engine/artifact-staleness.ts`, `runner/evals/fixtures/21-task-split.ts`, `runner/evals/fixtures/22-artifact-staleness.ts`, `runner/test/fixtures.test.ts`, `runner/test/task-split.test.ts`, `runner/test/artifact-staleness.test.ts` | |
| P8c-i-a | Dispatch eligibility predicates (DB-derived) | `05-briefs/P8c-i-a-dispatch-eligibility-predicates.md` | `in-review` | P6, P7 | before P8c-i-b and P8c-ii (all touch `scheduler.ts`) | `runner/src/adapters/probe.ts`, `runner/src/cli/doctor.ts`, `runner/src/cli/config.ts`, `runner/src/engine/dispatch.ts`, `runner/src/engine/board-predicates.ts`, `runner/src/engine/scheduler.ts`, `runner/test/dispatch-idempotency.test.ts`, `runner/test/board-predicates.test.ts`, `runner/test/config.test.ts`, `runner/test/adapter-selection.test.ts` (undeclared, mechanical follow-up fix — see brief's follow-ups file) | `task/P8c-i-a` |
| P8c-i-b | Concurrent dispatch (live-attempt collection) + fixtures | `05-briefs/P8c-i-b-concurrent-dispatch-and-fixtures.md` | `implementation-ready` (waits for P8c-i-a) | P8c-i-a | no | `runner/src/engine/scheduler.ts`, `runner/evals/fixtures/harness.ts`, `runner/evals/fixtures/20-board-parallelism.ts`, `runner/test/fixtures.test.ts`, `runner/test/scheduler.test.ts`, `runner/test/adapter-selection.test.ts`, `runner/evals/fixtures/07-stale-running-recovery.ts` | |
| P8d | The `live-board-drain` proof | `05-briefs/P8-board-and-parallelism.md` | `blocked` (needs P8c-i-b's concurrency shape before refinement can finalize) | P8c-i-b | no, last | | |
| P9 | Operator commands, eval tiers, compatibility report, README, examples | `05-briefs/P9-operations-and-evals.md` | `drafted` | P8 | no | `runner/src/cli/`, `runner/evals/`, `README.md`, `examples/`, `.github/workflows/` | |
| P10 | Manifests for the nine manual-only workflows | `05-briefs/P10-manual-only-manifests.md` | `drafted` | P9 | no | `workflows/manifests/`, `workflows/schemas/`, the nine manual-only `workflows/*-workflow.md` frontmatter, `test/workflow-parity/` | |

## Update rules

- Change a row's `Status` and `Branch` only. Do not add columns or prose.
- When a task splits, set the parent to `umbrella` and insert child rows directly under it with their own briefs.
- When a task reaches `integrated`, its worktree is removed and its branch deleted in the same update.
- A `parked` row names nothing here. The open question goes in the task's refinement log and in the run's open-questions file.
- Confirming a defaulted decision changes its `Status` to `confirmed`. A changed answer re-enters refinement for the rows it affects.
