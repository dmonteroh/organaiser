import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withTempWorkspace } from "./helpers/workspace.ts";
import { parseYamlText } from "../src/cli/yaml.ts";
import { resolveVendorProfile, serializeResolvedProfile, type VendorProfileSources } from "../src/cli/profiles.ts";
import {
  probeVendor,
  isKnownBadVersion,
  knownBadReason,
  type ProbeIo,
  type ProbeSpawnResult,
  type VendorProbeSpec,
} from "../src/adapters/probe.ts";
import type { ProbeConfiguration } from "../src/adapters/adapter.ts";
import { initProject } from "../src/store/init.ts";
import { main } from "../bin/orga.ts";
import type { Io } from "../src/cli/commands.ts";
import { knownBadVersionRefused } from "../evals/fixtures/12-known-bad-version-refused.ts";

// ── yaml.ts ──────────────────────────────────────────────────────────────────

test("yaml: refuses an anchor", () => {
  assert.throws(() => parseYamlText('key: &x "value"\n', "t.yaml"), /t\.yaml:1: anchor/);
});

test("yaml: refuses an alias", () => {
  assert.throws(() => parseYamlText("key: *x\n", "t.yaml"), /t\.yaml:1: alias/);
});

test("yaml: refuses a tag", () => {
  assert.throws(() => parseYamlText("key: !!str foo\n", "t.yaml"), /t\.yaml:1: tag/);
});

test("yaml: refuses a flow mapping {}", () => {
  assert.throws(() => parseYamlText("key: {}\n", "t.yaml"), /t\.yaml:1: flow mapping/);
});

test("yaml: refuses a non-empty flow mapping", () => {
  assert.throws(() => parseYamlText("key: {a: 1}\n", "t.yaml"), /t\.yaml:1: flow mapping/);
});

test("yaml: refuses a non-empty flow sequence", () => {
  assert.throws(() => parseYamlText("key: [a, b]\n", "t.yaml"), /t\.yaml:1: flow sequence/);
});

test("yaml: refuses a literal block scalar", () => {
  assert.throws(() => parseYamlText("key: |\n  text\n", "t.yaml"), /t\.yaml:1: multi-line block scalar/);
});

test("yaml: refuses a folded block scalar", () => {
  assert.throws(() => parseYamlText("key: >\n  text\n", "t.yaml"), /t\.yaml:1: multi-line block scalar/);
});

test("yaml: refuses a tab-indented line", () => {
  assert.throws(() => parseYamlText("key:\n\tchild: 1\n", "t.yaml"), /t\.yaml:2: unparsable line/);
});

test("yaml: refuses an indent step other than two", () => {
  assert.throws(() => parseYamlText("key:\n    child: 1\n", "t.yaml"), /t\.yaml:2: expected indent step of 2/);
});

test("yaml: refuses a bare key with no value and no nested block", () => {
  assert.throws(() => parseYamlText("key:\nother: 1\n", "t.yaml"), /t\.yaml:1: "key:" has no inline value/);
});

test("yaml: [] is the one supported empty-collection form", () => {
  assert.deepEqual(parseYamlText("items: []\n", "t.yaml"), { items: [] });
});

test("yaml: parses the orga.yaml initProject writes today", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const text = fs.readFileSync(path.join(dir, "orga.yaml"), "utf8");
    const parsed = parseYamlText(text, "orga.yaml");
    assert.equal(typeof (parsed.runner as { version: string }).version, "string");
  });
});

test("yaml: blank lines and whole-line comments are ignored", () => {
  const text = "# a comment\n\nkey: value\n\n# trailing\n";
  assert.deepEqual(parseYamlText(text, "t.yaml"), { key: "value" });
});

// ── profiles.ts ──────────────────────────────────────────────────────────────

function fileSource(filePath: string, text: string): { path: string; text: string } {
  return { path: filePath, text };
}

