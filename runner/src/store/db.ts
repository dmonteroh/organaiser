import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { applyMigrations } from "./migrations.ts";

const ORGA_YAML = "orga.yaml";
const ORGA_DIR = ".orga";
const STATE_DB = "state.sqlite";
const RESOLVED_CONFIG = "config.resolved.json";

export class ProjectRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectRootError";
  }
}

export class StoreSymlinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreSymlinkError";
  }
}

function hasAdjacentOrgaDir(dir: string): boolean {
  const orgaDir = path.join(dir, ORGA_DIR);
  return (
    fs.existsSync(path.join(orgaDir, STATE_DB)) || fs.existsSync(path.join(orgaDir, RESOLVED_CONFIG))
  );
}

// A directory qualifies as project root only when it carries BOTH orga.yaml
// AND an adjacent .orga/ state directory. A bare orga.yaml with no adjacent
// .orga/ is the shape of a task-worktree checkout, so discovery keeps
// walking upward past it instead of stopping there.
export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  let lastOrgaYamlDir: string | null = null;

  while (true) {
    if (fs.existsSync(path.join(dir, ORGA_YAML))) {
      lastOrgaYamlDir = dir;
      if (hasAdjacentOrgaDir(dir)) {
        return dir;
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      if (lastOrgaYamlDir !== null) {
        throw new ProjectRootError(
          `no project root found searching upward from ${startDir}: the last ${ORGA_YAML} seen was ` +
            `${path.join(lastOrgaYamlDir, ORGA_YAML)}, which has no adjacent ${ORGA_DIR}/${STATE_DB} or ` +
            `${ORGA_DIR}/${RESOLVED_CONFIG}`,
        );
      }
      throw new ProjectRootError(
        `no project root found searching upward from ${startDir}: no ${ORGA_YAML} was found`,
      );
    }
    dir = parent;
  }
}

// Every ancestor directory from `root` down to `target` (inclusive) must not
// be a symlink. Mirrors artifact-ref.ts's containment discipline: spelling
// alone is not trusted, every path component is inspected directly.
export function assertNoSymlinkAncestry(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel !== "" && (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel))) {
    throw new StoreSymlinkError(`path is outside root: ${target}`);
  }

  const segments = rel === "" ? [] : rel.split(path.sep);
  let current = resolvedRoot;
  assertSegmentNotSymlink(current);
  for (const segment of segments) {
    current = path.join(current, segment);
    assertSegmentNotSymlink(current);
  }
}

function assertSegmentNotSymlink(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new StoreSymlinkError(`path component is a symlink: ${dir}`);
  }
}

export function openStore(root: string): DatabaseSync {
  const resolvedRoot = path.resolve(root);
  const orgaDir = path.join(resolvedRoot, ORGA_DIR);
  if (!fs.existsSync(orgaDir)) {
    throw new ProjectRootError(`no ${ORGA_DIR} directory at ${resolvedRoot}; run \`orga init\` first`);
  }
  assertNoSymlinkAncestry(resolvedRoot, orgaDir);

  const dbPath = path.join(orgaDir, STATE_DB);
  const dbExisted = fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(db);
  if (!dbExisted) {
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best-effort on platforms without POSIX permission bits
    }
  }
  return db;
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback failure is secondary to the original error
    }
    throw err;
  }
}
