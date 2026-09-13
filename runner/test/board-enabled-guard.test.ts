import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This test guards a single invariant: any board-building helper that feeds
// `board.spec.tasks` into `startRun` must keep its task literals at
// `enabled: false`. A later phase materializes `board.spec.tasks` into real
// DB rows, and any helper that ships `enabled: true` collides with that
// materialization the first time someone copies an existing fixture.
//
// Scope is computed, not listed: a `.ts` file under `runner/test/`,
// `runner/evals/`, or `runner/scripts/` is in scope when it (a) imports
// `startRun` from `supervisor-spawn.ts`, or (b) imports one of the harness
// board-helper functions from `harness.ts`, or (c) contains the adjacent CLI
// argv tokens `"run", "start"`. Any in-scope line matching `enabled: true` is
// a violation unless a `board-enabled-waiver:` marker with a written reason
// appears on that line or the nearest preceding non-blank line.
//
// Clause (a): a real named import of startRun from supervisor-spawn.ts.
// The `m` flag plus the line-start anchor is what rejects a prose mention
// of `startRun` inside a comment; `[^}]*` spans newlines inside the brace
// group but cannot escape past the group's closing brace.
const CLAUSE_A = /^[ \t]*import\s*\{[^}]*\bstartRun\b[^}]*\}\s*from\s*"[^"]*supervisor-spawn\.ts"/m;

// Clause (b): a real named import of any harness board helper.
const CLAUSE_B = /^[ \t]*import\s*\{[^}]*\b(?:boardWithTasks|writeFixtureFiles|startFixtureRun|startGitFixtureRun)\b[^}]*\}\s*from\s*"[^"]*harness\.ts"/m;

// Clause (c): "adjacent" means immediately consecutive array elements,
// that is the two double-quoted tokens separated only by a comma and
// optional whitespace, newlines included. Nothing else counts as adjacent.
const CLAUSE_C = /"run"\s*,\s*"start"/;

// The needle and its waiver.
const ENABLED_TRUE = /\benabled\s*:\s*true\b/;
const WAIVER = /board-enabled-waiver:\s*\S/;

// Three files are confirmed excluded by the predicate:
// - runner/test/import-markdown.test.ts asserts production `importMarkdown`
//   behavior, including statuses that correctly map to `enabled: true`; it
//   never calls `startRun`.
// - runner/test/board-validate.test.ts reaches only `board validate` and
//   `run dry-run`, neither of which calls `startRun`.
// - runner/test/release-assets.test.ts reaches no CLI command at all.
//
// The guard's honest limit: a `board-enabled-waiver:` marker is defeatable
// by an implementer who adds one instead of fixing a real regression. Its
// protection is that the marker is a loud, greppable, reviewable diff line
// carrying a written reason, not that it is impossible to misuse.

const SCAN_DIRS = ["test", "evals", "scripts"];
const SELF_PATH = fileURLToPath(import.meta.url);

function walkTsFiles(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push(path.resolve(full));
      }
    }
  }
  return found;
}

const runnerRoot = fileURLToPath(new URL("../", import.meta.url));
const candidates = SCAN_DIRS.flatMap((dir) => walkTsFiles(path.join(runnerRoot, dir))).filter(
  (file) => file !== SELF_PATH,
);

interface SelectedFile {
  file: string;
  source: string;
  clauses: { a: boolean; b: boolean; c: boolean };
}

const selected: SelectedFile[] = [];
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  const a = CLAUSE_A.test(source);
  const b = CLAUSE_B.test(source);
  const c = CLAUSE_C.test(source);
  if (a || b || c) {
    selected.push({ file, source, clauses: { a, b, c } });
  }
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

const violations: Violation[] = [];
for (const { file, source } of selected) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!ENABLED_TRUE.test(line)) continue;
    if (WAIVER.test(line)) continue;
    let waived = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j] as string;
      if (prev.trim() === "") continue;
      waived = WAIVER.test(prev);
      break;
    }
    if (!waived) {
      violations.push({ file, line: i + 1, text: line });
    }
  }
}

test("no in-scope board-building helper contains an unwaived `enabled: true`", () => {
  const message = violations.map((v) => `${v.file}:${v.line}: ${v.text.trim()}`).join("\n");
  assert.deepEqual(violations, [], `unwaived enabled: true found:\n${message}`);
});

test("each predicate clause selects at least one file", () => {
  const countA = selected.filter((s) => s.clauses.a).length;
  const countB = selected.filter((s) => s.clauses.b).length;
  const countC = selected.filter((s) => s.clauses.c).length;
  assert.ok(countA >= 1, "clause (a) matched no files; a matcher that silently stops matching must fail loudly");
  assert.ok(countB >= 1, "clause (b) matched no files; a matcher that silently stops matching must fail loudly");
  assert.ok(countC >= 1, "clause (c) matched no files; a matcher that silently stops matching must fail loudly");
});
