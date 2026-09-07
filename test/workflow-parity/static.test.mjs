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

test("exactly thirteen workflow files exist and their ids are unique", () => {
  assert.equal(
    workflowFiles.length,
    13,
    `expected 13 workflow files, found ${workflowFiles.length}: ${workflowFiles.join(", ")}`,
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
      for (const role of roles) {
        supportedHeadingEntries.push({ file, heading: role.heading, template: role.template });
      }
    }
  }
  const entriesByHeading = new Map();
  for (const entry of supportedHeadingEntries) {
    if (!entriesByHeading.has(entry.heading)) entriesByHeading.set(entry.heading, []);
    entriesByHeading.get(entry.heading).push(entry);
  }
  for (const [heading, entries] of entriesByHeading) {
    const templates = new Set(entries.map((entry) => entry.template));
    assert.equal(
      templates.size,
      1,
      `role heading "${heading}" repeats across the runnerMode: supported workflows with differing Template paths: ${entries
        .map((entry) => `${entry.file}:${entry.template}`)
        .join(", ")}`,
    );
  }
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

const manifestsDir = path.join(workflowsDir, "manifests");
const schemasDir = path.join(workflowsDir, "schemas");
const subagentsDir = path.join(workflowsDir, "subagents");

function dialectError(filePath, lineNum, message) {
  return new Error(`${filePath}:${lineNum}: ${message}`);
}

function tryParseInlineKeyValue(text) {
  const idx = text.indexOf(": ");
  if (idx !== -1) {
    return { key: text.slice(0, idx), rawValue: text.slice(idx + 2) };
  }
  if (text.endsWith(":")) {
    return { key: text.slice(0, -1), rawValue: "" };
  }
  return null;
}

function splitKeyValue(content, filePath, lineNum) {
  if (content.startsWith('"')) {
    const closeIdx = content.indexOf('"', 1);
    if (closeIdx === -1) {
      throw dialectError(filePath, lineNum, `unterminated quoted key: ${content}`);
    }
    const key = content.slice(1, closeIdx);
    const remainder = content.slice(closeIdx + 1);
    if (remainder === "" || remainder === ":") return { key, rawValue: "" };
    if (remainder.startsWith(": ")) return { key, rawValue: remainder.slice(2) };
    throw dialectError(filePath, lineNum, `malformed quoted-key mapping line: ${content}`);
  }
  const parsed = tryParseInlineKeyValue(content);
  if (!parsed) {
    throw dialectError(
      filePath,
      lineNum,
      `line is not a valid "key: value" mapping entry: ${content}`,
    );
  }
  return parsed;
}

function parseScalar(raw, filePath, lineNum) {
  const text = raw.trim();
  if (text === "[]") return [];
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw dialectError(filePath, lineNum, `unterminated quoted scalar: ${raw}`);
    }
    const inner = text.slice(1, -1);
    if (inner.includes('"')) {
      throw dialectError(
        filePath,
        lineNum,
        `quoted scalar contains an embedded quote, unsupported: ${raw}`,
      );
    }
    return inner;
  }
  if (text.includes('"')) {
    throw dialectError(filePath, lineNum, `stray quote in unquoted scalar: ${raw}`);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function parseNode(lines, i, indent, filePath) {
  if (i >= lines.length || lines[i].indent !== indent) {
    throw dialectError(
      filePath,
      i < lines.length ? lines[i].num : "EOF",
      `expected content at indent ${indent}`,
    );
  }
  if (lines[i].content.startsWith("- ")) {
    return parseSequence(lines, i, indent, filePath);
  }
  return parseMapping(lines, i, indent, filePath);
}

function parseMapping(lines, i, indent, filePath) {
  const obj = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].content.startsWith("- ")) {
    const line = lines[i];
    const { key, rawValue } = splitKeyValue(line.content, filePath, line.num);
    i++;
    if (rawValue.trim() === "") {
      if (i < lines.length && lines[i].indent > indent) {
        const childIndent = lines[i].indent;
        if (childIndent !== indent + 2) {
          throw dialectError(
            filePath,
            lines[i].num,
            `expected indent step of 2 under "${key}:", found indent ${childIndent} (parent indent ${indent})`,
          );
        }
        const { value, next } = parseNode(lines, i, childIndent, filePath);
        obj[key] = value;
        i = next;
      } else {
        throw dialectError(
          filePath,
          line.num,
          `"${key}:" has no inline value and no nested block; bare empty keys are not a valid empty-array form in this dialect`,
        );
      }
    } else {
      obj[key] = parseScalar(rawValue, filePath, line.num);
      if (i < lines.length && lines[i].indent > indent) {
        throw dialectError(
          filePath,
          lines[i].num,
          `unexpected deeper indent after scalar value for "${key}"`,
        );
      }
    }
  }
  return { value: obj, next: i };
}

