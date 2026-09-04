---
id: task-board
name: Task Board Workflow
triggers: [task-board, board-drain, board-composition]
contractVersion: 1.0.0
runnerManifest: manifests/task-board.v1.yaml
resultSchema: schemas/stage-result.schema.json
manualMode: supported
runnerMode: supported
---

# Task Board Workflow Contract

The board-level composition contract. It owns the stage chain a task walks from admission to a terminal outcome: dependency release, claim locking, batching, product specification, task refinement, implementation, integration, and reconciliation. Individual workflows never redefine this chain or the board-drain loop; they own only the internal stages of the work a task performs once the board has admitted it. A manual orchestrator can drain a small board by reading this file alone.

## Stages

### admit-task

Validates a task against the `entry-artifacts-valid` predicate before it enters the board at all. A task that fails this check never becomes a board stage; it routes straight to `reconcile-outcome`. A task that passes carries no state of its own here, it is simply cleared to enter `release-dependencies`.

### release-dependencies

See Dependency Release below.

### acquire-claims

See Claim Locking below.

### admit-to-batch

See Batching below.

### product-specification

Runs the `product-spec-outcome` predicate. A task that does not require product specification receives a `skipped` verdict and advances directly to `task-refinement`, the same destination as a `specified` verdict; skipping is a verdict of this stage, not a separate stage. A `shelved`, `needs-research`, `needs-decision`, or `needs-operator` verdict routes to `reconcile-outcome`. This stage's internal rules (evidence discipline, the operator question bar, the revision loop) are owned by `product-spec-workflow`; this file references that ownership and restates none of it.

### task-refinement

Runs the `refinement-outcome` predicate. A `skipped` or `ready-to-implement` verdict advances to `implementation`. A `superseded` or `parked` verdict routes to `reconcile-outcome`. This stage's internal rules (the analyst and architect pattern, sizing limits, the fast path) are owned by `task-refinement-workflow`; this file references that ownership and restates none of it.

### implementation

Runs the `implementation-outcome` predicate. An `integrating` verdict advances to `integration-candidate`. A `waiting-operator` or `parked` verdict routes to `reconcile-outcome`. This single board stage folds in the runner verification, specification review, and code-quality review that `manifests/development.v1.yaml` performs across its `verify-task`, `review-spec`, and `review-quality` stages; all of it is governed by `dev-workflow.md`. This file references that ownership and restates none of its gate rules.

### integration-candidate

Runs the `integration-slot-available` predicate. It loops on itself until a slot is available, then advances to `integration`.

### integration

Runs the `integration-outcome` predicate. An `integrated` verdict routes to `reconcile-outcome`. A `ready-to-implement` verdict sends the task back to `implementation`. A `waiting-operator` or `parked` verdict routes to `reconcile-outcome`. This single board stage folds in the integration verification and destination advance that `manifests/integration.v1.yaml` performs across its `verify-candidate` and `advance-destination` stages; both are also governed by `dev-workflow.md`. This file references that ownership and restates none of its gate rules.

### reconcile-outcome

Runs the `terminal-disposition` predicate and maps a task's verdict onto a declared terminal outcome: see Terminal Conditions below.

## Dependency Release

The `release-dependencies` stage runs the `dependencies-satisfied` predicate. A task holds here, looping on itself, until every task or artifact it depends on has cleared; only then does it advance to `acquire-claims`. No task enters claim locking with an unmet dependency.

## Claim Locking

The `acquire-claims` stage runs the `claims-available` predicate. A task holds here, looping on itself, until it can acquire an exclusive claim on the files or resources its work will touch. Claims prevent two tasks from admitting to the same batch with overlapping write scope; a task without an available claim waits rather than admits.

## Batching

The `admit-to-batch` stage runs the `batch-slot-available` predicate. A task holds here, looping on itself, until a batch slot opens, then advances to `product-specification`. Batch sizing is a board-level concern: it bounds how many tasks are in flight together, independent of any single task's own sizing budget.

## Operator Questions

A task that needs operator input does not block the board. It routes to `reconcile-outcome` with a `waiting-operator` verdict, one of the attention terminal outcomes, and the board continues draining unrelated tasks. Operator questions raised while a task is at `product-specification`, `task-refinement`, or `implementation` are batched rather than answered one at a time mid-stage; the owning workflow for that stage defines how its own question bar is enforced, and this file only defines where the resulting `waiting-operator` verdict routes.

## Terminal Conditions

`reconcile-outcome` is the single point where every path through the board resolves to one of the manifest's declared terminal outcomes:

- **success**: `integrated`, a task that completed implementation and integration.
- **attention**: `waiting-operator` and `parked`, tasks that need an operator decision or hand-intervention before they can continue.
- **neutral**: `superseded`, `shelved`, and `cancelled`, tasks that leave the board without integrating, by design rather than by failure.

The board is not complete while any task remains outside these six outcomes.

## Rules

- The board-drain loop is defined once, here. `dev-workflow`, `task-refinement-workflow`, and `product-spec-workflow` never redefine it; they own only the stages inside `implementation`, `task-refinement`, and `product-specification` respectively.
- A stage transition is authoritative only as declared in `manifests/task-board.v1.yaml`; this file explains judgment behind those transitions and never restates them as a competing table.
- A task's dependency release, claim, and batch slot are held only for as long as the task remains admitted; a task that reaches a terminal outcome releases all three.

## Related Workflows

- **product-spec-workflow**: Owns the `product-specification` stage's internal rules and outcomes.
- **task-refinement-workflow**: Owns the `task-refinement` stage's internal rules and outcomes.
- **dev-workflow**: Owns the internal rules of both the `implementation` stage (runner verification, specification review, code-quality review) and the `integration` stage (integration verification, destination advance).
