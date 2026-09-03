import { test } from 'node:test';
import assert from 'node:assert/strict';

import { superviseProcess } from '../src/adapters/process-supervisor.ts';

// All budgets are in SECONDS (the module's convention). Tests inject fractional
// seconds so the whole suite finishes in well under a second while exercising the
// real timer paths.

// A long-lived child that does nothing observable: sleeps far longer than any
// test budget. Stdout is irrelevant; the snapshot drives progress decisions.
const IDLE_CHILD = 'setTimeout(() => {}, 60000);';

// A child that installs a SIGTERM handler which ignores the signal, then idles.
// Only SIGKILL can reap it. It prints a line so onStdout has something to forward.
const SIGTERM_IGNORER = `
  process.on('SIGTERM', () => {});
  process.stdout.write('PID:' + process.pid + '\\n');
  setTimeout(() => {}, 60000);
`;

// A child that spawns a grandchild (also long-lived) and prints the grandchild's
// pid so the test can probe its liveness. The grandchild stays in the child's
// process group (no setsid), so a group-targeted kill must reap it too.
const SPAWNS_GRANDCHILD = `
  import { spawn } from 'node:child_process';
  const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000);']);
  process.stdout.write('GPID:' + g.pid + '\\n');
  setTimeout(() => {}, 60000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Resolves once a predicate holds or a deadline passes, polling at 5ms.
function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (predicate() || Date.now() > deadline) {
        clearInterval(tick);
        resolve(predicate());
      }
    }, 5);
  });
}

// ── Scenario (a): progress then stall → killed only after NO_PROGRESS_SECS ────
test('child that progresses then stalls is reaped only after the no-progress window', async () => {
  // Snapshot changes for the first ~120ms, then freezes. With NO_PROGRESS_SECS
  // 0.2s and POLL 0.02s, the watchdog must keep it alive through the progress
  // phase and only tear down after the stall window elapses.
  const startedAt = Date.now();
  const snapshot = () => {
    const elapsed = Date.now() - startedAt;
    return elapsed < 120 ? Math.floor(elapsed / 20) : 'frozen';
  };

  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', IDLE_CHILD],
    snapshot,
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.2, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });

  const elapsed = Date.now() - startedAt;
  assert.equal(result.outcome, 'stalled_killed');
  // exitCode is null on a killed path — the child did not exit naturally.
  assert.equal(result.exitCode, null);
  // Must have survived the progress phase: freeze begins at 120ms, then a full
  // 0.2s no-progress window, so teardown cannot complete before ~320ms.
  assert.ok(elapsed >= 300, `killed too early at ${elapsed}ms`);
});

// ── Scenario (b) + AC6: progress forever → ceiling backstop fires ─────────────
test('child that progresses forever is killed by the hard ceiling, not the stall path', async () => {
  let n = 0;
  const snapshot = () => n++; // changes every single poll → never stalls

  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', IDLE_CHILD],
    snapshot,
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.1, GRACE_SECS: 0.05, HARD_CEILING_SECS: 0.25 },
  });

  assert.equal(result.outcome, 'ceiling_exceeded');
  assert.equal(result.exitCode, null, 'ceiling_exceeded path must yield exitCode null');
});

// ── Scenario (c) + AC4: SIGTERM ignored → SIGKILL still reaps the child ───────
test('a child that ignores SIGTERM is still reaped by SIGKILL escalation', async () => {
  let childPid: number | null = null;
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', SIGTERM_IGNORER],
    snapshot: () => 'never-changes', // immediate stall
    onStdout: (chunk) => {
      const m = /PID:(\d+)/.exec(chunk);
      if (m) childPid = Number(m[1]);
    },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.04, GRACE_SECS: 0.1, HARD_CEILING_SECS: 5 },
  });

  assert.equal(result.outcome, 'stalled_killed');
  assert.ok(childPid && Number.isInteger(childPid), 'child pid was reported');
  // SIGTERM was ignored, so only the SIGKILL escalation can have reaped it.
  const dead = await waitFor(() => !alive(childPid as number), 500);
  assert.equal(dead, true, `SIGTERM-ignoring child ${childPid} survived SIGKILL escalation`);
});

// ── Scenario (d) + AC1: process-group teardown reaps a grandchild ─────────────
test('the entire process group is torn down — a grandchild is killed with the child', async () => {
  let grandchildPid: number | null = null;
  const result = await superviseProcess({
    command: process.execPath,
    args: ['--input-type=module', '-e', SPAWNS_GRANDCHILD],
    snapshot: () => 'never-changes', // immediate stall
    onStdout: (chunk) => {
      const m = /GPID:(\d+)/.exec(chunk);
      if (m) grandchildPid = Number(m[1]);
    },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.04, GRACE_SECS: 0.1, HARD_CEILING_SECS: 5 },
  });

  assert.equal(result.outcome, 'stalled_killed');
  assert.ok(grandchildPid && Number.isInteger(grandchildPid), 'grandchild pid was reported');
  // The grandchild must be dead. Give it a brief moment for SIGKILL delivery.
  const dead = await waitFor(() => !alive(grandchildPid as number), 500);
  assert.equal(dead, true, `grandchild ${grandchildPid} survived process-group teardown`);
});

// ── AC3: dispatch-growth regression guard ─────────────────────────────────────
// A child whose snapshot's dispatchLines field GROWS each poll while HEAD stays
// FROZEN (no commit) must run to its natural clean exit. The only liveness kill
// is stalled_killed (snapshot frozen) — which does not apply when dispatchLines
// keeps changing — and ceiling_exceeded for genuinely runaway loops.
test('dispatch lines growing while HEAD stays frozen never triggers a kill — child runs to clean exit', async () => {
  const startedAt = Date.now();
  // dispatchLines grows each poll; head is always frozen. Dispatch activity without
  // a commit must NOT be killed as long as the snapshot keeps advancing.
  const snapshot = () => ({
    head: 'FROZEN',
    dispatchLines: Date.now() - startedAt,
    artifactMtime: 0,
    streamedBytes: 0,
  });

  // Child exits cleanly after 400ms. NO_PROGRESS_SECS is SHORT (0.1s): a truly
  // frozen snapshot would be stalled_killed at ~100ms. Only the growing dispatchLines
  // resets the no-progress clock, keeping the child alive to its 400ms natural exit.
  // HARD_CEILING_SECS is safely above the child's lifetime at 5s.
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 400);'],
    snapshot,
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.1, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });

  const elapsed = Date.now() - startedAt;
  assert.equal(result.outcome, 'exited_clean', 'dispatch-row growth with frozen HEAD must never kill the child');
  assert.equal(result.exitCode, 0);
  // The child must have run well past the 0.1s no-progress window, proving it was
  // kept alive by dispatchLines growth rather than a relaxed deadline.
  assert.ok(elapsed >= 200, `child should have run well past the 0.1s no-progress window, only ran ${elapsed}ms`);
});

// ── AC8: report-mtime liveness guard ─────────────────────────────────────────
// A worker writing its report file advances artifactMtime in the snapshot even when
// HEAD is frozen and no dispatch rows or streamed bytes change. This guards that the
// artifactMtime signal alone resets the no-progress deadline.
test('a report-mtime advance alone resets the no-progress clock (artifactMtime guard)', async () => {
  const startedAt = Date.now();
  // Only artifactMtime advances; head, dispatchLines, and streamedBytes stay frozen.
  // With NO_PROGRESS_SECS=0.1s, a truly frozen snapshot would trigger stalled_killed
  // before the child's 400ms lifetime. artifactMtime advancing must prevent that.
  const snapshot = () => ({
    head: 'FROZEN',
    dispatchLines: 0,
    artifactMtime: Date.now() - startedAt,
    streamedBytes: 0,
  });

  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 400);'],
    snapshot,
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.1, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });

  assert.equal(result.outcome, 'exited_clean', 'artifactMtime advance must reset the no-progress clock and spare the child');
  assert.equal(result.exitCode, 0);
});

// ── Streamed-byte progress: output without structural change is NOT reaped ────
// Mirrors run.mjs's snapshot wiring: the in-scope stdout/stderr accumulators the
// onStdout/onStderr sinks fill feed a `streamedBytes` field, so output on the wire
// counts as progress even when HEAD/dispatch-log/artifacts never move. A child that
// emits bytes on a sub-poll cadence for far longer than NO_PROGRESS_SECS must run to
// its natural clean exit instead of being stalled-killed.
test('a child that streams output but makes no structural progress is not reaped (streamedBytes)', async () => {
  // The structural fields are frozen for the whole run; only the byte total moves.
  let stdout = '';
  let stderr = '';
  const snapshot = () => ({
    head: 'FROZEN',
    dispatchLines: 0,
    artifactMtime: 0,
    streamedBytes: stdout.length + stderr.length,
  });

  // Emit a chunk every ~20ms for ~300ms, then exit clean. 300ms is well past the
  // 0.1s no-progress window, so a structural-only snapshot would have reaped it.
  const child = `
    let n = 0;
    const t = setInterval(() => {
      process.stdout.write('chunk' + (n++) + '\\n');
      if (n >= 15) { clearInterval(t); process.exit(0); }
    }, 20);
  `;
  const startedAt = Date.now();
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', child],
    snapshot,
    onStdout: (c) => { stdout += c; },
    onStderr: (c) => { stderr += c; },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.1, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });

  const elapsed = Date.now() - startedAt;
  assert.equal(result.outcome, 'exited_clean', 'streaming output must count as progress and not be reaped');
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed >= 200, `child should have streamed past the no-progress window, only ran ${elapsed}ms`);
  assert.ok(stdout.length > 0, 'the child actually streamed bytes');
});

// AC3 pairing partner: the SAME structural-only freeze WITHOUT a moving byte signal
// (a genuinely silent child) is still stalled-killed — proving the byte field, not a
// relaxed deadline, is what spared the streaming child above.
test('a genuinely silent child with frozen structural fields is still stalled-killed', async () => {
  const snapshot = () => ({ head: 'FROZEN', dispatchLines: 0, artifactMtime: 0, streamedBytes: 0 });
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', IDLE_CHILD], // never writes anything
    snapshot,
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 0.1, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.equal(result.outcome, 'stalled_killed');
  assert.equal(result.exitCode, null);
});

// ── AC5: clean exit resolves exited_clean without killing ─────────────────────
test('a child that exits 0 on its own resolves exited_clean', async () => {
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(0);'],
    snapshot: () => 'x',
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.deepEqual(result, { outcome: 'exited_clean', exitCode: 0 });
});

// ── AC5: non-zero exit resolves exited_nonzero without killing ────────────────
test('a child that exits non-zero on its own resolves exited_nonzero', async () => {
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(3);'],
    snapshot: () => 'x',
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.equal(result.outcome, 'exited_nonzero');
  assert.equal(result.exitCode, 3);
});

// ── AC6 (spawn-error path): non-existent binary → exited_nonzero ─────────────
// This pins the child.on('error') → settle('exited_nonzero') mapping in
// process-supervisor.ts which previously had zero direct test coverage (ENOENT
// from spawn, not from a running process).
test('spawning a non-existent binary resolves as exited_nonzero', async () => {
  const result = await superviseProcess({
    command: 'definitely-not-a-real-binary',
    args: [],
    snapshot: () => 'x',
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.equal(result.outcome, 'exited_nonzero');
  // exitCode is null on a spawn error — no process was started.
  assert.equal(result.exitCode, null);
});

// ── AC7: stdout/stderr are forwarded to injected sinks ────────────────────────
test('stdout and stderr chunks are forwarded to the provided sinks', async () => {
  let out = '';
  let err = '';
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("hello"); process.stderr.write("oops"); process.exit(0);'],
    snapshot: () => 'x',
    onStdout: (c) => { out += c; },
    onStderr: (c) => { err += c; },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.equal(result.outcome, 'exited_clean');
  assert.equal(out, 'hello');
  assert.equal(err, 'oops');
});

// ── O3: stdin delivery — the packet reaches the child's stdin and is echoed back ─
// Proves the codex delivery path: input is written to the child's stdin and the
// child sees EOF (it reads to end, then echoes). Without the stdin write+close the
// child would block forever on its read and the watchdog would have to kill it.
test('input is delivered to the child stdin and the child sees EOF', async () => {
  let out = '';
  const child = `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { process.stdout.write('GOT:' + buf); process.exit(0); });
  `;
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', child],
    input: 'the-packet-payload',
    snapshot: () => 'x',
    onStdout: (c) => { out += c; },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.equal(result.outcome, 'exited_clean');
  assert.equal(out, 'GOT:the-packet-payload');
});

// With no input, stdin is still closed immediately (empty EOF = v1 `</dev/null`) so
// a child that reads stdin does not hang.
test('omitting input still closes stdin so a reader sees empty EOF', async () => {
  let out = '';
  const child = `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { process.stdout.write('GOT:[' + buf + ']'); process.exit(0); });
  `;
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', child],
    snapshot: () => 'x',
    onStdout: (c) => { out += c; },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });
  assert.equal(result.outcome, 'exited_clean');
  assert.equal(out, 'GOT:[]');
});

// ── AC2: recordProcess is invoked before the returned promise settles ─────────
test('recordProcess is called with the child pid and pgid before the supervise promise settles', async () => {
  let recorded: { pid: number; pgid: number } | null = null;
  const result = await superviseProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(0);'],
    snapshot: () => 'x',
    recordProcess: (info) => {
      recorded = info;
    },
    budgets: { POLL_SECS: 0.02, NO_PROGRESS_SECS: 5, GRACE_SECS: 0.05, HARD_CEILING_SECS: 5 },
  });

  assert.ok(recorded, 'recordProcess must have been called before the promise settled');
  assert.equal(typeof (recorded as { pid: number }).pid, 'number');
  assert.equal((recorded as { pid: number; pgid: number }).pgid, (recorded as { pid: number; pgid: number }).pid);
  assert.equal(result.outcome, 'exited_clean');
});
