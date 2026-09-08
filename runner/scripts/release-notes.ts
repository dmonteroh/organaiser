import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface GitCallOptions {
  cwd: string;
  trimOutput?: boolean;
}

function git(
  args: readonly string[],
  options: GitCallOptions & { tolerant: true },
): string | null;
function git(
  args: readonly string[],
  options: GitCallOptions & { tolerant?: false },
): string;
function git(
  args: readonly string[],
  { cwd, tolerant = false, trimOutput = true }: GitCallOptions & { tolerant?: boolean },
): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return trimOutput ? out.trim() : out;
  } catch (err) {
    if (tolerant) return null;
    throw err;
  }
}

export class GitRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRefError";
  }
}

export class MalformedContractBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedContractBlockError";
  }
}

export class ContractVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractVersionConflictError";
  }
}

function gitStrict(args: readonly string[], cwd: string, ref: string): string {
  try {
    return git(args, { cwd });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new GitRefError(
      `git ref "${ref}" or one of its objects is unavailable in "${cwd}" (git ${args.join(" ")}): ${detail}`,
    );
  }
}

function listPaths(ref: string, cwd: string, dir: string, suffix: string): string[] {
  const out = gitStrict(["ls-tree", "--name-only", ref, "--", dir], cwd, ref);
  if (out.length === 0) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(suffix));
}

export function listContractPaths(
  ref: string,
  cwd: string,
): { markdownPaths: string[]; manifestPaths: string[] } {
  return {
    markdownPaths: listPaths(ref, cwd, "workflows/", ".md"),
    manifestPaths: listPaths(ref, cwd, "workflows/manifests/", ".yaml"),
  };
}

function gitShow(ref: string, path: string, cwd: string): string {
  return gitStrict(["show", `${ref}:${path}`], cwd, ref);
}

interface ScannedContract {
  readonly id: string;
  readonly contractVersion: string;
}

function finishScan(
  id: string | null,
  contractVersion: string | null,
  path: string,
  blockDescription: string,
): ScannedContract | null {
  if (id === null && contractVersion === null) return null;
  if (id === null) {
    throw new MalformedContractBlockError(
      `${path}: ${blockDescription} declares contractVersion without id`,
    );
  }
  if (contractVersion === null) {
    throw new MalformedContractBlockError(
      `${path}: ${blockDescription} declares id without contractVersion`,
    );
  }
  return { id, contractVersion };
}

const FRONTMATTER_ID_RE = /^id:\s*(.+?)\s*$/;
const FRONTMATTER_VERSION_RE = /^contractVersion:\s*(.+?)\s*$/;

export function scanMarkdownFrontmatter(text: string, path: string): ScannedContract | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  let id: string | null = null;
  let contractVersion: string | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") break;
    const idMatch = FRONTMATTER_ID_RE.exec(lines[i]);
    if (idMatch) id = idMatch[1].trim();
    const versionMatch = FRONTMATTER_VERSION_RE.exec(lines[i]);
    if (versionMatch) contractVersion = versionMatch[1].trim();
  }
  return finishScan(id, contractVersion, path, "frontmatter block");
}

const METADATA_START_RE = /^metadata:\s*$/;
const MANIFEST_ID_RE = /^ {2}id:\s*(.+?)\s*$/;
const MANIFEST_VERSION_RE = /^ {2}contractVersion:\s*(.+?)\s*$/;

export function scanManifestMetadata(text: string, path: string): ScannedContract | null {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => METADATA_START_RE.test(line));
  if (startIndex === -1) return null;
  let id: string | null = null;
  let contractVersion: string | null = null;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 0 && line[0] !== " " && line[0] !== "\t") break;
    const idMatch = MANIFEST_ID_RE.exec(line);
    if (idMatch) id = idMatch[1].trim();
    const versionMatch = MANIFEST_VERSION_RE.exec(line);
    if (versionMatch) contractVersion = versionMatch[1].trim();
  }
  return finishScan(id, contractVersion, path, "metadata block");
}

interface ContractLocation {
  readonly version: string;
  readonly path: string;
}

function foldContract(
  map: Map<string, ContractLocation>,
  parsed: ScannedContract,
  path: string,
  ref: string,
): void {
  const existing = map.get(parsed.id);
  if (existing === undefined) {
    map.set(parsed.id, { version: parsed.contractVersion, path });
    return;
  }
  if (existing.version !== parsed.contractVersion) {
    throw new ContractVersionConflictError(
      `contract "${parsed.id}" disagrees at ref "${ref}": ` +
        `${existing.path}@${existing.version} vs ${path}@${parsed.contractVersion}`,
    );
  }
}

