// The `orga doctor` command body (goals spec section 25.1): probes each requested
// vendor's readiness and reports the nine `CapabilityReport` fields plus a usability
// verdict computed from that report and the known-bad version list. Exit codes follow
// goals spec section 25.3: `0` when the vendor is usable, `15` when it is missing,
// unauthenticated, or on the known-bad list, `2` for a missing or unknown `--vendor`.
// Omitting `--vendor` probes both vendors and returns the worst code.

import { probeVendor, isKnownBadVersion, knownBadReason, PROBE_SPECS, type VendorId } from "../adapters/probe.ts";
import type { CapabilityReport } from "../adapters/adapter.ts";
import { EXIT_CODES, type ExitCode } from "./exit-codes.ts";
import type { Io } from "./commands.ts";

const VENDOR_IDS: readonly VendorId[] = ["claude", "codex"];

function isVendorId(value: string): value is VendorId {
  return (VENDOR_IDS as readonly string[]).includes(value);
}

interface DoctorResult {
  vendor: VendorId;
  report: CapabilityReport;
  usable: boolean;
  reason: string;
}

function classify(vendor: VendorId, report: CapabilityReport): { usable: boolean; reason: string } {
  if (report.executablePath === "unknown") {
    return { usable: false, reason: "binary-missing" };
  }
  if (isKnownBadVersion(vendor, report.cliVersion)) {
    return { usable: false, reason: `known-bad-version:${report.cliVersion}:${knownBadReason(vendor, report.cliVersion)}` };
  }
  if (report.authenticationOutcome !== "authenticated") {
    return { usable: false, reason: `authentication:${report.authenticationOutcome}` };
  }
  return { usable: true, reason: "usable" };
}

async function probeOne(vendor: VendorId, io: Io): Promise<DoctorResult> {
  const spec = PROBE_SPECS[vendor];
  const report = await probeVendor(spec, {
    executablePath: spec.defaultExecutable,
    requestedModel: "default",
    requestedEffort: "default",
    workingDirectory: io.cwd(),
    environment: io.env,
  });
  const { usable, reason } = classify(vendor, report);
  return { vendor, report, usable, reason };
}

interface DoctorParsedArgs {
  positionals: readonly string[];
  flags: ReadonlyMap<string, string | boolean>;
}

export async function cmdDoctor(parsed: DoctorParsedArgs, io: Io): Promise<ExitCode> {
  const rawVendor = parsed.flags.get("vendor");
  if (rawVendor !== undefined && typeof rawVendor !== "string") {
    io.stderr("error: --vendor requires a value");
    return EXIT_CODES.INVALID_ARGS;
  }

  let vendors: readonly VendorId[];
  if (rawVendor === undefined) {
    vendors = VENDOR_IDS;
  } else if (isVendorId(rawVendor)) {
    vendors = [rawVendor];
  } else {
    io.stderr(`error: unknown --vendor "${rawVendor}" (expected claude or codex)`);
    return EXIT_CODES.INVALID_ARGS;
  }

  const json = parsed.flags.get("json") === true;
  const results = await Promise.all(vendors.map((vendor) => probeOne(vendor, io)));

  if (json) {
    io.stdout(
      JSON.stringify(results.map(({ vendor, usable, reason, report }) => ({ vendor, usable, reason, report }))),
    );
  } else {
    for (const { vendor, report, usable, reason } of results) {
      io.stdout(`${vendor}: ${usable ? "usable" : `unusable (${reason})`}`);
      io.stdout(`  executablePath: ${report.executablePath}`);
      io.stdout(`  cliVersion: ${report.cliVersion}`);
      io.stdout(`  requestedModel: ${report.requestedModel}`);
      io.stdout(`  requestedEffort: ${report.requestedEffort}`);
      io.stdout(`  structuredOutputMode: ${report.structuredOutputMode}`);
      io.stdout(`  authenticationOutcome: ${report.authenticationOutcome}`);
      io.stdout(`  workingDirectoryBehavior: ${report.workingDirectoryBehavior}`);
      io.stdout(`  permissionAndSandboxConfiguration: ${report.permissionAndSandboxConfiguration}`);
      io.stdout(`  adapterVersion: ${report.adapterVersion}`);
    }
  }
  io.stderr(`orga doctor: probed ${results.length} vendor(s)`);

  let worst: ExitCode = EXIT_CODES.OK;
  for (const result of results) {
    if (!result.usable) worst = EXIT_CODES.VENDOR_UNAVAILABLE;
  }
  return worst;
}
