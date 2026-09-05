// Vendor-to-adapter selection: the one place that turns a vendor id plus a resolved
// profile into a concrete `ProcessAdapter`. Claude and Codex expose different factory
// shapes (`claude-adapter.ts` only builds a `VendorAdapterSpec`, `codex-adapter.ts`
// builds a finished adapter with its own `collect` override), so this module calls the
// right one per branch rather than normalizing either vendor module.

import type { ProcessAdapter } from "./adapter.ts";
import { createClaudeVendorAdapterSpec } from "./claude-adapter.ts";
import { createCodexAdapter } from "./codex-adapter.ts";
import { FakeAdapter } from "./fake.ts";
import { createVendorAdapter, type VendorAdapterOptions } from "./vendor-adapter.ts";
import type { ResolvedVendorProfile } from "../cli/profiles.ts";

const KNOWN_VENDORS = ["claude", "codex", "fake"] as const;

export function selectAdapter(
  vendor: string,
  profile: ResolvedVendorProfile,
  deps: VendorAdapterOptions,
): ProcessAdapter {
  switch (vendor) {
    case "claude":
      return createVendorAdapter(createClaudeVendorAdapterSpec(profile), deps);
    case "codex":
      return createCodexAdapter(profile, deps);
    case "fake":
      return new FakeAdapter({ terminate: deps.terminate });
    default:
      throw new Error(
        `unknown vendor ${JSON.stringify(vendor)}: expected one of ${KNOWN_VENDORS.map((id) => JSON.stringify(id)).join(", ")}`,
      );
  }
}
