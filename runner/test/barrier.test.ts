import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runVerificationBarrier,
  taskChecksPass,
  type BarrierInput,
} from "../src/engine/barrier.ts";
import { readLedger } from "../src/store/evidence.ts";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

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

function waitFor(predicate: () => boolean, timeoutMs: number, pollMs = 10): Promise<boolean> {
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

const LONG_LIVED = `
  process.stdout.write('READY\\n');
  setInterval(() => {}, 1000);
`;

function baseInput(overrides: Partial<BarrierInput>, executionRoot: string, taskDir: string): BarrierInput {
  return {
    attemptId: "attempt-1",
    taskId: "task-1",
    taskDir,
    executionRoot,
    pgids: [],
    requiredArtifacts: [],
    checks: {},
    env: process.env,
    ...overrides,
  };
}

// ── process-exited ───────────────────────────────────────────────────────
test("process-exited fails while the attempt's own process group is alive, passes once it is gone", async () => {
  const child = await spawnGroup(LONG_LIVED);
  const pgid = child.pid as number;
  try {
    await withTempDir("barrier-exec-", async (executionRoot) => {
      await withTempDir("barrier-task-", async (taskDir) => {
        const input = baseInput({ pgids: [pgid] }, executionRoot, taskDir);
        const aliveResult = await runVerificationBarrier(input);
        assert.equal(aliveResult.verdict, "fail");
        assert.equal(aliveResult.failedCondition, "process-exited");

        await killGroupBestEffort(pgid);
        await waitFor(() => {
          try {
            process.kill(-pgid, 0);
            return false;
          } catch {
            return true;
          }
        }, 3000);

        const deadResult = await runVerificationBarrier(baseInput({ pgids: [pgid] }, executionRoot, taskDir));
        assert.notEqual(deadResult.failedCondition, "process-exited");
      });
    });
  } finally {
    await killGroupBestEffort(pgid);
  }
});

// ── no-live-descendants ──────────────────────────────────────────────────
test("no-live-descendants fails while a scripted child of a recorded group is alive, passes once that group is gone", async () => {
  const leader = await spawnGroup(LONG_LIVED);
  const leaderPgid = leader.pid as number;
  const descendant = await spawnGroup(LONG_LIVED);
  const descendantPgid = descendant.pid as number;
  try {
    await killGroupBestEffort(leaderPgid);
    await waitFor(() => {
      try {
        process.kill(-leaderPgid, 0);
        return false;
      } catch {
        return true;
      }
    }, 3000);

    await withTempDir("barrier-exec-", async (executionRoot) => {
      await withTempDir("barrier-task-", async (taskDir) => {
        const aliveResult = await runVerificationBarrier(
          baseInput({ pgids: [leaderPgid, descendantPgid] }, executionRoot, taskDir),
        );
        assert.equal(aliveResult.verdict, "fail");
        assert.equal(aliveResult.failedCondition, "no-live-descendants");

        await killGroupBestEffort(descendantPgid);
        await waitFor(() => {
          try {
            process.kill(-descendantPgid, 0);
            return false;
          } catch {
            return true;
          }
        }, 3000);

        const deadResult = await runVerificationBarrier(
          baseInput({ pgids: [leaderPgid, descendantPgid], requiredArtifacts: [] }, executionRoot, taskDir),
        );
        assert.notEqual(deadResult.failedCondition, "no-live-descendants");
      });
    });
  } finally {
    await killGroupBestEffort(leaderPgid);
    await killGroupBestEffort(descendantPgid);
  }
});

// ── artifacts-present ────────────────────────────────────────────────────
test("artifacts-present fails when a required artifact is absent, and passes when it is a present regular file", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const missing = await runVerificationBarrier(
        baseInput({ requiredArtifacts: ["out/report.txt"] }, executionRoot, taskDir),
      );
      assert.equal(missing.verdict, "fail");
      assert.equal(missing.failedCondition, "artifacts-present");

      fs.mkdirSync(path.join(executionRoot, "out"), { recursive: true });
      fs.writeFileSync(path.join(executionRoot, "out", "report.txt"), "ok", "utf8");

      const present = await runVerificationBarrier(
        baseInput({ requiredArtifacts: ["out/report.txt"] }, executionRoot, taskDir),
      );
      assert.notEqual(present.failedCondition, "artifacts-present");
    });
  });
});