test("profiles: each layer wins over every layer below it for at least one field", () => {
  const project = fileSource(
    "project.yaml",
    "vendors:\n  codex:\n    default:\n      model: \"project-model\"\n      sandboxMode: \"project-sandbox\"\n",
  );
  const user = fileSource(
    "user.yaml",
    "vendors:\n  codex:\n    default:\n      model: \"user-model\"\n      sandboxMode: \"user-sandbox\"\n      effort: \"user-effort\"\n",
  );
  const sources: VendorProfileSources = {
    vendor: "codex",
    flags: { model: "flag-model" },
    env: { ORGA_SANDBOX_MODE: "env-sandbox" },
    project,
    user,
  };
  const profile = resolveVendorProfile("default", sources);
  assert.equal(profile.model, "flag-model", "flags must win over env/project/user/default");
  assert.equal(profile.sandboxMode, "env-sandbox", "env must win over project/user/default");
  assert.equal(profile.effort, "user-effort", "user must win over the built-in default when project is silent");
  assert.equal(profile.executable, "codex", "an unset field falls all the way through to the built-in default");
});

test("profiles: a project file with no vendors: block resolves entirely from defaults", async () => {
  await withTempWorkspace(async (dir) => {
    initProject(dir);
    const orgaYamlPath = path.join(dir, "orga.yaml");
    const text = fs.readFileSync(orgaYamlPath, "utf8");

    const bare = resolveVendorProfile("default", { vendor: "codex" });
    const withInitYaml = resolveVendorProfile("default", {
      vendor: "codex",
      project: fileSource(orgaYamlPath, text),
    });
    assert.deepEqual(withInitYaml, bare);
  });
});

test("profiles: an unknown capability class falls back to the default class", () => {
  const project = fileSource(
    "project.yaml",
    "vendors:\n  codex:\n    default:\n      model: \"default-class-model\"\n",
  );
  const profile = resolveVendorProfile("some-other-role", { vendor: "codex", project });
  assert.equal(profile.model, "default-class-model");
});

test("profiles: a vendors: block naming an unknown vendor is a configuration error naming the file and line", () => {
  const project = fileSource("project.yaml", "vendors:\n  gemini:\n    default:\n      model: \"x\"\n");
  assert.throws(
    () => resolveVendorProfile("default", { vendor: "codex", project }),
    /project\.yaml:2: unknown vendor "gemini"/,
  );
});

test("profiles: serializeResolvedProfile round-trips byte-identically and never emits an env value", () => {
  const secretEnv = { ORGA_MODEL: "leaky-value-xyz", UNRELATED_SECRET_VALUE: "must-not-appear-anywhere" };
  const profile = resolveVendorProfile("default", { vendor: "claude", env: secretEnv });
  const first = serializeResolvedProfile(profile);
  const second = serializeResolvedProfile(profile);
  assert.equal(first, second);
  assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
  assert.ok(!first.includes("must-not-appear-anywhere"));
  const parsed = JSON.parse(first) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    "executable",
    "model",
    "effort",
    "permissionMode",
    "sandboxMode",
    "toolPolicy",
    "environmentAllowlist",
    "timeouts",
    "budgetUsd",
    "maxConcurrentProcesses",
  ]);
});

// ── probe.ts ─────────────────────────────────────────────────────────────────

function baseConfiguration(overrides: Partial<ProbeConfiguration> = {}): ProbeConfiguration {
  return {
    executablePath: "stub-vendor",
    requestedModel: "requested-model",
    requestedEffort: "requested-effort",
    workingDirectory: process.cwd(),
    environment: { PATH: "" },
    ...overrides,
  };
}

function testSpec(overrides: Partial<VendorProbeSpec> = {}): VendorProbeSpec {
  return {
    vendor: "codex",
    defaultExecutable: "stub-vendor",
    adapterVersion: "test-adapter-1",
    structuredOutputMode: "test-structured-output",
    workingDirectoryBehavior: "test-working-directory-behavior",
    permissionAndSandboxConfiguration: "test-permission-and-sandbox",
    versionArgs: ["--version"],
    parseVersion: (result: ProbeSpawnResult) => {
      const match = result.stdout.match(/\d+\.\d+\.\d+/);
      return match ? match[0] : null;
    },
    authProbeArgs: ["doctor-auth-probe"],
    authProbeTimeoutMs: 300,
    parseAuthOutcome: (result: ProbeSpawnResult) => (result.exitCode === 0 ? "authenticated" : "unauthenticated"),
    ...overrides,
  };
}

