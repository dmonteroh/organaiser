import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const binPath = fileURLToPath(new URL("../bin/orga.ts", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

test("orga --version prints the package version", () => {
  const output = execFileSync(process.execPath, [binPath, "--version"], {
    encoding: "utf8",
  });
  assert.equal(output.trim(), pkg.version);
});