export function contractsAt(ref: string, cwd: string): Map<string, ContractLocation> {
  const { markdownPaths, manifestPaths } = listContractPaths(ref, cwd);
  const result = new Map<string, ContractLocation>();
  for (const path of markdownPaths) {
    const parsed = scanMarkdownFrontmatter(gitShow(ref, path, cwd), path);
    if (parsed !== null) foldContract(result, parsed, path, ref);
  }
  for (const path of manifestPaths) {
    const parsed = scanManifestMetadata(gitShow(ref, path, cwd), path);
    if (parsed !== null) foldContract(result, parsed, path, ref);
  }
  return result;
}

interface ContractSummary {
  readonly id: string;
  readonly version: string;
}

interface ChangedContract {
  readonly id: string;
  readonly oldVersion: string;
  readonly newVersion: string;
}

type ContractDelta =
  | {
      readonly kind: "diff";
      readonly changed: readonly ChangedContract[];
      readonly added: readonly ContractSummary[];
      readonly removed: readonly ContractSummary[];
    }
  | {
      readonly kind: "initial";
      readonly contracts: readonly ContractSummary[];
    };

function byId(a: { readonly id: string }, b: { readonly id: string }): number {
  return a.id.localeCompare(b.id);
}

export function diffContracts(
  oldMap: Map<string, ContractLocation> | null,
  newMap: Map<string, ContractLocation>,
): ContractDelta {
  if (oldMap === null) {
    const contracts = [...newMap.entries()]
      .map(([id, entry]) => ({ id, version: entry.version }))
      .sort(byId);
    return { kind: "initial", contracts };
  }

  const changed: ChangedContract[] = [];
  const added: ContractSummary[] = [];
  for (const [id, entry] of newMap) {
    const prior = oldMap.get(id);
    if (prior === undefined) {
      added.push({ id, version: entry.version });
    } else if (prior.version !== entry.version) {
      changed.push({ id, oldVersion: prior.version, newVersion: entry.version });
    }
  }
  const removed: ContractSummary[] = [];
  for (const [id, entry] of oldMap) {
    if (!newMap.has(id)) removed.push({ id, version: entry.version });
  }

  return {
    kind: "diff",
    changed: changed.sort(byId),
    added: added.sort(byId),
    removed: removed.sort(byId),
  };
}

const HEADING = "## Contract Versions";

export function renderContractVersionSection(delta: ContractDelta): string {
  const lines: string[] = [HEADING, ""];

  if (delta.kind === "initial") {
    if (delta.contracts.length === 0) {
      lines.push("No contracts found.");
    } else {
      lines.push("First release: every contract at its current version.");
      lines.push("");
      for (const contract of delta.contracts) {
        lines.push(`- \`${contract.id}\`: \`${contract.version}\``);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  const { changed, added, removed } = delta;
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    lines.push("No contract changes.");
    return `${lines.join("\n")}\n`;
  }

  let needsBlankLine = false;
  if (changed.length > 0) {
    lines.push("**Changed:**");
    for (const c of changed) {
      lines.push(`- \`${c.id}\`: \`${c.oldVersion}\` -> \`${c.newVersion}\``);
    }
    needsBlankLine = true;
  }
  if (added.length > 0) {
    if (needsBlankLine) lines.push("");
    lines.push("**Added:**");
    for (const c of added) {
      lines.push(`- \`${c.id}\`: \`${c.version}\``);
    }
    needsBlankLine = true;
  }
  if (removed.length > 0) {
    if (needsBlankLine) lines.push("");
    lines.push("**Removed:**");
    for (const c of removed) {
      lines.push(`- \`${c.id}\`: \`${c.version}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function generateContractVersionDelta(
  prevRef: string | null,
  newRef: string,
  repoDir: string,
): string {
  const newContracts = contractsAt(newRef, repoDir);
  const oldContracts = prevRef === null ? null : contractsAt(prevRef, repoDir);
  return renderContractVersionSection(diffContracts(oldContracts, newContracts));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

export function main(argv: readonly string[]): void {
  const newRef = argv[2];
  const prevArg = argv[3];
  const prevRef = prevArg !== undefined && prevArg.length > 0 ? prevArg : null;

  if (!newRef) {
    process.stderr.write("release-notes: missing required <newRef> argument\n");
    process.exitCode = 1;
    return;
  }

  try {
    const section = generateContractVersionDelta(prevRef, newRef, process.cwd());
    process.stdout.write(section);
  } catch (err) {
    if (err instanceof Error) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

if (isMainModule()) {
  main(process.argv);
}
