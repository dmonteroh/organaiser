import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const workflowsDir = path.join(process.cwd(), "workflows");
const manifestsDir = path.join(workflowsDir, "manifests");

// Duplicated verbatim from test/workflow-parity/static.test.mjs lines 202-398
// (the restricted-dialect manifest reader). Not imported: static.test.mjs
// exports nothing, importing it would re-register its own test() calls here,
// and editing it is out of scope for this task. The two copies must be
// changed together; the reader re-proof test below guards against drift.

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

test("duplicated restricted-dialect reader reproves the P2b-iv worked examples", () => {
  const taskRefinement = readManifest(path.join(manifestsDir, "task-refinement.v1.yaml"));
  assert.deepEqual(
    taskRefinement.spec.terminalOutcomes.neutral,
    [],
    "task-refinement.v1.yaml spec.terminalOutcomes.neutral must parse to an empty array",
  );

  const development = readManifest(path.join(manifestsDir, "development.v1.yaml"));
  const reviewQuality = development.spec.stages.find((stage) => stage.id === "review-quality");
  assert.ok(reviewQuality, "development.v1.yaml is missing stage review-quality");
  assert.deepEqual(
    reviewQuality.verdicts,
    ["pass", "needs-info", "fail-with-severity: critical", "fail-with-severity: important"],
    "development.v1.yaml:99-100 sequence items did not parse to the exact expected strings",
  );
  assert.deepEqual(
    Object.keys(reviewQuality.transitions),
    ["pass", "needs-info", "fail-with-severity: critical", "fail-with-severity: important"],
    "development.v1.yaml:104-105 mapping keys did not parse to the exact expected strings",
  );

  const productSpec = readManifest(path.join(manifestsDir, "product-spec.v1.yaml"));
  const gatherContext = productSpec.spec.stages.find((stage) => stage.id === "gather-context");
  assert.ok(gatherContext, "product-spec.v1.yaml is missing stage gather-context");
  assert.deepEqual(
    Object.keys(gatherContext.transitions),
    ["true", "false"],
    'product-spec.v1.yaml:26-27 mapping keys must parse to the strings "true"/"false", not booleans',
  );

  assert.throws(
    () =>
      parseMapping(
        [{ indent: 0, content: "key:", num: 1 }],
        0,
        0,
        "<bare-key-worked-example>",
      ),
    /has no inline value and no nested block/,
    "a bare 'key:' with nothing after it and nothing indented under it must throw",
  );
});

const manifestFiles = fs
  .readdirSync(manifestsDir)
  .filter((entry) => entry.endsWith(".yaml"))
  .sort();

const manifestsByFile = new Map(
  manifestFiles.map((file) => [file, readManifest(path.join(manifestsDir, file))]),
);

function isTerminal(manifest, value) {
  const outcomes = manifest.spec.terminalOutcomes;
  return (
    outcomes.success.includes(value) ||
    outcomes.attention.includes(value) ||
    outcomes.neutral.includes(value)
  );
}

function isStageId(manifest, value) {
  return manifest.spec.stages.some((stage) => stage.id === value);
}

function step(manifest, file, stageId, key) {
  const stage = manifest.spec.stages.find((candidate) => candidate.id === stageId);
  if (!stage) {
    throw new Error(`${file}: no such stage "${stageId}"`);
  }
  const target = stage.transitions[key];
  if (target === undefined || !Object.prototype.hasOwnProperty.call(stage.transitions, key)) {
    throw new Error(`${file}: stage "${stageId}" has no transition for key "${key}"`);
  }
  if (isStageId(manifest, target)) {
    return { target, kind: "stage" };
  }
  if (isTerminal(manifest, target)) {
    return { target, kind: "terminal" };
  }
  throw new Error(
    `${file}: stage "${stageId}" key "${key}" targets "${target}", which is neither a declared stage nor a declared terminal outcome`,
  );
}

test("edge coverage: every declared transition of every stage of every manifest steps to a declared stage or terminal outcome", () => {
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    let exercised = 0;
    let declared = 0;
    for (const stage of manifest.spec.stages) {
      const keys = Object.keys(stage.transitions);
      declared += keys.length;
      for (const key of keys) {
        const result = step(manifest, file, stage.id, key);
        assert.ok(
          result.kind === "stage" || result.kind === "terminal",
          `${file}: stage "${stage.id}" key "${key}" produced an unclassified target`,
        );
        exercised += 1;
      }
    }
    assert.equal(
      exercised,
      declared,
      `${file}: exercised-edge count ${exercised} does not equal declared-transition count ${declared}`,
    );
  }
});

test("outgoing-route totality: every stage declares a non-empty transitions map, and every agent stage's verdicts are fully covered by transitions", () => {
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    for (const stage of manifest.spec.stages) {
      assert.ok(
        Object.keys(stage.transitions).length > 0,
        `${file}: stage "${stage.id}" declares an empty transitions map`,
      );
      if (stage.kind === "agent") {
        const uncovered = stage.verdicts.filter(
          (verdict) => !Object.prototype.hasOwnProperty.call(stage.transitions, verdict),
        );
        assert.deepEqual(
          uncovered,
          [],
          `${file}: agent stage "${stage.id}" declares verdicts with no transition entry: ${JSON.stringify(uncovered)}`,
        );
      }
    }
  }
});

