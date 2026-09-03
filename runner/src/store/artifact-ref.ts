// A stored reference to a file produced during a run, kept relocatable by
// recording only a root-relative path plus a content hash. Nothing in this
// module ever stores or falls back to an absolute path: a ref that cannot be
// expressed relative to its root is rejected outright, at creation and at
// resolution, so a saved run tree keeps resolving correctly after its
// directory moves.

import fs from "node:fs";
import path from "node:path";

import { sha256 } from "./evidence.ts";

export interface ArtifactRef {
  path: string;
  sha256: string;
}

export class ArtifactRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRefError";
  }
}

function relativeWithinRoot(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  if (rel !== "" && (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel))) {
    return null;
  }
  return rel;
}

// String-based containment (relativeWithinRoot on path.resolve output) only checks
// the path's spelling, not what it points to: a symlink whose own path lies inside
// root can still resolve to a target outside it. Every path this module reads must
// therefore also pass containment on its realpath.
function assertRealpathContained(root: string, target: string, label: string): void {
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    return;
  }
  const realRoot = fs.realpathSync(root);
  if (relativeWithinRoot(realRoot, realTarget) === null) {
    throw new ArtifactRefError(`${label} escapes root through a symlink: ${target}`);
  }
}

export function makeArtifactRef(root: string, absolutePath: string): ArtifactRef {
  if (!path.isAbsolute(absolutePath)) {
    throw new ArtifactRefError(`artifact source path must be absolute: ${absolutePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const rel = relativeWithinRoot(resolvedRoot, path.resolve(absolutePath));
  if (rel === null) {
    throw new ArtifactRefError(`artifact path is outside root: ${absolutePath}`);
  }
  assertRealpathContained(resolvedRoot, absolutePath, "artifact source path");
  const contents = fs.readFileSync(absolutePath, "utf8");
  return { path: rel.split(path.sep).join("/"), sha256: sha256(contents) };
}

export function resolveArtifactRef(root: string, ref: ArtifactRef): string {
  if (path.isAbsolute(ref.path)) {
    throw new ArtifactRefError(`artifact ref path must be run-relative, got absolute: ${ref.path}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ref.path);
  const rel = relativeWithinRoot(resolvedRoot, resolved);
  if (rel === null) {
    throw new ArtifactRefError(`artifact ref escapes root: ${ref.path}`);
  }
  if (rel === "") {
    throw new ArtifactRefError(`artifact ref path must not be empty or resolve to the root itself: ${JSON.stringify(ref.path)}`);
  }
  assertRealpathContained(resolvedRoot, resolved, "artifact ref");
  return resolved;
}