function parseSequence(lines, i, indent, filePath) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && lines[i].content.startsWith("- ")) {
    const line = lines[i];
    const rest = line.content.slice(2);
    if (rest.trim() === "") {
      throw dialectError(
        filePath,
        line.num,
        "sequence item with no inline content is outside the supported dialect",
      );
    }
    if (rest.startsWith('"')) {
      arr.push(parseScalar(rest, filePath, line.num));
      i++;
      if (i < lines.length && lines[i].indent > indent) {
        throw dialectError(
          filePath,
          lines[i].num,
          "unexpected deeper indent after quoted scalar sequence item",
        );
      }
      continue;
    }
    const kv = tryParseInlineKeyValue(rest);
    if (kv) {
      const itemIndent = indent + 2;
      const synthetic = { indent: itemIndent, content: rest, num: line.num };
      const virtualLines = [synthetic, ...lines.slice(i + 1)];
      const { value, next } = parseMapping(virtualLines, 0, itemIndent, filePath);
      arr.push(value);
      i = i + next;
      continue;
    }
    arr.push(parseScalar(rest, filePath, line.num));
    i++;
    if (i < lines.length && lines[i].indent > indent) {
      throw dialectError(
        filePath,
        lines[i].num,
        "unexpected deeper indent after scalar sequence item",
      );
    }
  }
  return { value: arr, next: i };
}

function readManifest(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx];
    if (raw.trim() === "") continue;
    const match = raw.match(/^( *)(\S.*)$/);
    if (!match) {
      throw dialectError(
        filePath,
        idx + 1,
        `unparsable line (tabs or unsupported whitespace): ${JSON.stringify(raw)}`,
      );
    }
    const indent = match[1].length;
    if (indent % 2 !== 0) {
      throw dialectError(
        filePath,
        idx + 1,
        `indent is not a multiple of two spaces: ${JSON.stringify(raw)}`,
      );
    }
    lines.push({ indent, content: match[2], num: idx + 1 });
  }
  const { value, next } = parseMapping(lines, 0, 0, filePath);
  if (next !== lines.length) {
    throw dialectError(filePath, lines[next].num, "unexpected content at top level");
  }
  return value;
}

