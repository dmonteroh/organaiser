import fs from "node:fs";
import path from "node:path";

import { redactorForRoot } from "../src/store/redact.ts";
import type { CapturedCellRecord } from "./cell-runner.ts";
import { serializeBoardSnapshot } from "./board-yaml.ts";

function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function toJsonl(items: readonly Record<string, unknown>[] | null): string {
  if (items === null || items.length === 0) return "";
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

function vendorStdoutJsonl(vendorStdout: Record<string, string> | null): string {
  if (vendorStdout === null) return "";
  const entries = Object.entries(vendorStdout);
  if (entries.length === 0) return "";
  return entries.map(([name, text]) => JSON.stringify({ name, text })).join("\n") + "\n";
}

export function writeCellArtifacts(record: CapturedCellRecord, cellDir: string, root: string): void {
  fs.mkdirSync(cellDir, { recursive: true });
  const redact = redactorForRoot(root, process.env);

  const files: Record<string, string> = {
    "eval-snapshot.json": toJson({
      cellId: record.cellId,
      evalRunId: record.evalRunId,
      unit: record.unit,
      profile: record.profile,
      fixtureId: record.fixtureId,
      shape: record.shape,
      disposition: record.disposition,
      dispositionDetail: record.dispositionDetail,
      snapshot: {
        prompt: record.snapshot.prompt,
        taskFixture: record.snapshot.taskFixture,
        cliVersion: record.snapshot.cliVersion,
        workflowRevision: record.snapshot.workflowRevision,
        model: record.snapshot.model,
      },
    }),
    "fixture-base.txt": record.snapshot.taskFixture,
    "resolved-config.json": toJson(record.snapshot.resolvedConfig),
    "process.json": toJson(record.process),
    "events.jsonl": toJsonl(record.events),
    "vendor-stdout.jsonl": vendorStdoutJsonl(record.vendorStdout),
    "vendor-stderr.log": record.vendorStderr ?? "",
    "worker-report.json": toJson(record.workerReport),
    "board-before.yaml": serializeBoardSnapshot(record.board?.before ?? null),
    "board-after.yaml": serializeBoardSnapshot(record.board?.after ?? null),
    "state-transitions.jsonl": toJsonl(record.stateTransitions),
    "git-before.txt": record.git?.before ?? "",
    "git-after.txt": record.git?.after ?? "",
    "diff.patch": record.git?.diff ?? "",
  };

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(cellDir, name), redact(content), "utf8");
  }
}
