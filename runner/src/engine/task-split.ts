import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import type { TaskState } from "../store/types.ts";

export interface ChildTaskSpec {
  id: string;
  runId: string;
  taskKey: string;
  title: string;
  briefPath: string | null;
  workflowId: string;
  stageId: string | null;
  dependsOn: readonly string[];
  priority: number;
  state: TaskState;
  disposition: string | null;
}

export function splitTask(
  db: DatabaseSync,
  parentTaskId: string,
  children: readonly ChildTaskSpec[],
  now: number,
): void {
  withTransaction(db, () => {
    for (const child of children) {
      db.prepare(
        `INSERT INTO tasks (id, run_id, task_key, title, brief_path, workflow_id, stage_id, depends_on, priority, state, disposition, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        child.id,
        child.runId,
        child.taskKey,
        child.title,
        child.briefPath,
        child.workflowId,
        child.stageId,
        JSON.stringify(child.dependsOn),
        child.priority,
        child.state,
        child.disposition,
        now,
        now,
      );
    }

    db.prepare(`UPDATE tasks SET disposition = 'superseded', updated_at = ? WHERE id = ?`).run(
      now,
      parentTaskId,
    );
  });
}
