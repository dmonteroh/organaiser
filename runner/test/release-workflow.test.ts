import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const WORKFLOW_PATH = fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url));
const text = fs.readFileSync(WORKFLOW_PATH, "utf8");

test("release workflow", async (t) => {
  await t.test("AC10 cwd guard: no working-directory override anywhere", () => {
    assert.ok(!text.includes("working-directory"));
  });

  await t.test("AC7: no npm publish step", () => {
    assert.ok(!text.includes("npm publish"));
  });

  await t.test("AC8: the only secrets reference is secrets.GITHUB_TOKEN", () => {
    const matches = text.match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    assert.ok(matches.length > 0, "expected at least one secrets reference");
    for (const match of matches) {
      assert.equal(match, "secrets.GITHUB_TOKEN");
    }
  });

  await t.test("AC3: full checkout depth and a shallow-repository guard", () => {
    assert.ok(text.includes("fetch-depth: 0"));
    assert.ok(text.includes("--is-shallow-repository"));
  });

  await t.test("AC4: exactly one permissions block, contents: write only", () => {
    const permissionsMatches = text.match(/permissions:/g) ?? [];
    assert.equal(permissionsMatches.length, 1);

    const lines = text.split("\n");
    const permissionsIndex = lines.findIndex((line) => line.includes("permissions:"));
    assert.ok(permissionsIndex !== -1);

    const permissionsIndent = lines[permissionsIndex].match(/^(\s*)/)?.[1].length ?? 0;
    const blockLines: string[] = [];
    for (let i = permissionsIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= permissionsIndent) break;
      blockLines.push(line.trim());
    }

    assert.deepEqual(blockLines, ["contents: write"]);
  });

  await t.test("AC5 and AC10: both scripts invoked, no npm ci", () => {
    assert.ok(text.includes("runner/scripts/build-release-assets.ts"));
    assert.ok(text.includes("runner/scripts/release-notes.ts"));
    assert.ok(!text.includes("npm ci"));
  });

  await t.test("AC6: gh release create with --verify-tag and --notes-file", () => {
    assert.ok(text.includes("gh release create"));
    assert.ok(text.includes("--verify-tag"));
    assert.ok(text.includes("--notes-file"));
  });

  await t.test("AC9: exactly one if: conditional in the whole file", () => {
    const matches = text.match(/^\s*if:/gm) ?? [];
    assert.equal(matches.length, 1);
  });
});
