import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { openStore } from "../store/db.ts";
import { redactorForRoot } from "../store/redact.ts";
import type { AttemptRow, QuestionRow, TaskRow, TaskState, WorkerRow } from "../store/types.ts";

type Bucket = "queued" | "active" | "attention" | "terminal";

const QUEUED_STATES: ReadonlySet<TaskState> = new Set([
  "defined",
  "needs-refinement",
  "ready-to-implement",
  "ready-to-integrate",
]);

const ACTIVE_STATES: ReadonlySet<TaskState> = new Set([
  "specifying",
  "refining",
  "implementing",
  "verifying",
  "spec-review",
  "quality-review",
  "integrating",
]);

const ATTENTION_STATES: ReadonlySet<TaskState> = new Set(["waiting-operator", "parked"]);

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["integrated", "superseded", "shelved", "cancelled"]);

const BUCKET_ORDER: ReadonlyArray<{ bucket: Bucket; title: string }> = [
  { bucket: "queued", title: "Queued" },
  { bucket: "active", title: "Active" },
  { bucket: "attention", title: "Attention" },
  { bucket: "terminal", title: "Terminal" },
];

function bucketFor(state: TaskState): Bucket {
  if (QUEUED_STATES.has(state)) return "queued";
  if (ACTIVE_STATES.has(state)) return "active";
  if (ATTENTION_STATES.has(state)) return "attention";
  if (TERMINAL_STATES.has(state)) return "terminal";
  throw new Error(`unmapped task state: ${state}`);
}

function parseDependsOn(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function defaultBoardPath(root: string, runId: string): string {
  return path.join(path.resolve(root), ".orga", "runs", runId, "BOARD.md");
}

function ensureSecureOutputDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
}

function writeAtomic(root: string, outputPath: string, content: string): void {
  const dir = path.dirname(outputPath);
  ensureSecureOutputDir(dir);
  const redacted = redactorForRoot(root, process.env)(content);
  const tmpPath = path.join(dir, `.${path.basename(outputPath)}.tmp-${randomUUID()}`);
  fs.writeFileSync(tmpPath, redacted, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, outputPath);
  fs.chmodSync(outputPath, 0o600);
}

function latestAttemptsByTask(attempts: readonly AttemptRow[]): Map<string, AttemptRow> {
  const sorted = [...attempts].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.round - b.round;
  });
  const latest = new Map<string, AttemptRow>();
  for (const attempt of sorted) {
    latest.set(attempt.task_id, attempt);
  }
  return latest;
}

function formatTaskLine(task: TaskRow, attempt: AttemptRow | undefined): string {
  const attemptSuffix = attempt ? `, latest attempt: ${attempt.vendor} (${attempt.status})` : "";
  return `- \`${task.id}\` ${task.title} [${task.state}]${attemptSuffix}`;
}

function formatWorkerLine(worker: WorkerRow, now: number): string {
  const heartbeatAgeMs = Math.max(0, now - worker.heartbeat_at);
  return `- pid ${worker.pid}, heartbeat age ${heartbeatAgeMs}ms`;
}

function formatQuestionLine(question: QuestionRow): string {
  return `- [${question.blocking_scope}] owner=${question.owner}: ${question.prompt}`;
}

function renderMarkdown(
  runId: string,
  now: number,
  tasksByBucket: Map<Bucket, TaskRow[]>,
  latestAttempts: Map<string, AttemptRow>,
  activeWorkers: readonly WorkerRow[],
  pendingQuestions: readonly QuestionRow[],
  nextEligible: readonly TaskRow[],
): string {
  const lines: string[] = [];
  lines.push(`# Board status: ${runId}`);
  lines.push("");
  lines.push(`Generated ${new Date(now).toISOString()}.`);
  lines.push("");
  lines.push("Bucket definitions:");
  lines.push(
    "- **queued** — defined, needs-refinement, ready-to-implement, ready-to-integrate",
  );
  lines.push(
    "- **active** — specifying, refining, implementing, verifying, spec-review, quality-review, integrating",
  );
  lines.push("- **attention** — waiting-operator, parked");
  lines.push("- **terminal** — integrated, superseded, shelved, cancelled");
  lines.push("");

  for (const { bucket, title } of BUCKET_ORDER) {
    const tasks = tasksByBucket.get(bucket) ?? [];
    lines.push(`## ${title}`);
    if (tasks.length === 0) {
      lines.push("(none)");
    } else {
      for (const task of tasks) {
        lines.push(formatTaskLine(task, latestAttempts.get(task.id)));
      }
    }
    lines.push("");
  }

  lines.push("## Active workers");
  if (activeWorkers.length === 0) {
    lines.push("(none)");
  } else {
    for (const worker of activeWorkers) {
      lines.push(formatWorkerLine(worker, now));
    }
  }
  lines.push("");

  lines.push("## Pending questions");
  if (pendingQuestions.length === 0) {
    lines.push("(none)");
  } else {
    for (const question of pendingQuestions) {
      lines.push(formatQuestionLine(question));
    }
  }
  lines.push("");

  lines.push("## Next eligible work");
  lines.push(
    "This checks dependency completion only; it does not check claim availability, worker/vendor slots, " +
      "gates, the readiness probe, or locks (goals-spec section 12's other eight conditions). Real eligibility " +
      "is P8c's undelivered scope.",
  );
  if (nextEligible.length === 0) {
    lines.push("(none)");
  } else {
    for (const task of nextEligible) {
      lines.push(`- \`${task.id}\` ${task.title}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export function renderBoard(root: string, runId: string, outputPath?: string): string {
  const db = openStore(root);
  try {
    const tasks = db
      .prepare(`SELECT * FROM tasks WHERE run_id = ? ORDER BY priority ASC, created_at ASC`)
      .all(runId) as unknown as TaskRow[];
    const attempts = db.prepare(`SELECT * FROM attempts WHERE run_id = ?`).all(runId) as unknown as AttemptRow[];
    const activeWorkers = db
      .prepare(`SELECT * FROM workers WHERE run_id = ? AND termination_state IS NULL ORDER BY started_at ASC`)
      .all(runId) as unknown as WorkerRow[];
    const pendingQuestions = db
      .prepare(`SELECT * FROM questions WHERE run_id = ? AND status != 'answered' ORDER BY created_at ASC`)
      .all(runId) as unknown as QuestionRow[];

    const tasksByBucket = new Map<Bucket, TaskRow[]>();
    const bucketById = new Map<string, Bucket>();
    for (const task of tasks) {
      const bucket = bucketFor(task.state);
      bucketById.set(task.id, bucket);
      const bucketList = tasksByBucket.get(bucket) ?? [];
      bucketList.push(task);
      tasksByBucket.set(bucket, bucketList);
    }

    const nextEligible = (tasksByBucket.get("queued") ?? []).filter((task) => {
      const deps = parseDependsOn(task.depends_on);
      return deps.every((depId) => bucketById.get(depId) === "terminal");
    });

    const latestAttempts = latestAttemptsByTask(attempts);
    const now = Date.now();
    const content = renderMarkdown(
      runId,
      now,
      tasksByBucket,
      latestAttempts,
      activeWorkers,
      pendingQuestions,
      nextEligible,
    );

    const finalPath = outputPath ? path.resolve(outputPath) : defaultBoardPath(root, runId);
    writeAtomic(root, finalPath, content);
    return finalPath;
  } finally {
    db.close();
  }
}
