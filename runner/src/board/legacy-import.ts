export const CONTRACT_OPEN = "<<<RALPH_CONTRACT";
export const CONTRACT_CLOSE = "RALPH_CONTRACT>>>";

export class ContractError extends Error {
  errors: Array<{ path: string; message: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string }> = []) {
    super(message);
    this.name = "ContractError";
    this.errors = errors;
  }
}

export function extractContractText(stdout: unknown): string {
  if (typeof stdout !== "string") {
    throw new ContractError("orchestrator output is not a string");
  }
  const open = stdout.lastIndexOf(CONTRACT_OPEN);
  if (open === -1) {
    throw new ContractError(`missing contract open delimiter ${CONTRACT_OPEN}`);
  }
  const afterOpen = open + CONTRACT_OPEN.length;
  const close = stdout.indexOf(CONTRACT_CLOSE, afterOpen);
  if (close === -1) {
    throw new ContractError(`missing contract close delimiter ${CONTRACT_CLOSE}`);
  }
  return stdout.slice(afterOpen, close).trim();
}
