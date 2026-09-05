import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        board_path TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        state TEXT NOT NULL,
        terminal_reason TEXT,
        config_snapshot_ref TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_key TEXT NOT NULL,
        title TEXT NOT NULL,
        brief_path TEXT,
        workflow_id TEXT NOT NULL,
        stage_id TEXT,
        depends_on TEXT NOT NULL,
        priority INTEGER NOT NULL,
        state TEXT NOT NULL,
        disposition TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        role TEXT NOT NULL,
        round INTEGER NOT NULL,
        input_version TEXT NOT NULL,
        vendor TEXT NOT NULL,
        model TEXT NOT NULL,
        config_json TEXT NOT NULL,
        mutating INTEGER NOT NULL,
        status TEXT NOT NULL,
        interrupt_reason TEXT,
        packet_ref TEXT,
        report_ref TEXT,
        exit_code INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        CHECK (
          (status = 'interrupted' AND interrupt_reason IS NOT NULL)
          OR (status != 'interrupted' AND interrupt_reason IS NULL)
        )
      );

      CREATE UNIQUE INDEX attempts_idempotency_key
        ON attempts (run_id, task_id, stage_id, round, input_version);

      CREATE TABLE workers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        pgid INTEGER NOT NULL,
        worktree_id TEXT,
        heartbeat_at INTEGER NOT NULL,
        termination_state TEXT,
        exit_code INTEGER,
        exit_signal TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX claims_task_dimension
        ON claims (task_id, dimension);

      CREATE TABLE gates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        gate_type TEXT NOT NULL,
        round INTEGER NOT NULL,
        verdict TEXT,
        evidence_ref TEXT,
        cap INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );

      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT,
        owner TEXT NOT NULL,
        blocking_scope TEXT NOT NULL,
        prompt TEXT NOT NULL,
        safe_default TEXT,
        answer TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );

      CREATE TABLE integrations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        candidate_ref TEXT NOT NULL,
        result_commit TEXT,
        checks TEXT NOT NULL,
        disposition TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        cleanup_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        cleaned_at INTEGER
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        task_id TEXT,
        attempt_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX events_run_seq
        ON events (run_id, seq);

      CREATE TABLE locks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        resource TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        released_at INTEGER
      );

      CREATE UNIQUE INDEX locks_active_kind_resource
        ON locks (kind, resource)
        WHERE released_at IS NULL;

      CREATE TABLE control (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE minor_finding_appends (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        appended_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX minor_finding_appends_idempotency_key
        ON minor_finding_appends (run_id, task_id, attempt_id);
    `,
  },
];

export function appliedMigrationVersions(db: DatabaseSync): Set<number> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  return new Set(rows.map((row) => row.version));
}

export function applyMigrations(db: DatabaseSync, now: () => number = Date.now): void {
  const applied = appliedMigrationVersions(db);
  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version)).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        now(),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
