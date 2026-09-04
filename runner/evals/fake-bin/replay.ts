#!/usr/bin/env node
// Replays a scripted stream file to stdout as a real, standalone process, so tests that
// need a real pid, a real process group, or a real SIGTERM trap get one. The stream
// format is deliberately dumb: one JSON object per line, each either an event
// (`output` or `report`, echoed to stdout as a JSON line) or a control directive
// (`sleep`, `exit`, `trap-sigterm`).

import { readFileSync } from "node:fs";

interface OutputLine {
  op: "output";
  text: string;
}

interface ReportLine {
  op: "report";
  report: unknown;
}

interface SleepLine {
  op: "sleep";
  ms: number;
}

interface ExitLine {
  op: "exit";
  code: number;
}

interface TrapSigtermLine {
  op: "trap-sigterm";
}

type StreamLine = OutputLine | ReportLine | SleepLine | ExitLine | TrapSigtermLine;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const streamFile = process.argv[2];
  if (!streamFile) {
    process.stderr.write("usage: replay.ts <stream-file.jsonl>\n");
    process.exit(2);
  }

  const raw = readFileSync(streamFile, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const rawLine of lines) {
    const directive = JSON.parse(rawLine) as StreamLine;
    switch (directive.op) {
      case "output":
        process.stdout.write(`${JSON.stringify({ type: "output", text: directive.text })}\n`);
        break;
      case "report":
        process.stdout.write(`${JSON.stringify({ type: "report", report: directive.report })}\n`);
        break;
      case "sleep":
        await sleep(directive.ms);
        break;
      case "trap-sigterm":
        process.on("SIGTERM", () => {});
        break;
      case "exit":
        process.exit(directive.code);
    }
  }
}

main();
