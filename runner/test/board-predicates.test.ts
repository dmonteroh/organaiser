import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  batchSlotAvailable,
  claimsAvailable,
  dependenciesSatisfied,
  entryArtifactsValid,
  implementationOutcome,
  integrationOutcome,
  integrationSlotAvailable,
  PREDICATE_RETURN_UNIONS,
  productSpecOutcome,
  refinementOutcome,
  terminalDisposition,
} from "../src/engine/board-predicates.ts";
import { getPredicate, PredicateRegistryError, PREDICATE_REGISTRY } from "../src/engine/predicate-registry.ts";
import { STAGE_DEFINITIONS } from "../src/engine/scheduler.ts";
import { FakeAdapter, type TerminateFn } from "../src/adapters/fake.ts";
import type { AttemptDescriptor, ExecutionSurface, NormalizedEvent } from "../src/adapters/adapter.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const boardPredicatesPath = fileURLToPath(new URL("../src/engine/board-predicates.ts", import.meta.url));
const boardPredicatesSource = fs.readFileSync(boardPredicatesPath, "utf8");

const manifestPath = fileURLToPath(
  new URL("../../workflows/manifests/task-board.v1.yaml", import.meta.url),
);

// A minimal reader for this manifest only: `test/workflow-parity/static.test.mjs`
// carries a general restricted-YAML reader, but its parse functions are local
// to that test script and are not exported for import. This reader extracts
// exactly what these tests need (each stage's predicate name and its
// declared transition keys) from the fixed two-space-indent shape the
// manifest is written in.
export interface ParsedStage {
  id: string;
  predicate: string | null;
  transitions: Record<string, string>;
}

export function parseTaskBoardStages(text: string): ParsedStage[] {
  const stages: ParsedStage[] = [];
  let current: ParsedStage | null = null;
  let inTransitions = false;

  for (const raw of text.split("\n")) {
    const stageMatch = raw.match(/^ {4}- id: (\S+)\s*$/);
    if (stageMatch) {
      current = { id: stageMatch[1] as string, predicate: null, transitions: {} };
      stages.push(current);
      inTransitions = false;
      continue;
    }
    if (!current) continue;

    const predicateMatch = raw.match(/^ {6}predicate: (\S+)\s*$/);
    if (predicateMatch) {
      current.predicate = predicateMatch[1] as string;
      continue;
    }

    if (/^ {6}transitions:\s*$/.test(raw)) {
      inTransitions = true;
      continue;
    }

    if (inTransitions) {
      const kv = raw.match(/^ {8}"?([^":]+)"?:\s*(\S+)\s*$/);
      if (kv) {
        current.transitions[kv[1] as string] = kv[2] as string;
      } else if (raw.trim() !== "" && !raw.startsWith(" ".repeat(8))) {
        inTransitions = false;
      }
    }
  }

  return stages;
}

const manifestStages = parseTaskBoardStages(fs.readFileSync(manifestPath, "utf8"));

