// The command surface's exit-code contract (goals spec section 25.3), plus
// the mapping from a run's terminal disposition to the matching code. Every
// command in commands.ts returns a value from this table; nothing else in
// the CLI computes an exit code on its own.

import type { RunState } from "../store/types.ts";

export const EXIT_CODES = {
  OK: 0,
  INVALID_ARGS: 2,
  NOT_FOUND: 3,
  STATE_CONFLICT: 4,
  WAITING_OPERATOR: 10,
  BLOCKED: 11,
  FAILED: 12,
  CANCELLED: 13,
  WAIT_TIMEOUT: 14,
  VENDOR_UNAVAILABLE: 15,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const KNOWN_EXIT_CODES: readonly ExitCode[] = Object.values(EXIT_CODES);

// Only the five dispositions goals spec section 25.3 names a code for.
// Every other `RunState` (`starting`, `running`, `cancelling`; `paused`,
// which `withOperatorTermination` writes to `runs.state` despite not
// appearing in this store's own `RunState` union) is "still going": callers
// that need to keep waiting on those treat a null return as "not yet
// terminal."
const RUN_STATE_EXIT_CODES: Readonly<Partial<Record<string, ExitCode>>> = {
  succeeded: EXIT_CODES.OK,
  "waiting-operator": EXIT_CODES.WAITING_OPERATOR,
  blocked: EXIT_CODES.BLOCKED,
  failed: EXIT_CODES.FAILED,
  cancelled: EXIT_CODES.CANCELLED,
};

export function runStateToExitCode(state: RunState | string): ExitCode | null {
  return RUN_STATE_EXIT_CODES[state] ?? null;
}