test("artifacts-present rejects a symlink inside the execution root pointing outside it", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      await withTempDir("barrier-outside-", async (outsideDir) => {
        const outsideFile = path.join(outsideDir, "secret.txt");
        fs.writeFileSync(outsideFile, "outside", "utf8");
        const linkPath = path.join(executionRoot, "link.txt");
        fs.symlinkSync(outsideFile, linkPath);

        const result = await runVerificationBarrier(
          baseInput({ requiredArtifacts: ["link.txt"] }, executionRoot, taskDir),
        );
        assert.equal(result.verdict, "fail");
        assert.equal(result.failedCondition, "artifacts-present");
        assert.ok(/escapes root/.test(result.evidence.failureDetail ?? ""));
      });
    });
  });
});

// ── checks-pass ───────────────────────────────────────────────────────────
test("checks-pass rejects a bare check string carrying a shell metacharacter as a barrier failure, not a silent skip", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const result = await runVerificationBarrier(
        baseInput({ checks: { build: "npm run build && rm -rf /" } }, executionRoot, taskDir),
      );
      assert.equal(result.verdict, "fail");
      assert.equal(result.failedCondition, "checks-pass");
      assert.equal(result.checkResults, null);
      assert.ok(/shell metacharacter/.test(result.evidence.failureDetail ?? ""));
    });
  });
});

test("checks-pass runs declared checks against executionRoot as cwd and fails on a non-zero exit", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const result = await runVerificationBarrier(
        baseInput(
          {
            checks: {
              "cwd-check": { id: "cwd-check", argv: [process.execPath, "-e", "process.exit(process.cwd() === process.env.EXPECTED ? 0 : 1)"] },
            },
            env: { ...process.env, EXPECTED: fs.realpathSync(executionRoot) },
          },
          executionRoot,
          taskDir,
        ),
      );
      assert.equal(result.verdict, "pass");
      assert.equal(result.checkResults?.checks["cwd-check"], "pass");

      const failing = await runVerificationBarrier(
        baseInput(
          { checks: { fail: { id: "fail", argv: [process.execPath, "-e", "process.exit(1)"] } } },
          executionRoot,
          taskDir,
        ),
      );
      assert.equal(failing.verdict, "fail");
      assert.equal(failing.failedCondition, "checks-pass");
      assert.equal(failing.checkResults?.checks.fail, "fail");
    });
  });
});

// ── verdict is computed only from the barrier's own checkResults ─────────
test("a worker claim of pass for a check whose real exit code is non-zero does not change the barrier verdict", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const result = await runVerificationBarrier(
        baseInput(
          {
            checks: { test: { id: "test", argv: [process.execPath, "-e", "process.exit(1)"] } },
            workerClaims: { checks: { test: "pass" } },
          },
          executionRoot,
          taskDir,
        ),
      );
      assert.equal(result.verdict, "fail");
      assert.deepEqual(result.evidence.workerClaims, { checks: { test: "pass" } });
    });
  });
});

// ── claims parity is advisory ─────────────────────────────────────────────
test("a claims-parity mismatch is recorded as advisory evidence without changing a pass verdict", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const result = await runVerificationBarrier(
        baseInput(
          {
            checks: { build: { id: "build", argv: [process.execPath, "-e", "process.exit(0)"] } },
            workerClaims: { checks: { build: "fail" } },
          },
          executionRoot,
          taskDir,
        ),
      );
      assert.equal(result.verdict, "pass");
      assert.ok(result.evidence.claimsParity !== null);
      assert.equal(result.evidence.claimsParity?.parity, false);
      assert.ok((result.evidence.claimsParity?.mismatches.length ?? 0) > 0);
    });
  });
});

// ── short-circuit ordering ────────────────────────────────────────────────
test("process-exited failure short-circuits: later conditions are not evaluated", async () => {
  const child = await spawnGroup(LONG_LIVED);
  const pgid = child.pid as number;
  try {
    await withTempDir("barrier-exec-", async (executionRoot) => {
      await withTempDir("barrier-task-", async (taskDir) => {
        const result = await runVerificationBarrier(
          baseInput(
            {
              pgids: [pgid],
              requiredArtifacts: ["missing.txt"],
              checks: { build: "npm run build && exit 1" },
            },
            executionRoot,
            taskDir,
          ),
        );
        assert.equal(result.failedCondition, "process-exited");
        assert.equal(result.checkResults, null);
      });
    });
  } finally {
    await killGroupBestEffort(pgid);
  }
});

