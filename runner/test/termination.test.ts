import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

import { terminateGroups } from "../src/engine/termination.ts";

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 5): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (predicate() || Date.now() > deadline) {
        clearInterval(tick);
        resolve(predicate());
      }
    }, pollMs);
  });
}

// Spawns a detached group leader and waits for it to print "READY" — every
// script below prints that as its first statement, right after installing
// any SIGTERM trap, so callers never race a just-spawned child that has not
// finished registering its handler yet.
function spawnGroup(script: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("utf8");
      if (buf.includes("READY")) {
        child.stdout?.off("data", onData);
        resolve(child);
      }
    };
    child.stdout?.on("data", onData);
    child.on("error", reject);
  });
}

async function killGroupBestEffort(pgid: number | undefined): Promise<void> {
  if (typeof pgid !== "number") return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // already gone
  }
}

const IGNORES_SIGTERM = `
  process.on('SIGTERM', () => {});
  process.stdout.write('READY\\n');
  setTimeout(() => {}, 60000);
`;

const PLAIN_IDLE = `
  process.stdout.write('READY\\n');
  setTimeout(() => {}, 60000);
`;

const GRANDCHILD_SCRIPT =
  "process.on('SIGTERM', () => {}); process.stdout.write('READY\\n'); setTimeout(() => {}, 60000);";

const SPAWNS_TRAPPING_GRANDCHILD = `
  import { spawn } from 'node:child_process';
  const g = spawn(process.execPath, ['-e', ${JSON.stringify(GRANDCHILD_SCRIPT)}], { stdio: 'ignore' });
  setTimeout(() => {
    process.stdout.write('READY\\n');
  }, 100);
  setTimeout(() => {}, 60000);
`;

test("graceMs: 0 sends SIGTERM then SIGKILL in the same call, no wait, for a group that ignores SIGTERM", async () => {
  const child = await spawnGroup(IGNORES_SIGTERM);
  const pgid = child.pid as number;
  try {
    const start = Date.now();
    const reports = await terminateGroups([pgid], { graceMs: 0 });
    const elapsed = Date.now() - start;

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.pgid, pgid);
    assert.equal(reports[0]?.signalled, true);
    assert.equal(reports[0]?.aliveAfterGrace, true);
    assert.equal(reports[0]?.killed, true);
    assert.ok(elapsed < 100, `graceMs: 0 must not wait: took ${elapsed}ms`);

    const dead = await waitFor(() => !groupAlive(pgid), 500);
    assert.ok(dead, "group must be dead after the immediate SIGKILL escalation");
  } finally {
    await killGroupBestEffort(pgid);
  }
});

test("a group that dies promptly on SIGTERM is not SIGKILLed and is not waited on for the full grace window", async () => {
  const child = await spawnGroup(PLAIN_IDLE);
  const pgid = child.pid as number;
  try {
    const start = Date.now();
    const reports = await terminateGroups([pgid], { graceMs: 2000 });
    const elapsed = Date.now() - start;

    assert.equal(reports[0]?.signalled, true);
    assert.equal(reports[0]?.aliveAfterGrace, false);
    assert.equal(reports[0]?.killed, false);
    assert.ok(elapsed < 1000, `a promptly-dying group must not wait the full grace window: took ${elapsed}ms`);
  } finally {
    await killGroupBestEffort(pgid);
  }
});

test("a group that traps and ignores SIGTERM survives the grace window and is reaped by the SIGKILL escalation", async () => {
  const child = await spawnGroup(IGNORES_SIGTERM);
  const pgid = child.pid as number;
  try {
    assert.ok(groupAlive(pgid), "precondition: group must be alive before termination begins");

    const reports = await terminateGroups([pgid], { graceMs: 150 });

    assert.equal(reports[0]?.aliveAfterGrace, true, "must have survived SIGTERM through the whole grace window");
    assert.equal(reports[0]?.killed, true);
    const gone = await waitFor(() => !groupAlive(pgid), 500);
    assert.ok(gone, "group must be gone once SIGKILL has been sent");
  } finally {
    await killGroupBestEffort(pgid);
  }
});

test("multiple groups are handled independently in one call", async () => {
  const trapper = await spawnGroup(IGNORES_SIGTERM);
  const plain = await spawnGroup(PLAIN_IDLE);
  const trapperPgid = trapper.pid as number;
  const plainPgid = plain.pid as number;
  try {
    const reports = await terminateGroups([trapperPgid, plainPgid], { graceMs: 150 });
    const byPgid = new Map(reports.map((report) => [report.pgid, report]));

    assert.equal(byPgid.get(trapperPgid)?.killed, true);
    assert.equal(byPgid.get(plainPgid)?.killed, false);
    assert.ok(await waitFor(() => !groupAlive(trapperPgid), 500), "trapper group must be gone");
    assert.ok(await waitFor(() => !groupAlive(plainPgid), 500), "plain group must be gone");
  } finally {
    await killGroupBestEffort(trapperPgid);
    await killGroupBestEffort(plainPgid);
  }
});

test("terminateGroups never signals pid 0 or a non-positive pgid", async () => {
  const reports = await terminateGroups([0, -1, -5], { graceMs: 0 });
  assert.deepEqual(reports, []);
});

test("terminateGroups on an already-dead group is a harmless no-op that reports it gone", async () => {
  const child = await spawnGroup(PLAIN_IDLE);
  const pgid = child.pid as number;
  await killGroupBestEffort(pgid);
  const dead = await waitFor(() => !groupAlive(pgid), 500);
  assert.ok(dead, "precondition: group must already be gone");

  const reports = await terminateGroups([pgid], { graceMs: 50 });
  assert.equal(reports[0]?.signalled, true);
  assert.equal(reports[0]?.aliveAfterGrace, false);
  assert.equal(reports[0]?.killed, false);
});

test("no descendant of a terminated group survives: a grandchild spawned in the same group is reaped too", async () => {
  const parent = await spawnGroup(SPAWNS_TRAPPING_GRANDCHILD);
  const pgid = parent.pid as number;
  try {
    const groupHasTwoMembers = await waitFor(() => groupAlive(pgid), 1000);
    assert.ok(groupHasTwoMembers, "precondition: the group must be alive (parent + grandchild) before termination");

    const reports = await terminateGroups([pgid], { graceMs: 200 });

    assert.equal(reports[0]?.killed, true, "the trapping grandchild must force the SIGKILL escalation");
    const gone = await waitFor(() => !groupAlive(pgid), 500);
    assert.ok(gone, "no member of the group — parent or grandchild — may survive");
    assert.throws(() => process.kill(-pgid, 0), /ESRCH/);
  } finally {
    await killGroupBestEffort(pgid);
  }
});
