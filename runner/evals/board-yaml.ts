export interface BoardSnapshotInput {
  run: Record<string, unknown> | undefined;
  tasks: Record<string, unknown>[];
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "" || text.includes(":") || text.includes('"') || text.includes("\n")) {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return `"${escaped}"`;
  }
  return text;
}

function renderRun(run: Record<string, unknown> | undefined): string[] {
  if (run === undefined) return ["run: null"];
  const lines = ["run:"];
  for (const key of Object.keys(run)) {
    lines.push(`  ${key}: ${renderScalar(run[key])}`);
  }
  return lines;
}

function renderTasks(tasks: readonly Record<string, unknown>[]): string[] {
  if (tasks.length === 0) return ["tasks: []"];
  const lines = ["tasks:"];
  for (const task of tasks) {
    const keys = Object.keys(task);
    keys.forEach((key, index) => {
      const prefix = index === 0 ? "  - " : "    ";
      lines.push(`${prefix}${key}: ${renderScalar(task[key])}`);
    });
  }
  return lines;
}

export function serializeBoardSnapshot(snapshot: BoardSnapshotInput | null): string {
  if (snapshot === null) {
    return "run: null\ntasks: []\n";
  }
  return [...renderRun(snapshot.run), ...renderTasks(snapshot.tasks)].join("\n") + "\n";
}
