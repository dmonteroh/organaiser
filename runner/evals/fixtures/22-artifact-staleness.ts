// Fixture: artifact-staleness.
//
// One claim about `markDownstreamArtifactsStale`
// (`src/engine/artifact-staleness.ts`): an upstream artifact change marks
// every transitively-dependent downstream artifact's owning task stale, and
// routes each affected task back to the earliest stage among that task's own
// affected artifacts — while a task with no dependency on the changed
// artifact is left untouched.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { openStore, withTransaction, startFixtureRun, seedTasks, readTaskRow, withFixtureWorkspace } from "./harness.ts";
import { markDownstreamArtifactsStale } from "../../src/engine/artifact-staleness.ts";

function seedDependency(
  db: ReturnType<typeof openStore>,
  runId: string,
  taskId: string,
  stageId: string,
  artifactPath: string,
  dependsOnPath: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO artifact_dependencies (id, run_id, task_id, stage_id, artifact_path, depends_on_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), runId, taskId, stageId, artifactPath, dependsOnPath, now);
}

export async function upstreamChangeRoutesTransitiveDownstreamToEarliestStage(): Promise<void> {
  await withFixtureWorkspace(async (dir) => {
    const { runId } = startFixtureRun(dir, [
      { id: "task-a" },
      { id: "task-downstream" },
      { id: "task-unrelated" },
    ]);
    const now = Date.now();
    seedTasks(
      dir,
      runId,
      [{ id: "task-a" }, { id: "task-downstream" }, { id: "task-unrelated" }],
      now,
    );

    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare(`UPDATE tasks SET stage_id = 'implementation' WHERE id = 'task-a'`).run();
        db.prepare(`UPDATE tasks SET stage_id = 'integration' WHERE id = 'task-downstream'`).run();
        db.prepare(`UPDATE tasks SET stage_id = 'implementation' WHERE id = 'task-unrelated'`).run();

        // task-a produces design.md, derived from the upstream spec.md.
        seedDependency(db, runId, "task-a", "task-refinement", "design.md", "spec.md", now);

        // task-downstream produces two artifacts derived from design.md, at
        // two different stages: staleness must route it to the earlier one.
        seedDependency(db, runId, "task-downstream", "implementation", "code.ts", "design.md", now);
        seedDependency(db, runId, "task-downstream", "integration", "review.md", "design.md", now);

        // task-unrelated's artifact has no dependency on spec.md or design.md.
        seedDependency(db, runId, "task-unrelated", "implementation", "other.ts", "other-spec.md", now);
      });

      markDownstreamArtifactsStale(db, runId, "spec.md", now);
    } finally {
      db.close();
    }

    const taskA = readTaskRow(dir, "task-a");
    assert.equal(taskA?.stale_at, now, "task-a's directly-dependent artifact must be marked stale");
    assert.equal(taskA?.stage_id, "task-refinement", "task-a must route back to its own earliest affected stage");

    const taskDownstream = readTaskRow(dir, "task-downstream");
    assert.equal(
      taskDownstream?.stale_at,
      now,
      "task-downstream must be marked stale transitively through design.md",
    );
    assert.equal(
      taskDownstream?.stage_id,
      "implementation",
      "task-downstream must route back to the earliest of its own two affected stages",
    );

    const taskUnrelated = readTaskRow(dir, "task-unrelated");
    assert.equal(taskUnrelated?.stale_at, null, "an unrelated task must not be marked stale");
    assert.equal(taskUnrelated?.stage_id, "implementation", "an unrelated task's stage must be untouched");
  });
}
