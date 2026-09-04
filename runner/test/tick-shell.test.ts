import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, withTransaction } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { acquireLease } from "../src/store/lease.ts";
import {
  runTickShell,
  restingStubBody,
  computeOperatorPollCount,
  RunnerInvariantError,
  DEFAULT_TICK_INTERVAL_MS,
  DEFAULT_OPERATOR_POLL_WINDOW_MS,
  type RestingRunState,
  type TickContext,
  type TickOutcome,
} from "../src/engine/tick.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

const RESTING_RUN_STATES: readonly RestingRunState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "paused",
  "blocked",
];

function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function insertRun(db: ReturnType<typeof openStore>, runId: string, now: number): void {
  withTransaction(db, () => {
    db.prepare(
      "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, "board.yaml", "running", "starting", now);
  });
}

function insertWorker(
  db: ReturnType<typeof openStore>,
  opts: { id: string; runId: string; attemptId: string; pid: number; pgid: number; heartbeatAt: number; now: number },
): void {
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.attemptId, opts.runId, "task-1", "stage-1", "implementer", 1, "v1", "fake", "fake", "{}", 0, "running", opts.now);
    db.prepare(
      `INSERT INTO workers (id, run_id, attempt_id, pid, pgid, heartbeat_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.id, opts.runId, opts.attemptId, opts.pid, opts.pgid, opts.heartbeatAt, opts.now);
  });
}

function insertControlRow(
  db: ReturnType<typeof openStore>,
  opts: { id: string; runId: string; kind: string; now: number },
): void {
  withTransaction(db, () => {
    db.prepare(`INSERT INTO control (id, run_id, kind, created_at) VALUES (?, ?, ?, ?)`).run(
      opts.id,
      opts.runId,
      opts.kind,
      opts.now,
    );
  });
}

function getRunRow(db: ReturnType<typeof openStore>, runId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown>;
}

function countActiveLeases(db: ReturnType<typeof openStore>, runId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM locks WHERE resource = ? AND released_at IS NULL")
    .get(runId) as { n: number };
  return row.n;
}

async function withRun(
  fn: (env: { dir: string; db: ReturnType<typeof openStore>; runId: string; clock: ReturnType<typeof fakeClock> }) => Promise<void>,
): Promise<void> {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1_000_000);
      const runId = "run-1";
      insertRun(db, runId, clock.now());
      acquireLease(db, { runId, ownerPid: process.pid, tickIntervalMs: 10, now: clock.now });
      await fn({ dir, db, runId, clock });
    } finally {
      db.close();
    }
  });
}

test("computeOperatorPollCount matches all four (window, interval) pairs from the AC", () => {
  assert.equal(computeOperatorPollCount(0, 1000), 1);
  assert.equal(computeOperatorPollCount(500, 1000), 1);
  assert.equal(computeOperatorPollCount(3000, 1000), 3);
  assert.equal(computeOperatorPollCount(300000, 1000), 300);
});

test("DEFAULT_TICK_INTERVAL_MS and DEFAULT_OPERATOR_POLL_WINDOW_MS match the fixed seam", () => {
  assert.equal(DEFAULT_TICK_INTERVAL_MS, 1000);
  assert.equal(DEFAULT_OPERATOR_POLL_WINDOW_MS, 300000);
});

for (const state of RESTING_RUN_STATES) {
  test(`runTickShell exits within one tick when body first returns resting state "${state}"`, async () => {
    await withRun(async ({ db, runId, clock }) => {
      const exit = await runTickShell({
        db,
        runId,
        body: restingStubBody({ kind: "resting", state, reason: null }),
        tickIntervalMs: 10,
        operatorPollWindowMs: 100,
        now: clock.now,
      });
      assert.equal(exit.state, state);
      assert.equal(exit.exitCode, 0);
      assert.equal(getRunRow(db, runId).state, state);
      assert.equal(countActiveLeases(db, runId), 0);
    });
  });
}

test("SupervisorExit.exitCode is 0 for the waiting-operator window exit too", async () => {
  await withRun(async ({ db, runId, clock }) => {
    const exit = await runTickShell({
      db,
      runId,
      body: restingStubBody({ kind: "resting", state: "waiting-operator", reason: null }),
      tickIntervalMs: 5,
      operatorPollWindowMs: 5,
      now: clock.now,
    });
    assert.equal(exit.state, "waiting-operator");
    assert.equal(exit.exitCode, 0);
    assert.equal(countActiveLeases(db, runId), 0);
  });
});

test("ctx.leaseDeadlineMs equals now() + 3*tickIntervalMs at the top of each tick and advances by one interval per tick", async () => {
  await withRun(async ({ db, runId, clock }) => {
    const observed: number[] = [];
    const tickIntervalMs = 10;
    const outcomes: TickOutcome[] = [{ kind: "progress" }, { kind: "progress" }, { kind: "progress" }, { kind: "resting", state: "succeeded", reason: null }];
    let call = 0;
    const body = async (ctx: TickContext): Promise<TickOutcome> => {
      observed.push(ctx.leaseDeadlineMs - ctx.now());
      const outcome = outcomes[call] as TickOutcome;
      call += 1;
      return outcome;
    };
    await runTickShell({ db, runId, body, tickIntervalMs, operatorPollWindowMs: 100, now: clock.now });
    assert.deepEqual(observed, [30, 30, 30, 30]);
  });
});

test("the shell renews the run lease at the top of every tick before calling body", async () => {
  await withRun(async ({ db, runId, clock }) => {
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      const before = db.prepare("SELECT heartbeat_at FROM locks WHERE resource = ? AND released_at IS NULL").get(runId) as {
        heartbeat_at: number;
      };
      assert.equal(before.heartbeat_at, clock.now());
      clock.advance(10);
      if (calls >= 5) return { kind: "resting", state: "succeeded", reason: null };
      return { kind: "progress" };
    };
    const exit = await runTickShell({ db, runId, body, tickIntervalMs: 10, operatorPollWindowMs: 100, now: clock.now });
    assert.equal(calls, 5);
    assert.equal(exit.state, "succeeded");
  });
});

test("an acknowledged control row is never re-applied on a later tick", async () => {
  await withRun(async ({ db, runId, clock }) => {
    insertControlRow(db, { id: "ctl-1", runId, kind: "pause", now: clock.now() });
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      clock.advance(5);
      if (calls >= 10) return { kind: "resting", state: "cancelled", reason: null };
      return { kind: "progress" };
    };
    await runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 100, now: clock.now });
    const ackedCount = db
      .prepare("SELECT COUNT(*) AS n FROM control WHERE run_id = ? AND acked_at IS NOT NULL")
      .get(runId) as { n: number };
    assert.equal(ackedCount.n, 1);
    const run = getRunRow(db, runId);
    assert.equal(run.desired_state, "paused");
    assert.equal(calls, 10);
  });
});

test("pause acknowledgement aborts ctx.signal for the rest of the run", async () => {
  await withRun(async ({ db, runId, clock }) => {
    insertControlRow(db, { id: "ctl-1", runId, kind: "pause", now: clock.now() });
    const abortedFlags: boolean[] = [];
    let calls = 0;
    const body = async (ctx: TickContext): Promise<TickOutcome> => {
      calls += 1;
      abortedFlags.push(ctx.signal.aborted);
      if (calls >= 3) return { kind: "resting", state: "paused", reason: null };
      return { kind: "progress" };
    };
    await runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 100, now: clock.now });
    assert.deepEqual(abortedFlags, [true, true, true]);
  });
});

test("resume replaces the abort controller and restores desired_state to running", async () => {
  await withRun(async ({ db, runId, clock }) => {
    insertControlRow(db, { id: "ctl-pause", runId, kind: "pause", now: clock.now() });
    let calls = 0;
    const body = async (ctx: TickContext): Promise<TickOutcome> => {
      calls += 1;
      if (calls === 2) {
        insertControlRow(db, { id: "ctl-resume", runId, kind: "resume", now: clock.now() });
      }
      if (calls === 3) {
        assert.equal(ctx.signal.aborted, false);
      }
      if (calls >= 4) return { kind: "resting", state: "succeeded", reason: null };
      return { kind: "progress" };
    };
    await runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 100, now: clock.now });
    assert.equal(getRunRow(db, runId).desired_state, "running");
  });
});

test("Q10: asserts zero live worker rows and throws a RunnerInvariantError when a live worker is present at waiting-operator", async () => {
  await withRun(async ({ db, runId, clock }) => {
    insertWorker(db, { id: "w1", runId, attemptId: "att-1", pid: 999999, pgid: 999999, heartbeatAt: clock.now(), now: clock.now() });
    await assert.rejects(
      () =>
        runTickShell({
          db,
          runId,
          body: restingStubBody({ kind: "resting", state: "waiting-operator", reason: null }),
          tickIntervalMs: 5,
          operatorPollWindowMs: 50,
          now: clock.now,
        }),
      RunnerInvariantError,
    );
  });
});

test("Q10: zero live workers holds at every tick inside the polling window", async () => {
  await withRun(async ({ db, runId, clock }) => {
    const zeroLiveObservations: number[] = [];
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM workers WHERE run_id = ? AND termination_state IS NULL")
        .get(runId) as { n: number };
      zeroLiveObservations.push(row.n);
      return { kind: "resting", state: "waiting-operator", reason: null };
    };
    const exit = await runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 20, now: clock.now });
    assert.equal(exit.state, "waiting-operator");
    assert.ok(calls >= 4);
    assert.ok(zeroLiveObservations.every((n) => n === 0));
  });
});

test("Q10: run state waiting-operator is recorded durably on the first polling tick", async () => {
  await withRun(async ({ db, runId, clock }) => {
    let stateAfterSecondTickBody: unknown = null;
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      if (calls === 2) {
        // the shell records the resting state after body returns on tick 1 and
        // before it calls body again on tick 2, so by the second call the
        // durable write from the first tick must already be visible.
        stateAfterSecondTickBody = getRunRow(db, runId).state;
      }
      return { kind: "resting", state: "waiting-operator", reason: null };
    };
    await runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 15, now: clock.now });
    assert.equal(stateAfterSecondTickBody, "waiting-operator");
  });
});

test("Q10: the window resets to zero when a tick returns a non-waiting-operator outcome", async () => {
  await withRun(async ({ db, runId, clock }) => {
    // window 15 / interval 5 = 3 polls to exhaust. Without a reset, the single
    // waiting-operator tick at call 1 plus two more after the interruption
    // would exhaust the window at call 4. A working reset requires a full
    // fresh 3-poll run after the interruption, exhausting at call 5 instead.
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      if (calls === 1) return { kind: "resting", state: "waiting-operator", reason: null };
      if (calls === 2) return { kind: "progress" };
      return { kind: "resting", state: "waiting-operator", reason: null };
    };
    const exit = await runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 15, now: clock.now });
    assert.equal(exit.state, "waiting-operator");
    assert.equal(calls, 5);
  });
});

test("outcome kind 'progress' loops immediately with no wait", async () => {
  await withRun(async ({ db, runId, clock }) => {
    const start = Date.now();
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      if (calls >= 50) return { kind: "resting", state: "succeeded", reason: null };
      return { kind: "progress" };
    };
    await runTickShell({ db, runId, body, tickIntervalMs: 1000, operatorPollWindowMs: 100, now: clock.now });
    const elapsed = Date.now() - start;
    assert.equal(calls, 50);
    assert.ok(elapsed < 500, `progress ticks must not wait: took ${elapsed}ms`);
  });
});

test("runTickShell throws when the lease is lost mid-run (stolen by another owner)", async () => {
  await withRun(async ({ db, runId, clock }) => {
    let calls = 0;
    const body = async (): Promise<TickOutcome> => {
      calls += 1;
      if (calls === 1) {
        // simulate another supervisor stealing the lease out from under this
        // shell by directly releasing then reacquiring it under a new pid.
        db.prepare("UPDATE locks SET owner_pid = ? WHERE resource = ? AND released_at IS NULL").run(
          process.pid + 1,
          runId,
        );
      }
      return { kind: "progress" };
    };
    await assert.rejects(() =>
      runTickShell({ db, runId, body, tickIntervalMs: 5, operatorPollWindowMs: 100, now: clock.now }),
    );
  });
});
