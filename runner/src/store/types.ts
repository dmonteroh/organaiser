// Declaration-only module: the store's single source of truth for entity row
// shapes and status vocabularies. Every other store module, and every P5
// sibling, imports from here rather than declaring its own copy.

export type RunState =
  | "starting"
  | "running"
  | "waiting-operator"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled";

export type TaskState =
  | "defined"
  | "specifying"
  | "needs-refinement"
  | "refining"
  | "ready-to-implement"
  | "implementing"
  | "verifying"
  | "spec-review"
  | "quality-review"
  | "ready-to-integrate"
  | "integrating"
  | "integrated"
  | "waiting-operator"
  | "parked"
  | "superseded"
  | "shelved"
  | "cancelled";

export type AttemptStatus = "pending" | "running" | "completed" | "failed" | "interrupted";

// Each value carries a distinct redispatch policy:
//   operator-pause:     redispatches fresh on `run resume`.
//   operator-cancel:    never redispatched.
//   supervisor-crash:   redispatches only after startup reconciliation
//                       classifies the attempt `exited` or `stale` and
//                       clears it for retry.
//   stale-lease:        same reconciliation path as supervisor-crash.
//   indeterminate:      never redispatched automatically.
export type InterruptReason =
  | "operator-pause"
  | "operator-cancel"
  | "supervisor-crash"
  | "stale-lease"
  | "indeterminate";

export type TerminationState = "exited" | "signalled" | "reclaimed";

export type GateVerdict = "pass" | "fail" | "pending";

export type QuestionBlockingScope = "task" | "run";

export type QuestionStatus = "open" | "answered" | "withdrawn";

export type IntegrationDisposition = "pending" | "integrated" | "rejected";

export type WorktreeCleanupState = "active" | "cleaned" | "orphaned";

export type LockKind = "run-lease" | "task-stage" | "controller" | "integration";

export type ControlKind = "pause" | "pause-now" | "cancel" | "cancel-now" | "resume";

export interface RunRow {
  id: string;
  board_path: string;
  desired_state: string;
  state: RunState;
  terminal_reason: string | null;
  config_snapshot_ref: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface TaskRow {
  id: string;
  run_id: string;
  task_key: string;
  title: string;
  brief_path: string | null;
  workflow_id: string;
  stage_id: string | null;
  depends_on: string;
  priority: number;
  state: TaskState;
  disposition: string | null;
  stale_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AttemptRow {
  id: string;
  run_id: string;
  task_id: string;
  stage_id: string;
  role: string;
  round: number;
  input_version: string;
  vendor: string;
  model: string;
  config_json: string;
  mutating: 0 | 1;
  status: AttemptStatus;
  interrupt_reason: InterruptReason | null;
  packet_ref: string | null;
  report_ref: string | null;
  exit_code: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface WorkerRow {
  id: string;
  run_id: string;
  attempt_id: string;
  pid: number;
  pgid: number;
  worktree_id: string | null;
  heartbeat_at: number;
  termination_state: TerminationState | null;
  exit_code: number | null;
  exit_signal: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface ClaimRow {
  id: string;
  run_id: string;
  task_id: string;
  dimension: string;
  value: string;
  created_at: number;
}

export interface GateRow {
  id: string;
  run_id: string;
  task_id: string;
  gate_type: string;
  round: number;
  verdict: GateVerdict | null;
  evidence_ref: string | null;
  cap: number;
  created_at: number;
  decided_at: number | null;
}

export interface QuestionRow {
  id: string;
  run_id: string;
  task_id: string | null;
  owner: string;
  blocking_scope: QuestionBlockingScope;
  prompt: string;
  safe_default: string | null;
  answer: string | null;
  status: QuestionStatus;
  created_at: number;
  answered_at: number | null;
  payload: string | null;
}

export interface IntegrationRow {
  id: string;
  run_id: string;
  task_id: string;
  base_commit: string;
  candidate_ref: string;
  result_commit: string | null;
  checks: string;
  disposition: IntegrationDisposition;
  created_at: number;
  completed_at: number | null;
}

export interface WorktreeRow {
  id: string;
  run_id: string;
  task_id: string;
  path: string;
  branch: string;
  base_commit: string;
  cleanup_state: WorktreeCleanupState;
  created_at: number;
  cleaned_at: number | null;
}

export interface EventRow {
  id: string;
  run_id: string;
  seq: number;
  task_id: string | null;
  attempt_id: string | null;
  type: string;
  payload: string;
  created_at: number;
}

export interface LockRow {
  id: string;
  run_id: string;
  kind: LockKind;
  resource: string;
  owner_pid: number;
  acquired_at: number;
  heartbeat_at: number;
  released_at: number | null;
}

export interface ControlRow {
  id: string;
  run_id: string;
  kind: ControlKind;
  created_at: number;
  acked_at: number | null;
}
