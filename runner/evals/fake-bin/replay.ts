#!/usr/bin/env node
// Replays a scripted stream file to stdout as a real, standalone process, so tests that
// need a real pid, a real process group, or a real SIGTERM trap get one. The stream
// format is deliberately dumb: one JSON object per line, each either an event
// (`output` or `report`, echoed to stdout as a JSON line) or a control directive
// (`sleep`, `exit`, `trap-sigterm`).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

interface WriteFileLine {
  op: "write-file";
  path: string;
  text: string;
}

type StreamLine = OutputLine | ReportLine | SleepLine | ExitLine | TrapSigtermLine | WriteFileLine;

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
      case "write-file": {
        const cwd = process.cwd();
        const resolved = path.resolve(cwd, directive.path);
        const relative = path.relative(cwd, resolved);
        if (path.isAbsolute(directive.path) || relative.startsWith("..") || path.isAbsolute(relative)) {
          process.stderr.write(`usage: write-file path must be relative and resolve inside cwd, got ${directive.path}\n`);
          process.exit(2);
        }
        mkdirSync(path.dirname(resolved), { recursive: true });
        writeFileSync(resolved, directive.text, "utf8");
        break;
      }
      case "exit":
        process.exit(directive.code);
    }
  }
}

main();