function writeStub(dir: string, name: string, script: string): string {
  const stubPath = path.join(dir, name);
  fs.writeFileSync(stubPath, script, { mode: 0o755 });
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

const VERSION_THEN_HANG_STUB = (version: string): string => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("stub-vendor ${version}\\n");
  process.exit(0);
}
if (args[0] === "doctor-auth-probe") {
  setInterval(() => {}, 1000);
} else {
  process.exit(1);
}
`;

const VERSION_AND_AUTH_OK_STUB = (version: string): string => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("stub-vendor ${version}\\n");
  process.exit(0);
}
if (args[0] === "doctor-auth-probe") {
  process.exit(0);
}
process.exit(1);
`;

test("probe: a missing binary leaves cliVersion/authenticationOutcome unknown but keeps spec-derived fields real", async () => {
  const configuration = baseConfiguration({ environment: { PATH: "/definitely-not-a-real-dir-xyz" } });
  const report = await probeVendor(testSpec(), configuration);
  assert.equal(report.executablePath, "unknown");
  assert.equal(report.cliVersion, "unknown");
  assert.equal(report.authenticationOutcome, "unknown");
  assert.equal(report.requestedModel, "requested-model");
  assert.equal(report.requestedEffort, "requested-effort");
  assert.equal(report.structuredOutputMode, "test-structured-output");
  assert.equal(report.workingDirectoryBehavior, "test-working-directory-behavior");
  assert.equal(report.permissionAndSandboxConfiguration, "test-permission-and-sandbox");
  assert.equal(report.adapterVersion, "test-adapter-1");
});

