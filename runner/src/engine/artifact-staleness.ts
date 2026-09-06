import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "../store/db.ts";
import { STAGE_DEFINITIONS } from "./scheduler.ts";

interface AffectedTaskStageRow {
  task_id: string;
  stage_id: string;
}

export function markDownstreamArtifactsStale(
  db: DatabaseSync,
  runId: string,
  changedArtifactPath: string,
  now: number,
): void {
  const rows = db
    .prepare(
      `WITH RECURSIVE stale_paths(path) AS (
         SELECT ?
         UNION
         SELECT ad.artifact_path
         FROM artifact_dependencies ad
         JOIN stale_paths sp ON ad.depends_on_path = sp.path
         WHERE ad.run_id = ?
       )
       SELECT ad.task_id AS task_id, ad.stage_id AS stage_id
       FROM artifact_dependencies ad
       JOIN stale_paths sp ON ad.depends_on_path = sp.path
       WHERE ad.run_id = ?`,
    )
    .all(changedArtifactPath, runId, runId) as unknown as AffectedTaskStageRow[];

  const stageIdsByTaskId = new Map<string, string[]>();
  for (const row of rows) {
    const stageIds = stageIdsByTaskId.get(row.task_id) ?? [];
    stageIds.push(row.stage_id);
    stageIdsByTaskId.set(row.task_id, stageIds);
  }

  withTransaction(db, () => {
    for (const [taskId, stageIds] of stageIdsByTaskId) {
      const earliestStageId = earliestStage(stageIds);
      if (earliestStageId === null) continue;
      db.prepare(`UPDATE tasks SET stale_at = ?, stage_id = ? WHERE id = ?`).run(
        now,
        earliestStageId,
        taskId,
      );
    }
  });
}

function earliestStage(stageIds: readonly string[]): string | null {
  let earliestIndex = Number.POSITIVE_INFINITY;
  let earliestStageId: string | null = null;
  for (const stageId of stageIds) {
    const index = STAGE_DEFINITIONS.findIndex((stage) => stage.id === stageId);
    if (index === -1) continue;
    if (index < earliestIndex) {
      earliestIndex = index;
      earliestStageId = stageId;
    }
  }
  return earliestStageId;
}