function readRoleIdRegister(conventionsText) {
  const lines = conventionsText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Role ids");
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,6}\s/.test(line),
  );
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);
  const ids = [];
  for (const line of section) {
    const match = line.match(/^- `([^`]+)`/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

function readVerdictRegister(conventionsText) {
  const lines = conventionsText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Verdict enums");
  const end = lines.findIndex(
    (line, index) => index > start && /^#{1,6}\s/.test(line),
  );
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);
  const register = new Map();
  for (const line of section) {
    const headMatch = line.match(/^- `([^`]+)`: (.*)$/);
    if (!headMatch) continue;
    const role = headMatch[1];
    let rest = headMatch[2];
    const values = [];
    while (true) {
      const valueMatch = rest.match(/^`([^`]+)`(, |\.)/);
      if (!valueMatch) break;
      values.push(valueMatch[1]);
      rest = rest.slice(valueMatch[0].length);
      if (valueMatch[2] === ".") break;
    }
    if (values.length === 1 && values[0] === "verdicts: none") {
      register.set(role, "none");
    } else {
      register.set(role, values);
    }
  }
  return register;
}

function verdictDefsKey(role) {
  const parts = role.split("-");
  return (
    parts
      .map((part, index) =>
        index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join("") + "Verdict"
  );
}

function extractVerdictRuleSection(text) {
  const lines = text.split("\n");
  const headingStart = lines.findIndex((line) => /^#{1,6}\s+Verdict Rule/.test(line));
  const labelStart = lines.findIndex((line) => line === "Verdict Rule:");
  let start = -1;
  if (headingStart !== -1 && labelStart !== -1) {
    start = Math.min(headingStart, labelStart);
  } else if (headingStart !== -1) {
    start = headingStart;
  } else {
    start = labelStart;
  }
  if (start === -1) return null;
  let end = lines.length;
  let sawListItem = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("- ")) {
      sawListItem = true;
      continue;
    }
    if (
      sawListItem &&
      (/^#{1,6}\s/.test(line) || /^[A-Za-z][A-Za-z /-]*:$/.test(line))
    ) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function appearsInVerdictSection(value, section) {
  const paramIdx = value.indexOf(": ");
  if (paramIdx !== -1) {
    const prefix = value.slice(0, paramIdx + 2);
    return section.includes(prefix);
  }
  return section.includes(value);
}

function verdictRegisterCoversSchemaEnum(registerValues, schemaValues) {
  const remaining = [...schemaValues];
  for (const registerValue of registerValues) {
    const paramIdx = registerValue.indexOf(": ");
    if (paramIdx !== -1) {
      const prefix = registerValue.slice(0, paramIdx + 2);
      const matches = remaining.filter((value) => value.startsWith(prefix));
      if (matches.length === 0) return false;
      for (const match of matches) {
        remaining.splice(remaining.indexOf(match), 1);
      }
    } else {
      const index = remaining.indexOf(registerValue);
      if (index === -1) return false;
      remaining.splice(index, 1);
    }
  }
  return remaining.length === 0;
}

const PENDING_POLICY_TARGETS = {};

const RUNNER_ONLY_MANIFESTS = ["integration.v1.yaml"];

const expectedManifestFiles = new Set(RUNNER_ONLY_MANIFESTS);
for (const file of workflowFiles) {
  const fields = frontmatterByFile.get(file);
  if (fields.runnerMode === "supported") {
    expectedManifestFiles.add(fields.runnerManifest.replace(/^manifests\//, ""));
  }
}

const manifestFiles = fs
  .readdirSync(manifestsDir)
  .filter((entry) => entry.endsWith(".yaml"))
  .sort();

const manifestsByFile = new Map(
  manifestFiles.map((file) => [file, readManifest(path.join(manifestsDir, file))]),
);

test("manifest files under workflows/manifests/ equal the union of runnerMode: supported workflows' runnerManifest plus RUNNER_ONLY_MANIFESTS, and every declared runnerManifest resolves to a file that exists, and each manifest declares the required top-level shape", () => {
  for (const file of manifestFiles) {
    assert.ok(
      expectedManifestFiles.has(file),
      `workflows/manifests/${file} is not in the expected manifest set (runnerMode: supported workflows' runnerManifest values plus RUNNER_ONLY_MANIFESTS): ${[...expectedManifestFiles].sort().join(", ")}`,
    );
  }
  for (const file of workflowFiles) {
    const fields = frontmatterByFile.get(file);
    if (fields.runnerMode !== "supported") continue;
    const bareName = fields.runnerManifest.replace(/^manifests\//, "");
    assert.ok(
      manifestFiles.includes(bareName),
      `${file} declares runnerManifest "${fields.runnerManifest}", which does not resolve to a file under workflows/manifests/`,
    );
  }
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    assert.ok(manifest.apiVersion, `${file} is missing apiVersion`);
    assert.ok(manifest.kind, `${file} is missing kind`);
    assert.ok(manifest.metadata && manifest.metadata.id, `${file} is missing metadata.id`);
    assert.ok(
      manifest.metadata && manifest.metadata.contractVersion,
      `${file} is missing metadata.contractVersion`,
    );
    assert.ok(manifest.spec && manifest.spec.policy, `${file} is missing spec.policy`);
    assert.ok(manifest.spec && manifest.spec.entryStage, `${file} is missing spec.entryStage`);
    assert.ok(
      manifest.spec && manifest.spec.terminalOutcomes,
      `${file} is missing spec.terminalOutcomes`,
    );
    assert.ok(
      manifest.spec && Array.isArray(manifest.spec.stages),
      `${file} is missing spec.stages`,
    );
  }
});