test("artifacts-present failure short-circuits before checks-pass runs", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const markerPath = path.join(executionRoot, "ran-check.marker");
      const result = await runVerificationBarrier(
        baseInput(
          {
            requiredArtifacts: ["missing.txt"],
            checks: {
              build: {
                id: "build",
                argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`],
              },
            },
          },
          executionRoot,
          taskDir,
        ),
      );
      assert.equal(result.failedCondition, "artifacts-present");
      assert.equal(result.checkResults, null);
      assert.equal(fs.existsSync(markerPath), false, "checks-pass must not have run");
    });
  });
});

// ── table-driven: each failing condition prevents every later condition ──
test("table-driven: each condition's failure prevents the later conditions from running", async () => {
  const child = await spawnGroup(LONG_LIVED);
  const pgid = child.pid as number;
  try {
    await withTempDir("barrier-exec-", async (executionRoot) => {
      await withTempDir("barrier-task-", async (taskDir) => {
        const markerPath = path.join(executionRoot, "table-marker.txt");
        const cases: Array<{ name: string; input: Partial<BarrierInput>; expected: string }> = [
          { name: "process-exited", input: { pgids: [pgid], requiredArtifacts: ["missing.txt"] }, expected: "process-exited" },
          { name: "artifacts-present", input: { requiredArtifacts: ["missing.txt"] }, expected: "artifacts-present" },
          {
            name: "checks-pass",
            input: {
              checks: {
                build: {
                  id: "build",
                  argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran'); process.exit(1)`],
                },
              },
            },
            expected: "checks-pass",
          },
        ];

        for (const testCase of cases) {
          if (fs.existsSync(markerPath)) fs.rmSync(markerPath);
          const result = await runVerificationBarrier(baseInput(testCase.input, executionRoot, taskDir));
          assert.equal(result.failedCondition, testCase.expected, testCase.name);
          if (testCase.expected !== "checks-pass") {
            assert.equal(result.checkResults, null, `${testCase.name}: checks-pass must not have run`);
            assert.equal(fs.existsSync(markerPath), false, `${testCase.name}: checks-pass side effect must be absent`);
          }
        }
      });
    });
  } finally {
    await killGroupBestEffort(pgid);
  }
});

// ── evidence durability ────────────────────────────────────────────────────
test("a failing barrier run appends a durable attempt record to the task's evidence ledger", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      const result = await runVerificationBarrier(
        baseInput({ requiredArtifacts: ["missing.txt"] }, executionRoot, taskDir),
      );
      assert.equal(result.verdict, "fail");

      const ledger = readLedger(taskDir);
      assert.ok(ledger, "expected a ledger to have been written");
      assert.equal(ledger?.attempts.length, 1);
      const record = ledger?.attempts[0] as { attemptId: string; verdict: string };
      assert.equal(record.attemptId, "attempt-1");
      assert.equal(record.verdict, "fail");
    });
  });
});

test("running the barrier twice against the same taskDir appends two attempt records", async () => {
  await withTempDir("barrier-exec-", async (executionRoot) => {
    await withTempDir("barrier-task-", async (taskDir) => {
      await runVerificationBarrier(baseInput({ attemptId: "attempt-1" }, executionRoot, taskDir));
      await runVerificationBarrier(baseInput({ attemptId: "attempt-2" }, executionRoot, taskDir));

      const ledger = readLedger(taskDir);
      assert.equal(ledger?.attempts.length, 2);
      const ids = (ledger?.attempts as Array<{ attemptId: string }>).map((a) => a.attemptId);
      assert.deepEqual(ids, ["attempt-1", "attempt-2"]);
    });
  });
});

// ── taskChecksPass: pure, no I/O ──────────────────────────────────────────
test("taskChecksPass is a pure predicate driven by a literal result object", () => {
  assert.equal(taskChecksPass({ verdict: "pass" }), "true");
  assert.equal(taskChecksPass({ verdict: "fail" }), "false");
});
