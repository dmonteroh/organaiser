// A restricted YAML dialect reader for orga.yaml and vendor-profile files (goals spec
// section 24). It supports exactly: two-space indent steps, block mappings, block
// sequences of scalars or of inline "key: value" maps, double-quoted and bare scalars,
// whole-line "#" comments, blank lines, and "[]" as the one and only empty-collection
// form. Every other YAML construct — anchors, aliases, tags, any flow collection other
// than the literal "[]", multi-line block scalars, tabs, and any indent step other than
// two — is refused with a "<path>:<line>: " error naming the construct. The reader never
// guesses at an unsupported construct's meaning; an unrecognized line is always an error,
// never a skipped one.
//
// Design note: only whole-line comments are recognized (a line whose first non-space
// character is "#"). A "#" occurring after content on the same line is treated as
// literal scalar text — this dialect has no notion of a trailing inline comment.

import fs from "node:fs";

export type YamlValue = string | number | boolean | YamlValue[] | YamlMapping;

export interface YamlMapping {
  [key: string]: YamlValue;
}

interface Line {
  indent: number;
  content: string;
  num: number;
}

export function formatDialectError(filePath: string, lineNum: number | string, message: string): Error {
  return new Error(`${filePath}:${lineNum}: ${message}`);
}

function tryParseInlineKeyValue(text: string): { key: string; rawValue: string } | null {
  const idx = text.indexOf(": ");
  if (idx !== -1) {
    return { key: text.slice(0, idx), rawValue: text.slice(idx + 2) };
  }
  if (text.endsWith(":")) {
    return { key: text.slice(0, -1), rawValue: "" };
  }
  return null;
}

function splitKeyValue(content: string, filePath: string, lineNum: number): { key: string; rawValue: string } {
  if (content.startsWith('"')) {
    const closeIdx = content.indexOf('"', 1);
    if (closeIdx === -1) {
      throw formatDialectError(filePath, lineNum, `unterminated quoted key: ${content}`);
    }
    const key = content.slice(1, closeIdx);
    const remainder = content.slice(closeIdx + 1);
    if (remainder === "" || remainder === ":") return { key, rawValue: "" };
    if (remainder.startsWith(": ")) return { key, rawValue: remainder.slice(2) };
    throw formatDialectError(filePath, lineNum, `malformed quoted-key mapping line: ${content}`);
  }
  const parsed = tryParseInlineKeyValue(content);
  if (!parsed) {
    throw formatDialectError(filePath, lineNum, `line is not a valid "key: value" mapping entry: ${content}`);
  }
  return parsed;
}

// A block-scalar indicator ("|", ">") optionally followed by chomping ("-", "+") and/or
// an explicit indentation indicator digit, per YAML 1.1/1.2 — none of which this dialect
// supports, since it has no multi-line scalar form at all.
const BLOCK_SCALAR_INDICATOR = /^[|>][-+]?[0-9]?$/;

function assertNoForbiddenConstruct(text: string, filePath: string, lineNum: number): void {
  if (text.startsWith("&")) {
    throw formatDialectError(filePath, lineNum, `anchor is not supported by this dialect: ${text}`);
  }
  if (text.startsWith("*")) {
    throw formatDialectError(filePath, lineNum, `alias is not supported by this dialect: ${text}`);
  }
  if (text.startsWith("!")) {
    throw formatDialectError(filePath, lineNum, `tag is not supported by this dialect: ${text}`);
  }
  if (BLOCK_SCALAR_INDICATOR.test(text)) {
    throw formatDialectError(
      filePath,
      lineNum,
      `multi-line block scalar is not supported by this dialect: ${text}`,
    );
  }
  if (text === "{}" || text.startsWith("{")) {
    throw formatDialectError(
      filePath,
      lineNum,
      `flow mapping is not supported by this dialect (only "[]" is a supported flow collection): ${text}`,
    );
  }
  if (text.startsWith("[") && text !== "[]") {
    throw formatDialectError(
      filePath,
      lineNum,
      `flow sequence is not supported by this dialect (only "[]" is a supported flow collection): ${text}`,
    );
  }
}