function stageTargets(manifest, stageId) {
  const stage = manifest.spec.stages.find((candidate) => candidate.id === stageId);
  const targets = Object.values(stage.transitions);
  return targets.filter((target) => isStageId(manifest, target));
}

function onCycle(manifest, stageId) {
  const stepBound = manifest.spec.stages.length;
  const visited = new Set();
  let frontier = [stageId];
  let steps = 0;
  while (frontier.length > 0 && steps <= stepBound) {
    const next = [];
    for (const current of frontier) {
      for (const target of stageTargets(manifest, current)) {
        if (target === stageId) return true;
        if (visited.has(target)) continue;
        visited.add(target);
        next.push(target);
      }
    }
    frontier = next;
    steps += 1;
  }
  return false;
}

function escape(manifest, s) {
  const stepBound = manifest.spec.stages.length;
  const visited = new Set([s]);
  const result = new Set();
  let frontier = [s];
  let steps = 0;
  while (frontier.length > 0 && steps <= stepBound) {
    const next = [];
    for (const current of frontier) {
      const stage = manifest.spec.stages.find((candidate) => candidate.id === current);
      for (const target of Object.values(stage.transitions)) {
        if (isStageId(manifest, target)) {
          if (target === s || visited.has(target)) continue;
          visited.add(target);
          next.push(target);
        } else if (isTerminal(manifest, target)) {
          result.add(target);
        }
      }
    }
    frontier = next;
    steps += 1;
  }
  return result;
}

test("cap-breach containment: on-cycle stages always have a non-empty, in-vocabulary escape that lands in attention or neutral", () => {
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    const stageIds = manifest.spec.stages.map((stage) => stage.id);
    const onCycleStages = stageIds.filter((stageId) => onCycle(manifest, stageId));

    if (manifest.spec.caps) {
      assert.ok(
        onCycleStages.length > 0,
        `${file}: declares spec.caps but has no on-cycle stage`,
      );
    }

    const terminalUnion = new Set([
      ...manifest.spec.terminalOutcomes.success,
      ...manifest.spec.terminalOutcomes.attention,
      ...manifest.spec.terminalOutcomes.neutral,
    ]);
    const attentionOrNeutral = new Set([
      ...manifest.spec.terminalOutcomes.attention,
      ...manifest.spec.terminalOutcomes.neutral,
    ]);

    for (const stageId of onCycleStages) {
      const reachable = escape(manifest, stageId);
      assert.ok(
        reachable.size > 0,
        `${file}: on-cycle stage "${stageId}" has no escape to any terminal outcome`,
      );
      for (const outcome of reachable) {
        assert.ok(
          terminalUnion.has(outcome),
          `${file}: on-cycle stage "${stageId}" escape reaches "${outcome}", which is not a declared terminal outcome`,
        );
      }
      const hasAttentionOrNeutral = [...reachable].some((outcome) => attentionOrNeutral.has(outcome));
      assert.ok(
        hasAttentionOrNeutral,
        `${file}: on-cycle stage "${stageId}" escape set ${JSON.stringify([...reachable])} does not intersect attention or neutral outcomes`,
      );
    }
  }
});

function reachableTerminals(manifest) {
  const stepBound = manifest.spec.stages.length;
  const visited = new Set([manifest.spec.entryStage]);
  const result = new Set();
  let frontier = [manifest.spec.entryStage];
  let steps = 0;
  while (frontier.length > 0 && steps <= stepBound) {
    const next = [];
    for (const current of frontier) {
      const stage = manifest.spec.stages.find((candidate) => candidate.id === current);
      for (const target of Object.values(stage.transitions)) {
        if (isStageId(manifest, target)) {
          if (visited.has(target)) continue;
          visited.add(target);
          next.push(target);
        } else if (isTerminal(manifest, target)) {
          result.add(target);
        }
      }
    }
    frontier = next;
    steps += 1;
  }
  return result;
}

test("terminal reachability: every manifest reaches at least one success and one attention outcome from spec.entryStage", () => {
  for (const file of manifestFiles) {
    const manifest = manifestsByFile.get(file);
    const reached = reachableTerminals(manifest);
    const terminalUnion = new Set([
      ...manifest.spec.terminalOutcomes.success,
      ...manifest.spec.terminalOutcomes.attention,
      ...manifest.spec.terminalOutcomes.neutral,
    ]);

    for (const outcome of reached) {
      assert.ok(
        terminalUnion.has(outcome),
        `${file}: reachable terminal "${outcome}" is not among the declared terminal outcomes`,
      );
    }

    const reachedSuccess = manifest.spec.terminalOutcomes.success.some((outcome) =>
      reached.has(outcome),
    );
    assert.ok(
      reachedSuccess,
      `${file}: no success outcome is reachable from entryStage "${manifest.spec.entryStage}"`,
    );

    const reachedAttention = manifest.spec.terminalOutcomes.attention.some((outcome) =>
      reached.has(outcome),
    );
    assert.ok(
      reachedAttention,
      `${file}: no attention outcome is reachable from entryStage "${manifest.spec.entryStage}"`,
    );
  }
});