test("probe: a real path, a real version, and authenticationOutcome === probe-timeout for a hanging auth probe", async () => {
  await withTempWorkspace(async (dir) => {
    writeStub(dir, "stub-vendor", VERSION_THEN_HANG_STUB("1.2.3"));
    const configuration = baseConfiguration({
      environment: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const report = await probeVendor(testSpec(), configuration);
    assert.equal(report.executablePath, path.join(dir, "stub-vendor"));
    assert.equal(report.cliVersion, "1.2.3");
    assert.equal(report.authenticationOutcome, "probe-timeout");
  });
});

test("probe: never rejects even when the resolved binary exits non-zero on every invocation", async () => {
  await withTempWorkspace(async (dir) => {
    writeStub(
      dir,
      "stub-vendor",
      `#!/usr/bin/env node\nprocess.exit(7);\n`,
    );
    const configuration = baseConfiguration({
      environment: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const report = await probeVendor(testSpec(), configuration);
    assert.equal(report.executablePath, path.join(dir, "stub-vendor"));
    assert.equal(report.cliVersion, "unknown");
  });
});

test("probe: never opens a credential file, proved by a recording ProbeIo", async () => {
  await withTempWorkspace(async (dir) => {
    const claudeDir = path.join(dir, ".claude");
    const codexDir = path.join(dir, ".codex");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "credentials"), "CLAUDE-SECRET-DO-NOT-LEAK");
    fs.writeFileSync(path.join(codexDir, "auth.json"), '{"token":"CODEX-SECRET-DO-NOT-LEAK"}');
    const sentinelPath = path.join(dir, "sentinel.txt");
    const sentinelContents = "SENTINEL-VALUE-DO-NOT-LEAK";
    fs.writeFileSync(sentinelPath, sentinelContents);

    const stubDir = path.join(dir, "bin");
    fs.mkdirSync(stubDir, { recursive: true });
    const stubPath = writeStub(stubDir, "stub-vendor", VERSION_AND_AUTH_OK_STUB("9.9.9"));

    const recorded: string[] = [];
    const recordingIo: ProbeIo = {
      exists: async (targetPath: string) => {
        recorded.push(targetPath);
        return targetPath === stubPath;
      },
      readFile: async (targetPath: string) => {
        recorded.push(targetPath);
        return "";
      },
      spawn: async (command: string, args: readonly string[]) => {
        const result = await import("node:child_process").then(
          ({ execFileSync }) =>
            new Promise<ProbeSpawnResult>((resolve) => {
              try {
                const stdout = execFileSync(command, args as string[], { encoding: "utf8" });
                resolve({ stdout, stderr: "", exitCode: 0, timedOut: false });
              } catch (err) {
                const e = err as { stdout?: string; stderr?: string; status?: number | null };
                resolve({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? null, timedOut: false });
              }
            }),
        );
        return result;
      },
    };

    const configuration = baseConfiguration({
      environment: { PATH: stubDir, HOME: dir },
    });
    const report = await probeVendor(testSpec(), configuration, recordingIo);

    assert.ok(recorded.length > 0, "the probe must have exercised the injected exists/readFile seam");
    const forbidden = [".claude", ".codex", "auth.json", "credentials", ".netrc", "token"];
    for (const recordedPath of recorded) {
      for (const marker of forbidden) {
        assert.ok(
          !recordedPath.includes(marker),
          `recorded path "${recordedPath}" must never reference a credential-shaped path (marker: ${marker})`,
        );
      }
    }
    for (const value of Object.values(report)) {
      assert.ok(!String(value).includes(sentinelContents), "no report field may contain the sentinel file's contents");
    }
  });
});

test("probe.ts source text imports no fs/fs-promises/child_process module, under any spelling", () => {
  const probeSourcePath = fileURLToPath(new URL("../src/adapters/probe.ts", import.meta.url));
  const source = fs.readFileSync(probeSourcePath, "utf8");
  const forbiddenSpecifiers = [
    '"fs"',
    "'fs'",
    '"node:fs"',
    "'node:fs'",
    '"fs/promises"',
    "'fs/promises'",
    '"node:fs/promises"',
    "'node:fs/promises'",
    '"child_process"',
    "'child_process'",
    '"node:child_process"',
    "'node:child_process'",
  ];
  for (const specifier of forbiddenSpecifiers) {
    assert.ok(!source.includes(specifier), `probe.ts must not import ${specifier}`);
  }
});

test("isKnownBadVersion: whole-token matching only", () => {
  assert.equal(isKnownBadVersion("codex", "0.120.2"), true);
  assert.equal(isKnownBadVersion("codex", "0.120.2-beta"), true);
  assert.equal(isKnownBadVersion("codex", "0.120.20"), false);
  assert.equal(isKnownBadVersion("codex", "0.120.0"), true);
  assert.equal(isKnownBadVersion("codex", "0.120.1"), true);
  assert.equal(isKnownBadVersion("codex", "0.121.0"), false);
  assert.equal(isKnownBadVersion("claude", "0.120.2"), false);
  assert.equal(knownBadReason("codex", "0.120.2"), "stdin deadlock");
  assert.equal(knownBadReason("codex", "0.120.20"), null);
});

// ── doctor.ts ────────────────────────────────────────────────────────────────

function doctorIo(env: NodeJS.ProcessEnv): Io & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    stdout: (line: string) => outLines.push(line),
    stderr: (line: string) => errLines.push(line),
    cwd: () => process.cwd(),
    now: () => Date.now(),
    env,
  };
}

test("doctor: exits 2 for an unknown --vendor", async () => {
  const io = doctorIo({});
  const code = await main(["node", "orga", "doctor", "--vendor", "docker"], io);
  assert.equal(code, 2);
});

test("doctor: exits 15 when the vendor binary is missing", async () => {
  const io = doctorIo({ PATH: "/definitely-not-a-real-dir-xyz" });
  const code = await main(["node", "orga", "doctor", "--vendor", "codex", "--json"], io);
  assert.equal(code, 15);
  const payload = JSON.parse(io.outLines[0] as string) as Array<{ usable: boolean; reason: string }>;
  assert.equal(payload[0]?.usable, false);
  assert.equal(payload[0]?.reason, "binary-missing");
});

test("doctor: exits 0 when the vendor is present, authenticated, and not on the known-bad list", async () => {
  await withTempWorkspace(async (dir) => {
    writeStub(dir, "codex", VERSION_AND_AUTH_OK_STUB("9.9.9"));
    const io = doctorIo({ ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` });
    const code = await main(["node", "orga", "doctor", "--vendor", "codex", "--json"], io);
    assert.equal(code, 0, `expected a usable vendor to exit 0; stderr: ${io.errLines.join("\n")}`);
  });
});

test("fixture: known-bad-version-refused", knownBadVersionRefused);
