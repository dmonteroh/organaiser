// Locates the workflow catalog (`workflows/schemas`, `workflows/subagents`,
// `workflows/manifests`) relative to this module's own file, in both tree
// shapes the runner runs in: the dev monorepo (`<repo>/runner/src/...`,
// catalog at `<repo>/workflows/`) and a bootstrapped install
// (`.orga/runner/<version>/src/...`, catalog at
// `.orga/runner/<version>/workflows/`). The bundled candidate is probed
// before the dev candidate so a bootstrapped install's catalog is never
// shadowed by a stray sibling directory.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function resolveWorkflowsRoot(moduleUrl: string): URL {
  const bundled = new URL("../workflows/", moduleUrl);
  const dev = new URL("../../workflows/", moduleUrl);
  if (existsSync(fileURLToPath(bundled))) return bundled;
  if (existsSync(fileURLToPath(dev))) return dev;
  throw new Error(
    `workflow catalog not found at either ${fileURLToPath(bundled)} or ${fileURLToPath(dev)}`,
  );
}

let cachedRoot: URL | undefined;

export function workflowAssetUrl(relative: string): URL {
  cachedRoot ??= resolveWorkflowsRoot(import.meta.url);
  return new URL(relative, cachedRoot);
}

export function workflowAssetPath(relative: string): string {
  return fileURLToPath(workflowAssetUrl(relative));
}
