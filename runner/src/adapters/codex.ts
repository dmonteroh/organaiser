// Codex vendor command construction: builds the argv shape supervised as
// { command, args, input, cwd, env } for `superviseProcess`.

export interface VendorProfile {
  runner: string;
  codexModel: string;
  codexEffort: string;
  codexBypass: boolean;
  sandboxMode: string;
  claudeModel: string;
  claudeEffort: string;
  claudeStreamJson: boolean;
  claudeBypass: boolean;
  allowedTools: string;
  workdir: string;
  home?: string | null;
}

export interface VendorCommand {
  command: string;
  args: string[];
  input: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

// Codex always reads its packet from stdin (`codex exec … -`), so `input` carries the
// packet on every call regardless of the other flags chosen below.
export function buildCodexCommand(
  profile: VendorProfile,
  packet: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): VendorCommand {
  if (profile.runner !== "codex") {
    throw new Error(`unknown vendor: ${profile.runner} (must be codex)`);
  }

  const env = profile.home ? { ...baseEnv, HOME: profile.home } : undefined;

  const args = ["exec", "-m", profile.codexModel, "-c", `model_reasoning_effort="${profile.codexEffort}"`];
  if (profile.codexBypass) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("-s", profile.sandboxMode);
  }
  args.push("-C", profile.workdir, "-");

  return { command: "codex", args, input: packet, cwd: profile.workdir, env };
}