test("board-predicates.ts imports no node:fs, node:child_process, or node:sqlite", () => {
  assert.doesNotMatch(boardPredicatesSource, /from ["']node:fs["']/);
  assert.doesNotMatch(boardPredicatesSource, /from ["']node:child_process["']/);
  assert.doesNotMatch(boardPredicatesSource, /from ["']node:sqlite["']/);
});

test("every predicate's declared return union equals its manifest stage's transitions key set", () => {
  assert.ok(manifestStages.length > 0, "manifest must declare at least one stage");
  for (const stage of manifestStages) {
    assert.ok(stage.predicate, `stage ${stage.id} must declare a predicate`);
    const declaredUnion = PREDICATE_RETURN_UNIONS[stage.predicate as string];
    assert.ok(declaredUnion, `no PREDICATE_RETURN_UNIONS entry for ${stage.predicate}`);
    const manifestKeys = Object.keys(stage.transitions).sort();
    const predicateKeys = [...(declaredUnion as readonly string[])].sort();
    assert.deepEqual(
      predicateKeys,
      manifestKeys,
      `predicate ${stage.predicate} (stage ${stage.id}) return union does not match manifest transitions keys`,
    );
  }
});

test("STAGE_DEFINITIONS' per-stage transitions map equals the manifest's, id-for-id and target-for-target", () => {
  assert.ok(manifestStages.length > 0, "manifest must declare at least one stage");
  const stageDefinitionsById = new Map(STAGE_DEFINITIONS.map((stage) => [stage.id, stage]));

  assert.deepEqual(
    [...stageDefinitionsById.keys()].sort(),
    manifestStages.map((stage) => stage.id).sort(),
    "STAGE_DEFINITIONS stage ids do not match the manifest's stage ids",
  );

  for (const manifestStage of manifestStages) {
    const stageDefinition = stageDefinitionsById.get(manifestStage.id);
    assert.ok(stageDefinition, `no STAGE_DEFINITIONS entry for manifest stage ${manifestStage.id}`);
    assert.deepEqual(
      (stageDefinition as (typeof STAGE_DEFINITIONS)[number]).transitions,
      manifestStage.transitions,
      `STAGE_DEFINITIONS transitions for stage ${manifestStage.id} do not match the manifest's transitions`,
    );
  }
});

test("PREDICATE_RETURN_UNIONS has no entries beyond the manifest's declared predicates", () => {
  const manifestPredicateNames = new Set(manifestStages.map((stage) => stage.predicate));
  for (const name of Object.keys(PREDICATE_RETURN_UNIONS)) {
    assert.ok(manifestPredicateNames.has(name), `${name} is not declared by any manifest stage`);
  }
});

test("claimsAvailable is a real hasRequiredClaims -> boolean-transition mapping, not a permissive stub", () => {
  const claimsBlock = boardPredicatesSource.slice(
    boardPredicatesSource.indexOf("export interface ClaimsAvailableFacts"),
    boardPredicatesSource.indexOf("export function batchSlotAvailable"),
  );
  assert.match(claimsBlock, /hasRequiredClaims: boolean;/);
  assert.match(claimsBlock, /facts\.hasRequiredClaims \? "true" : "false"/);
  assert.ok(!claimsBlock.includes("// P7:"), "claimsAvailable must no longer carry the out-of-scope marker");
});

test("integration-slot-available carries a P7 marker on its return line", () => {
  const slotBlock = boardPredicatesSource.slice(
    boardPredicatesSource.indexOf("export function integrationSlotAvailable"),
    boardPredicatesSource.indexOf("export const INTEGRATION_OUTCOME_VALUES"),
  );
  assert.match(slotBlock, /\/\/ P7:/);
});

test("implementation-outcome and integration-outcome carry P8 markers, and integration-outcome carries a P7 marker", () => {
  const implementationBlock = boardPredicatesSource.slice(
    boardPredicatesSource.indexOf("export function implementationOutcome"),
    boardPredicatesSource.indexOf("export type IntegrationSlotAvailableFacts"),
  );
  assert.match(implementationBlock, /\/\/ P8:/);

  const integrationBlock = boardPredicatesSource.slice(
    boardPredicatesSource.indexOf("export function integrationOutcome"),
    boardPredicatesSource.indexOf("export const TERMINAL_DISPOSITION_VALUES"),
  );
  assert.match(integrationBlock, /\/\/ P8:/);
  assert.match(integrationBlock, /\/\/ P7:/);
});

test("entryArtifactsValid: true only when both facts hold", () => {
  assert.equal(entryArtifactsValid({ briefArtifactExists: true, briefArtifactSchemaValid: true }), "true");
  assert.equal(entryArtifactsValid({ briefArtifactExists: true, briefArtifactSchemaValid: false }), "false");
  assert.equal(entryArtifactsValid({ briefArtifactExists: false, briefArtifactSchemaValid: true }), "false");
  assert.equal(entryArtifactsValid({ briefArtifactExists: false, briefArtifactSchemaValid: false }), "false");
});

test("dependenciesSatisfied: true iff every dependency disposition is integrated, superseded, or shelved", () => {
  assert.equal(dependenciesSatisfied({ dependencyDispositions: [] }), "true");
  assert.equal(dependenciesSatisfied({ dependencyDispositions: ["integrated", "shelved"] }), "true");
  assert.equal(dependenciesSatisfied({ dependencyDispositions: ["integrated", "parked"] }), "false");
  assert.equal(dependenciesSatisfied({ dependencyDispositions: [""] }), "false");
});

test("claimsAvailable: true iff hasRequiredClaims is true", () => {
  assert.equal(claimsAvailable({ hasRequiredClaims: true }), "true");
  assert.equal(claimsAvailable({ hasRequiredClaims: false }), "false");
});

test("batchSlotAvailable: null capacity is always available; a numeric cap gates on the count", () => {
  assert.equal(batchSlotAvailable({ activeBatchCount: 5, batchCapacity: null }), "true");
  assert.equal(batchSlotAvailable({ activeBatchCount: 1, batchCapacity: 2 }), "true");
  assert.equal(batchSlotAvailable({ activeBatchCount: 2, batchCapacity: 2 }), "false");
});

test("productSpecOutcome and refinementOutcome pass their decision through unchanged", () => {
  assert.equal(productSpecOutcome({ decision: "skipped" }), "skipped");
  assert.equal(productSpecOutcome({ decision: "needs-operator" }), "needs-operator");
  assert.equal(refinementOutcome({ decision: "ready-to-implement" }), "ready-to-implement");
  assert.equal(refinementOutcome({ decision: "parked" }), "parked");
});

test("implementationOutcome: operator question wins, else ok maps to integrating and not-ok to parked", () => {
  assert.equal(implementationOutcome({ attemptOk: true, hasBlockingOperatorQuestion: true }), "waiting-operator");
  assert.equal(implementationOutcome({ attemptOk: true, hasBlockingOperatorQuestion: false }), "integrating");
  assert.equal(implementationOutcome({ attemptOk: false, hasBlockingOperatorQuestion: false }), "parked");
});

test("integrationSlotAvailable is always true", () => {
  assert.equal(integrationSlotAvailable({}), "true");
});

test("integrationOutcome: operator question beats rejection beats ok/not-ok", () => {
  assert.equal(
    integrationOutcome({ attemptOk: true, hasIntegrationRejection: false, hasBlockingOperatorQuestion: true }),
    "waiting-operator",
  );
  assert.equal(
    integrationOutcome({ attemptOk: true, hasIntegrationRejection: true, hasBlockingOperatorQuestion: false }),
    "ready-to-implement",
  );
  assert.equal(
    integrationOutcome({ attemptOk: true, hasIntegrationRejection: false, hasBlockingOperatorQuestion: false }),
    "integrated",
  );
  assert.equal(
    integrationOutcome({ attemptOk: false, hasIntegrationRejection: false, hasBlockingOperatorQuestion: false }),
    "parked",
  );
});

test("terminalDisposition: a requested cancellation always wins", () => {
  assert.equal(terminalDisposition({ cancellationRequested: true, priorOutcome: "integrated" }), "cancelled");
});

test("terminalDisposition maps each prior outcome to its declared terminal disposition", () => {
  const cases: Array<[string, string]> = [
    ["integrated", "integrated"],
    ["shelved", "shelved"],
    ["superseded", "superseded"],
    ["waiting-operator", "waiting-operator"],
    ["needs-operator", "waiting-operator"],
    ["false", "parked"],
    ["needs-research", "parked"],
    ["needs-decision", "parked"],
    ["parked", "parked"],
  ];
  for (const [priorOutcome, expected] of cases) {
    assert.equal(terminalDisposition({ cancellationRequested: false, priorOutcome }), expected);
  }
});

test("predicate-registry: getPredicate resolves every manifest predicate name and throws on an unknown one", () => {
  for (const name of Object.keys(PREDICATE_RETURN_UNIONS)) {
    assert.equal(getPredicate(name), PREDICATE_REGISTRY[name]);
  }
  assert.throws(() => getPredicate("not-a-real-predicate"), PredicateRegistryError);
});

function fakeAttempt(stageId: string, scenario: string, roleId: string): AttemptDescriptor {
  return {
    attemptId: `${stageId}-${scenario}`,
    runId: "run_test",
    taskId: "task_test",
    stageId,
    roleId,
    timeoutBudget: { spawnMs: 5000, idleMs: 2000, wallMs: 30000 },
  };
}

async function surfaceIn(cwd: string): Promise<ExecutionSurface> {
  return {
    workingDirectory: cwd,
    environment: process.env,
    sandboxMode: null,
    permissionMode: null,
    allowedTools: [],
    disallowedTools: [],
  };
}

async function drain(events: AsyncIterable<NormalizedEvent>): Promise<void> {
  for await (const _event of events) {
    // draining is enough; the events themselves are not asserted here
  }
}

function isAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Real SIGTERM-then-SIGKILL escalation, needed only for the `sigterm-trap`
// scenario: its stream sleeps 60s after trapping SIGTERM, so it is actively
// cancelled (mirroring `fake-adapter.test.ts`'s own use of `cancel`) rather
// than drained to natural completion.
const terminate: TerminateFn = async ({ pgid }, gracePeriodMs) => {
  let signalSent: NodeJS.Signals | null = null;
  try {
    process.kill(-pgid, "SIGTERM");
    signalSent = "SIGTERM";
  } catch {
    return { signalSent: null, exitCode: null, killedProcessTree: true, timedOutWaitingForExit: false };
  }
  const deadline = Date.now() + gracePeriodMs;
  while (Date.now() < deadline && isAlive(pgid)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (isAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
      signalSent = "SIGKILL";
    } catch {
      // already gone
    }
  }
  return { signalSent, exitCode: null, killedProcessTree: !isAlive(pgid), timedOutWaitingForExit: isAlive(pgid) };
};

const SIX_FAKE_ADAPTER_SCENARIOS: ReadonlyArray<{ stageId: string; scenario: string; roleId: string }> = [
  { stageId: "implement", scenario: "well-formed", roleId: "implementer" },
  { stageId: "implement", scenario: "missing-required-field", roleId: "implementer" },
  { stageId: "implement", scenario: "nonzero-exit", roleId: "implementer" },
  { stageId: "implement", scenario: "idle-timeout", roleId: "implementer" },
  { stageId: "implement", scenario: "sigterm-trap", roleId: "implementer" },
  { stageId: "review-spec", scenario: "unknown-verdict", roleId: "spec-reviewer" },
];

// `implementation-outcome`/`integration-outcome` only take an already-classified
// `AttemptOutcome.ok` boolean as input, so this test does not assert which of
// P5c's six scenarios classify ok vs not-ok (that is `FakeAdapter.classify`'s
// contract, already covered by `fake-adapter.test.ts`); it asserts that
// whatever `ok` each scenario produces, both predicates stay inside their
// declared P5-reachable subset and agree with `ok` exactly.
test("implementation-outcome and integration-outcome stay inside their P5-reachable subset across all six fake-adapter scenarios", async () => {
  await withTempWorkspace(async (dir) => {
    for (const { stageId, scenario, roleId } of SIX_FAKE_ADAPTER_SCENARIOS) {
      const adapter = new FakeAdapter({ terminate, scenarioFor: () => scenario });
      const descriptor = fakeAttempt(stageId, scenario, roleId);
      const handle = await adapter.start(descriptor, "packet", await surfaceIn(dir));

      if (scenario === "sigterm-trap") {
        const iterator = adapter.observe(handle)[Symbol.asyncIterator]();
        await iterator.next();
        await adapter.cancel(handle, 200);
      } else {
        await drain(adapter.observe(handle));
      }

      const artifacts = await adapter.collect(handle);
      const outcome = await adapter.classify(artifacts);

      const implResult = implementationOutcome({ attemptOk: outcome.ok, hasBlockingOperatorQuestion: false });
      assert.ok(
        implResult === "integrating" || implResult === "parked",
        `implementation-outcome for ${scenario} produced ${implResult}, outside {integrating, parked}`,
      );
      assert.equal(implResult, outcome.ok ? "integrating" : "parked");

      const integResult = integrationOutcome({
        attemptOk: outcome.ok,
        hasIntegrationRejection: false,
        hasBlockingOperatorQuestion: false,
      });
      assert.ok(
        integResult === "integrated" || integResult === "parked",
        `integration-outcome for ${scenario} produced ${integResult}, outside {integrated, parked}`,
      );
      assert.equal(integResult, outcome.ok ? "integrated" : "parked");
    }
  });
});
