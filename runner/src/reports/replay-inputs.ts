// Assembles the three per-task inputs `reconstructLedger`
// (`runner/src/reports/replay.ts`) requires but that no existing production
// code path derives: `specPath`, `verificationMode`, and `integrationCommit`.
//
// I/O contract: exactly one store read (a single SELECT against the
// caller-supplied, already-open `DatabaseSync` handle — this module never
// opens or closes a store connection itself) and one on-disk file read
// (`ledger.json`, via `readLedger`). No git read, no other file read, no
// process spawn, and no mutation (no INSERT, UPDATE, or DELETE) happens
// anywhere here. The store SELECT is neither a git read nor a
// live-repository read, so it is a distinct, permitted I/O kind alongside
// the file reads this package otherwise does.
//
// `ClaimsParityResult.mode` (`../engine/verification.ts`) is typed as a bare
// `string` and can hold values such as "invalid-mixed" that
// `computeClaimsParity` returns unvalidated; narrowing it to
// `VerificationMode` below takes a type assertion, mirroring the existing
// `verificationMode as VerificationMode` cast in `./replay.ts`. That
// looseness originates in verification.ts and is not addressed here.

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { TaskRow } from "../store/types.ts";
import { readLedger } from "../store/evidence.ts";
import type { BarrierAttemptRecord } from "../engine/barrier.ts";
import type { VerificationMode } from "../engine/predicates.ts";

export function assembleReplayInputs(
  db: DatabaseSync,
  task: TaskRow,
  opts: { root: string },
): { specPath: string | null; verificationMode: VerificationMode; integrationCommit: string | null } {
  const specPath = task.brief_path === null ? null : path.resolve(opts.root, task.brief_path);

  const integrationRow = db
    .prepare(
      `SELECT result_commit FROM integrations WHERE run_id = ? AND task_id = ? AND disposition = 'integrated' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(task.run_id, task.id) as { result_commit: string | null } | undefined;
  const integrationCommit = integrationRow?.result_commit ?? null;

  const taskDir = path.join(opts.root, ".orga", "runs", task.run_id, "tasks", task.id);
  const attempts = (readLedger(taskDir)?.attempts ?? []) as BarrierAttemptRecord[];
  // Mirrors disposition.ts:47's attempt-selection precedence exactly; a
  // change to either expression is a prompt to check the other.
  const selectedAttempt = attempts.find((a) => a.verdict === "pass") ?? attempts[attempts.length - 1];
  const verificationMode = (selectedAttempt?.claimsParity?.mode ?? "legacy") as VerificationMode;

  return { specPath, verificationMode, integrationCommit };
}
