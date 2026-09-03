import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowsDir = path.join(process.cwd(), "workflows");
const conventionsPath = path.join(workflowsDir, "conventions.md");

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function readFrontmatter(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const fields = {};
  let i = 1;
  while (i < lines.length && lines[i].trim() !== "---") {
    const separator = lines[i].indexOf(":");
    if (separator !== -1) {
      const key = lines[i].slice(0, separator).trim();
      const value = lines[i].slice(separator + 1).trim();
      fields[key] = value;
    }
    i++;
  }
  return fields;
}

function readRoles(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const roles = [];
  for (let i = 0; i < lines.length; i++) {
    const templateMatch = lines[i].match(/^- Template: `([^`]+)`/);
    if (!templateMatch) continue;
    let headingIndex = i - 1;
    while (headingIndex >= 0 && lines[headingIndex].trim() === "") headingIndex--;
    const headingMatch =
      headingIndex >= 0 ? lines[headingIndex].match(/^### (.+)$/) : null;
    roles.push({
      heading: headingMatch ? headingMatch[1].trim() : null,
      template: templateMatch[1],
    });
  }
  return roles;
}

function readWorkflowIdRegister(conventionsText) {
  const lines = conventionsText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Workflow ids");
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,6}\s/.test(line),
  );
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);
  const ids = [];
  for (const line of section) {
    const match = line.match(/^- `([^`]+)`$/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

const workflowFiles = fs
  .readdirSync(workflowsDir)
  .filter((entry) => entry.endsWith("-workflow.md"))
  .sort();

const frontmatterByFile = new Map(
  workflowFiles.map((file) => [
    file,
    readFrontmatter(path.join(workflowsDir, file)),
  ]),
);

test("every workflow's frontmatter carries the required fields with valid values", () => {
  for (const file of workflowFiles) {
    const fields = frontmatterByFile.get(file);
    for (const key of [
      "id",
      "name",
      "triggers",
      "contractVersion",
      "manualMode",
      "runnerMode",
    ]) {
      assert.ok(
        fields[key] !== undefined,
        `${file} is missing frontmatter field "${key}"`,
      );
    }
    assert.match(
      fields.contractVersion,
      SEMVER_PATTERN,
      `${file} has a non-semver contractVersion: "${fields.contractVersion}"`,
    );
    for (const key of ["manualMode", "runnerMode"]) {
      assert.ok(
        fields[key] === "supported" || fields[key] === "unsupported",
        `${file} has an invalid ${key} value: "${fields[key]}"`,
      );
    }
  }
});

test("exactly twelve workflow files exist and their ids are unique", () => {
  assert.equal(
    workflowFiles.length,
    12,
    `expected 12 workflow files, found ${workflowFiles.length}: ${workflowFiles.join(", ")}`,
  );
  const ids = workflowFiles.map((file) => frontmatterByFile.get(file).id);
  const duplicates = [
    ...new Set(ids.filter((id, index) => ids.indexOf(id) !== index)),
  ];
  assert.equal(
    new Set(ids).size,
    ids.length,
    `workflow ids are not unique, duplicates: ${JSON.stringify(duplicates)}`,
  );
});

test("runnerMode: supported implies runnerManifest and resultSchema are present, unsupported implies both are absent", () => {
  for (const file of workflowFiles) {
    const fields = frontmatterByFile.get(file);
    if (fields.runnerMode === "supported") {
      assert.ok(
        fields.runnerManifest !== undefined && fields.runnerManifest !== "",
        `${file} is runnerMode: supported but declares no runnerManifest`,
      );
      assert.ok(
        fields.resultSchema !== undefined && fields.resultSchema !== "",
        `${file} is runnerMode: supported but declares no resultSchema`,
      );
    } else {
      assert.ok(
        fields.runnerManifest === undefined,
        `${file} is runnerMode: unsupported but declares runnerManifest`,
      );
      assert.ok(
        fields.resultSchema === undefined,
        `${file} is runnerMode: unsupported but declares resultSchema`,
      );
    }
  }
});

test("every Template: path resolves and role headings are unique within each workflow and across the runnerMode: supported workflows", () => {
  const supportedHeadingEntries = [];
  for (const file of workflowFiles) {
    const roles = readRoles(path.join(workflowsDir, file));
    const headings = [];
    for (const role of roles) {
      const resolved = path.join(workflowsDir, role.template);
      assert.ok(
        fs.existsSync(resolved),
        `${file} has a Template path that does not resolve: "${role.template}"`,
      );
      headings.push(role.heading);
    }
    assert.equal(
      new Set(headings).size,
      headings.length,
      `${file} has duplicate role headings paired with a Template line: ${headings.join(", ")}`,
    );
    if (frontmatterByFile.get(file).runnerMode === "supported") {
      for (const heading of headings) {
        supportedHeadingEntries.push({ file, heading });
      }
    }
  }
  const supportedHeadings = supportedHeadingEntries.map((entry) => entry.heading);
  assert.equal(
    new Set(supportedHeadings).size,
    supportedHeadings.length,
    `role headings collide across the runnerMode: supported workflows: ${supportedHeadingEntries
      .map((entry) => `${entry.file}:${entry.heading}`)
      .join(", ")}`,
  );
});

test("workflows/conventions.md Workflow ids register matches the ids parsed from workflow frontmatter", () => {
  const conventionsText = fs.readFileSync(conventionsPath, "utf8");
  const registerIds = readWorkflowIdRegister(conventionsText);
  const frontmatterIds = workflowFiles.map(
    (file) => frontmatterByFile.get(file).id,
  );
  const registerSet = new Set(registerIds);
  const frontmatterSet = new Set(frontmatterIds);
  const onlyInRegister = registerIds.filter((id) => !frontmatterSet.has(id));
  const onlyInFrontmatter = frontmatterIds.filter(
    (id) => !registerSet.has(id),
  );
  assert.deepEqual(
    { onlyInRegister, onlyInFrontmatter },
    { onlyInRegister: [], onlyInFrontmatter: [] },
    `conventions.md Workflow ids register differs from frontmatter ids: only in register ${JSON.stringify(onlyInRegister)}, only in frontmatter ${JSON.stringify(onlyInFrontmatter)}`,
  );
});
