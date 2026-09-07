import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import {
  acquireLease,
  renewLease,
  releaseLease,
  reclaimLease,
  readActiveLease,
  isSupervisorLive,
  LeaseUnavailableError,
  LeaseLostError,
} from "../src/store/lease.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

function fakeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("acquireLease succeeds when no lease row exists", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      const row = acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      assert.equal(row.owner_pid, 111);
      assert.equal(row.resource, "run-1");
      assert.equal(row.released_at, null);
    } finally {
      db.close();
    }
  });
});

test("acquireLease throws LeaseUnavailableError when a fresh lease is held by another owner", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      clock.advance(500); // well under the 3x stale threshold
      assert.throws(
        () => acquireLease(db, { runId: "run-1", ownerPid: 222, tickIntervalMs: 1000, now: clock.now }),
        LeaseUnavailableError,
      );
    } finally {
      db.close();
    }
  });
});

test("acquireLease reclaims a lease whose heartbeat is older than 3x the tick interval", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      const first = acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      clock.advance(3001); // just past 3x1000ms staleness threshold
      const second = acquireLease(db, { runId: "run-1", ownerPid: 222, tickIntervalMs: 1000, now: clock.now });
      assert.equal(second.owner_pid, 222);
      assert.notEqual(second.id, first.id);
    } finally {
      db.close();
    }
  });
});

test("a lease exactly at the staleness threshold is not yet reclaimable", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      clock.advance(3000); // exactly 3x — staleness requires strictly older
      assert.throws(
        () => acquireLease(db, { runId: "run-1", ownerPid: 222, tickIntervalMs: 1000, now: clock.now }),
        LeaseUnavailableError,
      );
    } finally {
      db.close();
    }
  });
});

test("renewLease updates the heartbeat for the current owner", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      clock.advance(400);
      const renewed = renewLease(db, { runId: "run-1", ownerPid: 111, now: clock.now });
      assert.equal(renewed.heartbeat_at, 1400);
    } finally {
      db.close();
    }
  });
});

test("renewLease throws LeaseLostError when the lease is owned by a different pid", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      assert.throws(
        () => renewLease(db, { runId: "run-1", ownerPid: 999, now: clock.now }),
        LeaseLostError,
      );
    } finally {
      db.close();
    }
  });
});

test("renewLease throws LeaseLostError when no active lease row exists", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      assert.throws(
        () => renewLease(db, { runId: "run-1", ownerPid: 111, now: clock.now }),
        LeaseLostError,
      );
    } finally {
      db.close();
    }
  });
});

test("releaseLease frees the row so a fresh acquireLease succeeds immediately", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      clock.advance(50);
      releaseLease(db, { runId: "run-1", ownerPid: 111, now: clock.now });
      const reacquired = acquireLease(db, { runId: "run-1", ownerPid: 222, tickIntervalMs: 1000, now: clock.now });
      assert.equal(reacquired.owner_pid, 222);
    } finally {
      db.close();
    }
  });
});

test("releaseLease is a no-op when the lease is already owned by someone else", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      clock.advance(3001);
      acquireLease(db, { runId: "run-1", ownerPid: 222, tickIntervalMs: 1000, now: clock.now });
      // the original owner's release must not disturb the new owner's lease
      assert.doesNotThrow(() => releaseLease(db, { runId: "run-1", ownerPid: 111, now: clock.now }));
      assert.throws(
        () => acquireLease(db, { runId: "run-1", ownerPid: 333, tickIntervalMs: 1000, now: clock.now }),
        LeaseUnavailableError,
      );
    } finally {
      db.close();
    }
  });
});

test("two supervisor processes racing for the same run: exactly one acquires, the other exits 4", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      let acquired = 0;
      let unavailable = 0;
      for (const ownerPid of [111, 222]) {
        try {
          acquireLease(db, { runId: "run-1", ownerPid, tickIntervalMs: 1000, now: clock.now });
          acquired += 1;
        } catch (err) {
          if (err instanceof LeaseUnavailableError) unavailable += 1;
          else throw err;
        }
      }
      assert.equal(acquired, 1);
      assert.equal(unavailable, 1);
    } finally {
      db.close();
    }
  });
});

test("isSupervisorLive is true for a fresh lease acquired with the current process's pid", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      const row = acquireLease(db, { runId: "run-1", ownerPid: process.pid, tickIntervalMs: 1000, now: clock.now });
      assert.deepEqual({ ...readActiveLease(db, "run-1") }, { ...row });
      assert.equal(isSupervisorLive(db, { runId: "run-1", tickIntervalMs: 1000, now: clock.now }), true);
    } finally {
      db.close();
    }
  });
});

test("isSupervisorLive is false once the lease's heartbeat is older than 3x the tick interval", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      acquireLease(db, { runId: "run-1", ownerPid: process.pid, tickIntervalMs: 1000, now: clock.now });
      clock.advance(3 * 1000 + 1);
      assert.equal(isSupervisorLive(db, { runId: "run-1", tickIntervalMs: 1000, now: clock.now }), false);
    } finally {
      db.close();
    }
  });
});

test("isSupervisorLive is false when no lease row exists for the run id", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      assert.equal(readActiveLease(db, "run-1"), null);
      assert.equal(isSupervisorLive(db, { runId: "run-1", tickIntervalMs: 1000, now: clock.now }), false);
    } finally {
      db.close();
    }
  });
});

test("reclaimLease marks a row released without checking staleness itself", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const clock = fakeClock(1000);
      const row = acquireLease(db, { runId: "run-1", ownerPid: 111, tickIntervalMs: 1000, now: clock.now });
      reclaimLease(db, row, clock.now());
      const reacquired = acquireLease(db, { runId: "run-1", ownerPid: 222, tickIntervalMs: 1000, now: clock.now });
      assert.equal(reacquired.owner_pid, 222);
    } finally {
      db.close();
    }
  });
});
