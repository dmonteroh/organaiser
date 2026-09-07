// The single detection primitive that turns a `TimeoutBudget` into a termination
// decision. Drives `adapter.observe(handle)` by hand rather than with `for await`, so it
// can abandon the iteration and act the instant a budget fires, and calls
// `terminateGroups` on whichever budget wins the race. Wires into nothing else: no
// scheduler, no pipeline, no database.

import type { NormalizedEvent, ProcessAdapter, ProcessHandle, TimeoutBudget } from "../adapters/adapter.ts";
import { terminateGroups, type TerminationReport } from "./termination.ts";

export interface WatchdogClock {
  now: () => number;
}

export type WatchdogFiredBudget = "spawn-timeout" | "idle-timeout" | "wall-timeout";

export interface WatchdogNoTimeout {
  outcome: "no-timeout";
}

export interface WatchdogTimedOut {
  outcome: WatchdogFiredBudget;
  termination: TerminationReport[];
}

export type WatchdogResult = WatchdogNoTimeout | WatchdogTimedOut;

type RaceOutcome = { kind: "event"; result: IteratorResult<NormalizedEvent> } | { kind: "fired" };

export async function watchForTimeout(
  adapter: ProcessAdapter,
  handle: ProcessHandle,
  budget: TimeoutBudget,
  clock: WatchdogClock,
  graceMs: number,
): Promise<WatchdogResult> {
  const iterator = adapter.observe(handle)[Symbol.asyncIterator]();

  let firedBudget: WatchdogFiredBudget | null = null;
  let signalFired!: () => void;
  const fired = new Promise<void>((resolve) => {
    signalFired = resolve;
  });

  function fire(which: WatchdogFiredBudget): void {
    if (firedBudget !== null) return;
    firedBudget = which;
    signalFired();
  }

  let spawnTimer: NodeJS.Timeout | undefined = setTimeout(() => fire("spawn-timeout"), budget.spawnMs);
  const wallTimer: NodeJS.Timeout = setTimeout(() => fire("wall-timeout"), budget.wallMs);
  let idleTimer: NodeJS.Timeout | undefined;

  try {
    for (;;) {
      const raced: RaceOutcome = await Promise.race([
        iterator.next().then((result): RaceOutcome => ({ kind: "event", result })),
        fired.then((): RaceOutcome => ({ kind: "fired" })),
      ]);

      if (raced.kind === "fired") break;

      if (spawnTimer !== undefined) {
        clearTimeout(spawnTimer);
        spawnTimer = undefined;
      }

      if (raced.result.done) break;
      if (raced.result.value.type === "exit") break;

      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fire("idle-timeout"), budget.idleMs);
    }
  } finally {
    if (spawnTimer !== undefined) clearTimeout(spawnTimer);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearTimeout(wallTimer);
  }

  if (firedBudget === null) {
    return { outcome: "no-timeout" };
  }

  const termination = await terminateGroups([handle.pgid], { graceMs, now: clock.now });
  return { outcome: firedBudget, termination };
}