function parseScalar(raw: string, filePath: string, lineNum: number): YamlValue {
  const text = raw.trim();
  assertNoForbiddenConstruct(text, filePath, lineNum);
  if (text === "[]") return [];
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) {
      throw formatDialectError(filePath, lineNum, `unterminated quoted scalar: ${raw}`);
    }
    const inner = text.slice(1, -1);
    if (inner.includes('"')) {
      throw formatDialectError(filePath, lineNum, `quoted scalar contains an embedded quote, unsupported: ${raw}`);
    }
    return inner;
  }
  if (text.includes('"')) {
    throw formatDialectError(filePath, lineNum, `stray quote in unquoted scalar: ${raw}`);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function parseNode(
  lines: readonly Line[],
  i: number,
  indent: number,
  filePath: string,
): { value: YamlValue; next: number } {
  if (i >= lines.length || lines[i]!.indent !== indent) {
    throw formatDialectError(
      filePath,
      i < lines.length ? lines[i]!.num : "EOF",
      `expected content at indent ${indent}`,
    );
  }
  if (lines[i]!.content.startsWith("- ")) {
    return parseSequence(lines, i, indent, filePath);
  }
  return parseMapping(lines, i, indent, filePath);
}

function parseMapping(
  lines: readonly Line[],
  i: number,
  indent: number,
  filePath: string,
): { value: YamlMapping; next: number } {
  const obj: YamlMapping = {};
  while (i < lines.length && lines[i]!.indent === indent && !lines[i]!.content.startsWith("- ")) {
    const line = lines[i]!;
    const { key, rawValue } = splitKeyValue(line.content, filePath, line.num);
    i++;
    if (rawValue.trim() === "") {
      if (i < lines.length && lines[i]!.indent > indent) {
        const childIndent = lines[i]!.indent;
        if (childIndent !== indent + 2) {
          throw formatDialectError(
            filePath,
            lines[i]!.num,
            `expected indent step of 2 under "${key}:", found indent ${childIndent} (parent indent ${indent})`,
          );
        }
        const { value, next } = parseNode(lines, i, childIndent, filePath);
        obj[key] = value;
        i = next;
      } else {
        throw formatDialectError(
          filePath,
          line.num,
          `"${key}:" has no inline value and no nested block; bare empty keys are not a valid empty-array form in this dialect`,
        );
      }
    } else {
      obj[key] = parseScalar(rawValue, filePath, line.num);
      if (i < lines.length && lines[i]!.indent > indent) {
        throw formatDialectError(filePath, lines[i]!.num, `unexpected deeper indent after scalar value for "${key}"`);
      }
    }
  }
  return { value: obj, next: i };
}

function parseSequence(
  lines: readonly Line[],
  i: number,
  indent: number,
  filePath: string,
): { value: YamlValue[]; next: number } {
  const arr: YamlValue[] = [];
  while (i < lines.length && lines[i]!.indent === indent && lines[i]!.content.startsWith("- ")) {
    const line = lines[i]!;
    const rest = line.content.slice(2);
    if (rest.trim() === "") {
      throw formatDialectError(
        filePath,
        line.num,
        "sequence item with no inline content is outside the supported dialect",
      );
    }
    if (rest.startsWith('"')) {
      arr.push(parseScalar(rest, filePath, line.num));
      i++;
      if (i < lines.length && lines[i]!.indent > indent) {
        throw formatDialectError(filePath, lines[i]!.num, "unexpected deeper indent after quoted scalar sequence item");
      }
      continue;
    }
    assertNoForbiddenConstruct(rest.trim(), filePath, line.num);
    const kv = tryParseInlineKeyValue(rest);
    if (kv) {
      const itemIndent = indent + 2;
      const synthetic: Line = { indent: itemIndent, content: rest, num: line.num };
      const virtualLines = [synthetic, ...lines.slice(i + 1)];
      const { value, next } = parseMapping(virtualLines, 0, itemIndent, filePath);
      arr.push(value);
      i = i + next;
      continue;
    }
    arr.push(parseScalar(rest, filePath, line.num));
    i++;
    if (i < lines.length && lines[i]!.indent > indent) {
      throw formatDialectError(filePath, lines[i]!.num, "unexpected deeper indent after scalar sequence item");
    }
  }
  return { value: arr, next: i };
}

// Parses YAML-dialect text already in memory; `filePath` is used only to label errors,
// so a caller that has no real file (a test, or a value read from another source) may
// pass any descriptive string.
export function parseYamlText(text: string, filePath: string): YamlMapping {
  const rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: Line[] = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx]!;
    if (raw.trim() === "") continue;
    if (raw.trimStart().startsWith("#")) continue;
    const match = raw.match(/^( *)(\S.*)$/);
    if (!match) {
      throw formatDialectError(filePath, idx + 1, `unparsable line (tabs or unsupported whitespace): ${JSON.stringify(raw)}`);
    }
    const indent = match[1]!.length;
    if (indent % 2 !== 0) {
      throw formatDialectError(filePath, idx + 1, `indent is not a multiple of two spaces: ${JSON.stringify(raw)}`);
    }
    lines.push({ indent, content: match[2]!, num: idx + 1 });
  }
  if (lines.length === 0) return {};
  const { value, next } = parseMapping(lines, 0, 0, filePath);
  if (next !== lines.length) {
    throw formatDialectError(filePath, lines[next]!.num, "unexpected content at top level");
  }
  return value;
}

export function readYamlFile(filePath: string): YamlMapping {
  const text = fs.readFileSync(filePath, "utf8");
  return parseYamlText(text, filePath);
}
