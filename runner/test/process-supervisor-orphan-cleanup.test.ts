// Integration test: a controller that dies (terminal close / Ctrl-C)
// must reap the detached orchestrator group instead of orphaning it.
//
// Token-free and agent-free: the "orchestrator" is `sh -c 'echo $$; exec sleep N'`,
// spawned through the REAL superviseProcess. `$$` is sh's own pid = the detached
// group leader = child.pid, so the controller can print it without superviseProcess
// exposing the pid. We then signal the controller and assert that group dies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const MODULE_URL = import.meta.resolve('../src/adapters/process-supervisor.ts');

// A controller process that supervises one long-lived detached group and prints
// its leader pid on the first stdout line. POLL_SECS is huge so the in-loop
// watchdog never interferes — the only thing that can end the group is the
// parent-exit cleanup we are testing.
function controllerScript(): string {
  return `
    import { superviseProcess } from ${JSON.stringify(MODULE_URL)};
    superviseProcess({
      command: 'sh',
      args: ['-c', 'echo $$; exec sleep 300'],
      onStdout: (c) => process.stdout.write(c),
      budgets: { POLL_SECS: 999, NO_PROGRESS_SECS: 999, HARD_CEILING_SECS: 999 },
    }).then((r) => process.stdout.write('RESOLVED ' + JSON.stringify(r) + '\\n'));
  `;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(50);
  }
  return false;
}

// Spawn the controller, read the group-leader pid from its first stdout line.
function startController() {
  const ctrl = spawn(process.execPath, ['--input-type=module', '-e', controllerScript()], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  const pidPromise = new Promise<number>((resolve, reject) => {
    ctrl.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const pid = Number(buf.slice(0, nl).trim());
        if (Number.isInteger(pid) && pid > 0) resolve(pid);
        else reject(new Error(`bad pid line: ${JSON.stringify(buf.slice(0, nl))}`));
      }
    });
    ctrl.on('exit', () => {
      if (!buf.includes('\n')) reject(new Error('controller exited before printing pid'));
    });
  });
  return { ctrl, pidPromise };
}

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) {
  test(`controller ${signal} reaps the detached orchestrator group`, async () => {
    const { ctrl, pidPromise } = startController();
    const groupPid = await pidPromise;
    assert.ok(alive(groupPid), 'group should be alive after spawn');

    // Simulate the operator killing the controller (terminal close / Ctrl-C / kill).
    ctrl.kill(signal);

    const dead = await waitForDead(groupPid, 5000);
    assert.ok(dead, `group ${groupPid} must be reaped after controller ${signal}`);
  });
}
