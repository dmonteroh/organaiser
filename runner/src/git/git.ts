import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

export function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], { cwd });
}

export function tryHeadSha(cwd: string): string | null {
  return git(["rev-parse", "HEAD"], { cwd, tolerant: true });
}

export function commitsSince(
  baseline: string | null | undefined,
  cwd: string,
): string[] {
  if (!baseline) return [];
  const out = git(["rev-list", `${baseline}..HEAD`], { cwd, tolerant: true });
  if (!out) return [];
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function commitSubject(
  commitish: string | null | undefined,
  cwd: string,
): string | null {
  if (!commitish) return null;
  return git(["log", "-1", "--format=%s", commitish], { cwd, tolerant: true });
}

export function commitExists(
  commitish: string | null | undefined,
  cwd: string,
): boolean {
  if (!commitish) return false;
  const type = git(["cat-file", "-t", commitish], { cwd, tolerant: true });
  return type === "commit";
}

function exitStatus(err: unknown): number | string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const record = err as { status?: unknown; code?: unknown };
  if (typeof record.status === "number") return record.status;
  if (typeof record.code === "number" || typeof record.code === "string") {
    return record.code;
  }
  return undefined;
}

export function isAncestor(
  commit: string,
  descendant: string = "HEAD",
  cwd: string,
): boolean {
  if (!commitExists(commit, cwd)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, descendant], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return true;
  } catch (err) {
    const status = exitStatus(err);
    if (status === 1) return false;
    throw err;
  }
}

export function committedFrontmatterStatus(
  specPath: string,
  cwd: string,
): string | null {
  const rel = path.relative(cwd, specPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const text = git(["show", `HEAD:${rel.split(path.sep).join("/")}`], {
    cwd,
    tolerant: true,
  });
  if (text == null) return null;
  return frontmatterStatusFromText(text);
}

export function frontmatterStatus(specPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(specPath, "utf8");
  } catch {
    return null;
  }
  return frontmatterStatusFromText(text);
}

export function frontmatterStatusFromText(text: string): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") break;
    const match = /^status:\s*(.+?)\s*$/.exec(lines[i]);
    if (match) return match[1].trim();
  }
  return null;
}