test("every manifest's spec.policy and every stage prompt path resolves relative to workflows/manifests/, except the named PENDING_POLICY_TARGETS exception", () => {
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    const pendingTarget = PENDING_POLICY_TARGETS[file];
    if (pendingTarget !== undefined) {
      assert.equal(
        manifest.spec.policy,
        pendingTarget,
        `${file}: spec.policy "${manifest.spec.policy}" no longer matches its PENDING_POLICY_TARGETS entry "${pendingTarget}"; update or remove the entry`,
      );
      const resolved = path.join(manifestsDir, manifest.spec.policy);
      assert.ok(
        !fs.existsSync(resolved),
        `${file}: PENDING_POLICY_TARGETS entry is stale, "${resolved}" now exists; delete the PENDING_POLICY_TARGETS entry for "${file}" now that P3 has landed`,
      );
    } else {
      const resolved = path.join(manifestsDir, manifest.spec.policy);
      assert.ok(
        fs.existsSync(resolved),
        `${file}: spec.policy does not resolve to an existing file: "${manifest.spec.policy}"`,
      );
    }
    for (const stage of manifest.spec.stages) {
      if (stage.prompt === undefined) continue;
      const resolved = path.join(manifestsDir, stage.prompt);
      assert.ok(
        fs.existsSync(resolved),
        `${file} stage "${stage.id}": prompt does not resolve to an existing file: "${stage.prompt}"`,
      );
    }
  }
});

test("every manifest's entryStage names a declared stage, and every stage transition targets either a declared stage or a listed terminalOutcome", () => {
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    const stageIds = new Set(manifest.spec.stages.map((stage) => stage.id));
    const terminalValues = new Set([
      ...(manifest.spec.terminalOutcomes.success || []),
      ...(manifest.spec.terminalOutcomes.attention || []),
      ...(manifest.spec.terminalOutcomes.neutral || []),
    ]);
    assert.ok(
      stageIds.has(manifest.spec.entryStage),
      `${file}: entryStage "${manifest.spec.entryStage}" is not a declared stage`,
    );
    for (const stage of manifest.spec.stages) {
      for (const [transitionKey, target] of Object.entries(stage.transitions || {})) {
        assert.ok(
          stageIds.has(target) || terminalValues.has(target),
          `${file} stage "${stage.id}": transition "${transitionKey}" targets "${target}", which is neither a declared stage nor a listed terminalOutcome`,
        );
      }
    }
  }
});

