import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { findProjectRoot, openStore, withTransaction, ProjectRootError, StoreSymlinkError } from "../src/store/db.ts";
import { initProject } from "../src/store/init.ts";
import { withTempWorkspace } from "./helpers/workspace.ts";

test("findProjectRoot finds a directory with orga.yaml and an adjacent .orga/state.sqlite", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    openStore(dir).close();

    const nested = path.join(dir, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(findProjectRoot(nested), dir);
  });
});

test("findProjectRoot skips a bare orga.yaml with no adjacent .orga/ (task-worktree shape)", async () => {
  await withTempWorkspace(async (dir) => {
    const outer = path.join(dir, "outer");
    fs.mkdirSync(outer, { recursive: true });
    initProject(outer);
    openStore(outer).close();

    const worktree = path.join(outer, "worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "orga.yaml"), "runner:\n  version: \"0.0.0\"\n");

    const nested = path.join(worktree, "nested");
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(findProjectRoot(nested), outer);
  });
});

test("findProjectRoot throws a typed error naming the last orga.yaml seen when none qualifies", async () => {
  await withTempWorkspace(async (dir) => {
    const worktree = path.join(dir, "worktree");
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, "orga.yaml"), "runner:\n  version: \"0.0.0\"\n");

    assert.throws(
      () => findProjectRoot(worktree),
      (err: unknown) => {
        assert.ok(err instanceof ProjectRootError);
        assert.match((err as Error).message, /orga\.yaml/);
        return true;
      },
    );
  });
});

test("findProjectRoot never auto-creates .orga/", async () => {
  await withTempWorkspace(async (dir) => {
    fs.writeFileSync(path.join(dir, "orga.yaml"), "runner:\n  version: \"0.0.0\"\n");
    assert.throws(() => findProjectRoot(dir), ProjectRootError);
    assert.equal(fs.existsSync(path.join(dir, ".orga")), false);
  });
});

test("openStore opens node:sqlite in WAL mode and applies migrations, recording the version", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(mode.journal_mode, "wal");

      const applied = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
      assert.deepEqual(applied.map((r) => r.version), [1]);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      for (const entity of [
        "runs",
        "tasks",
        "attempts",
        "workers",
        "claims",
        "gates",
        "questions",
        "integrations",
        "worktrees",
        "events",
        "locks",
        "control",
        "schema_migrations",
      ]) {
        assert.ok(names.includes(entity), `missing table ${entity}`);
      }
    } finally {
      db.close();
    }
  });
});

test("openStore applying migrations twice is idempotent", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    openStore(dir).close();
    const db = openStore(dir);
    try {
      const applied = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
      assert.deepEqual(applied.map((r) => r.version), [1]);
    } finally {
      db.close();
    }
  });
});

test("openStore state.sqlite is created mode 0o600", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    openStore(dir).close();
    const dbMode = fs.statSync(path.join(dir, ".orga", "state.sqlite")).mode & 0o777;
    assert.equal(dbMode, 0o600);
  });
});

test("openStore refuses to proceed when .orga/ is a symlink", async () => {
  await withTempWorkspace(async (dir) => {
    const realOrga = path.join(dir, "real-orga");
    fs.mkdirSync(realOrga, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "orga.yaml"), "runner:\n  version: \"0.0.0\"\n");
    fs.symlinkSync(realOrga, path.join(dir, ".orga"), "dir");

    assert.throws(() => openStore(dir), StoreSymlinkError);
  });
});

test("openStore refuses to proceed when an ancestor up to the project root is a symlink", async () => {
  await withTempWorkspace(async (dir) => {
    const realProject = path.join(dir, "real-project");
    fs.mkdirSync(realProject, { recursive: true });
    initProject(realProject);
    openStore(realProject).close();

    const symlinkedProject = path.join(dir, "linked-project");
    fs.symlinkSync(realProject, symlinkedProject, "dir");

    assert.throws(() => openStore(symlinkedProject), StoreSymlinkError);
  });
});

test("withTransaction commits on success and rolls back on throw", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run("run-1", "board.yaml", "running", "starting", Date.now());
      });
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);

      assert.throws(() => {
        withTransaction(db, () => {
          db.prepare(
            "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
          ).run("run-2", "board.yaml", "running", "starting", Date.now());
          throw new Error("boom");
        });
      }, /boom/);

      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });
});

test("attempts CHECK constraint pairs status='interrupted' with a non-null interrupt_reason", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const db = openStore(dir);
    try {
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO runs (id, board_path, desired_state, state, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run("run-1", "board.yaml", "running", "starting", Date.now());
        db.prepare(
          `INSERT INTO tasks (id, run_id, task_key, title, workflow_id, depends_on, priority, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run("task-1", "run-1", "T1", "Title", "dev", "[]", 100, "defined", Date.now(), Date.now());
      });

      assert.throws(() => {
        withTransaction(db, () => {
          db.prepare(
            `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            "attempt-1",
            "run-1",
            "task-1",
            "implement",
            "implementer",
            1,
            "v1",
            "claude",
            "sonnet",
            "{}",
            0,
            "interrupted",
            Date.now(),
          );
        });
      });

      withTransaction(db, () => {
        db.prepare(
          `INSERT INTO attempts (id, run_id, task_id, stage_id, role, round, input_version, vendor, model, config_json, mutating, status, interrupt_reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "attempt-2",
          "run-1",
          "task-1",
          "implement",
          "implementer",
          1,
          "v2",
          "claude",
          "sonnet",
          "{}",
          0,
          "interrupted",
          "operator-pause",
          Date.now(),
        );
      });

      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n, 1);
    } finally {
      db.close();
    }
  });
});