test("agent-stage verdicts equal the role's schema $defs enum (a role with verdicts: none in the conventions.md Verdict enums register equals the status enum), every verdict appears in the role template's Verdict Rule section, and every transition key is a declared verdict", () => {
  const resultSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "stage-result.schema.json"), "utf8"),
  );
  const statusEnum = resultSchema.properties.status.enum;
  const conventionsText = fs.readFileSync(conventionsPath, "utf8");
  const verdictRegister = readVerdictRegister(conventionsText);

  const verdictSectionCache = new Map();
  const getVerdictSection = (role) => {
    if (!verdictSectionCache.has(role)) {
      const templatePath = path.join(subagentsDir, `${role}-prompt.md`);
      const text = fs.readFileSync(templatePath, "utf8");
      const section = extractVerdictRuleSection(text);
      assert.ok(
        section,
        `role "${role}" template "${templatePath}" has no Verdict Rule section`,
      );
      verdictSectionCache.set(role, section);
    }
    return verdictSectionCache.get(role);
  };

  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    for (const stage of manifest.spec.stages) {
      if (stage.kind !== "agent") continue;
      const verdictEntry = verdictRegister.get(stage.role);
      assert.ok(
        verdictEntry !== undefined,
        `${file} stage "${stage.id}" has role "${stage.role}", which has no entry in conventions.md's Verdict enums register`,
      );
      if (verdictEntry === "none") {
        assert.deepEqual(
          stage.verdicts,
          statusEnum,
          `${file} stage "${stage.id}" (role ${stage.role}, "verdicts: none" in the conventions.md Verdict enums register) verdicts do not equal the stage-result schema's status enum`,
        );
      } else {
        const defsKey = verdictDefsKey(stage.role);
        assert.ok(
          resultSchema.$defs[defsKey],
          `${file} stage "${stage.id}" has role "${stage.role}", whose derived $defs key "${defsKey}" is not in stage-result.schema.json's $defs`,
        );
        const schemaEnum = resultSchema.$defs[defsKey].enum;
        assert.ok(
          verdictRegisterCoversSchemaEnum(verdictEntry, schemaEnum),
          `${file} stage "${stage.id}": conventions.md's Verdict enums register entry for role "${stage.role}" (${verdictEntry.join(", ")}) does not cover $defs.${defsKey}.enum (${schemaEnum.join(", ")})`,
        );
        assert.deepEqual(
          stage.verdicts,
          schemaEnum,
          `${file} stage "${stage.id}" (role ${stage.role}) verdicts do not equal $defs.${defsKey}.enum`,
        );
        const section = getVerdictSection(stage.role);
        for (const value of stage.verdicts) {
          assert.ok(
            appearsInVerdictSection(value, section),
            `${file} stage "${stage.id}": verdict "${value}" does not appear in the ${stage.role} template's Verdict Rule section`,
          );
        }
      }
      for (const transitionKey of Object.keys(stage.transitions || {})) {
        assert.ok(
          stage.verdicts.includes(transitionKey),
          `${file} stage "${stage.id}": transition key "${transitionKey}" is not one of the stage's declared verdicts`,
        );
      }
    }
  }
});

test("agent stages declare the required agent keys, runner stages declare the required runner keys and neither role nor prompt, no stage carries a key outside workflow-manifest.schema.json's stage properties, and every agent stage role is in the conventions.md role register", () => {
  const manifestSchema = JSON.parse(
    fs.readFileSync(path.join(schemasDir, "workflow-manifest.schema.json"), "utf8"),
  );
  const allowedKeys = new Set(Object.keys(manifestSchema.$defs.stage.properties));
  const conventionsText = fs.readFileSync(conventionsPath, "utf8");
  const roleRegister = new Set(readRoleIdRegister(conventionsText));

  const AGENT_REQUIRED_KEYS = [
    "role",
    "prompt",
    "authority",
    "freshSession",
    "capabilityClass",
    "verdicts",
    "transitions",
    "retry",
  ];
  const RUNNER_REQUIRED_KEYS = ["predicate", "transitions"];

  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    for (const stage of manifest.spec.stages) {
      for (const key of Object.keys(stage)) {
        assert.ok(
          allowedKeys.has(key),
          `${file} stage "${stage.id}" has key "${key}", which workflow-manifest.schema.json's $defs.stage.properties does not allow`,
        );
      }
      if (stage.kind === "agent") {
        for (const key of AGENT_REQUIRED_KEYS) {
          assert.ok(
            stage[key] !== undefined,
            `${file} agent stage "${stage.id}" is missing required key "${key}"`,
          );
        }
        assert.equal(
          stage.freshSession,
          true,
          `${file} agent stage "${stage.id}" must declare freshSession: true`,
        );
        assert.ok(
          roleRegister.has(stage.role),
          `${file} agent stage "${stage.id}": role "${stage.role}" is not in the conventions.md role register`,
        );
      } else if (stage.kind === "runner") {
        for (const key of RUNNER_REQUIRED_KEYS) {
          assert.ok(
            stage[key] !== undefined,
            `${file} runner stage "${stage.id}" is missing required key "${key}"`,
          );
        }
        assert.ok(
          stage.role === undefined,
          `${file} runner stage "${stage.id}" declares "role", which runner stages must not carry`,
        );
        assert.ok(
          stage.prompt === undefined,
          `${file} runner stage "${stage.id}" declares "prompt", which runner stages must not carry`,
        );
      } else {
        assert.fail(`${file} stage "${stage.id}" has unrecognized kind "${stage.kind}"`);
      }
    }
  }
});
