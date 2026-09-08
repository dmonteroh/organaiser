import type { YamlMapping } from "../../src/cli/yaml.ts";
import type { FrozenCellBundle, GradingCheck } from "./types.ts";

const ID = "git-ancestry";
const HEAD_LINE = /^HEAD ([0-9a-f]{40})$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TRUNCATED_LINE = "TRUNCATED: 500";

function build(outcome: GradingCheck["outcome"], detail: string | null): GradingCheck {
  return { id: ID, grader: "deterministic", outcome, detail };
}

function headShaOf(text: string): string | null {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const match = HEAD_LINE.exec(firstLine);
  return match ? match[1]! : null;
}

interface CommitGraph {
  commits: Map<string, string[]>;
  refTips: Set<string>;
  truncated: boolean;
}

function parseCommitGraph(text: string): CommitGraph | null {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let truncated = false;
  if (lines.length > 0 && lines[lines.length - 1] === TRUNCATED_LINE) {
    truncated = true;
    lines.pop();
  }

  const refsIndex = lines.indexOf("REFS:");
  const commitsIndex = lines.indexOf("COMMITS:");
  if (refsIndex === -1 || commitsIndex === -1 || commitsIndex < refsIndex) return null;

  const refTips = new Set<string>();
  for (let i = refsIndex + 1; i < commitsIndex; i++) {
    const line = lines[i];
    if (!line) continue;
    const sha = line.split(" ")[0];
    if (sha) refTips.add(sha);
  }

  const commits = new Map<string, string[]>();
  for (let i = commitsIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(" ");
    const sha = parts[0];
    if (!sha) continue;
    commits.set(sha, parts.slice(1));
  }

  return { commits, refTips, truncated };
}

function isAncestor(commits: Map<string, string[]>, after: string, before: string): { reached: boolean; sawUnknownParent: boolean } {
  const visited = new Set<string>([after]);
  const stack: string[] = [after];
  let sawUnknownParent = false;
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === before) return { reached: true, sawUnknownParent };
    const parents = commits.get(sha) ?? [];
    for (const parent of parents) {
      if (!commits.has(parent)) {
        sawUnknownParent = true;
        continue;
      }
      if (!visited.has(parent)) {
        visited.add(parent);
        stack.push(parent);
      }
    }
  }
  return { reached: false, sawUnknownParent };
}

function tasksOf(mapping: YamlMapping): YamlMapping[] {
  const tasks = mapping.tasks;
  if (!Array.isArray(tasks)) return [];
  const result: YamlMapping[] = [];
  for (const task of tasks) {
    if (typeof task === "object" && task !== null && !Array.isArray(task)) {
      result.push(task as YamlMapping);
    }
  }
  return result;
}

function taskIdOf(task: YamlMapping): string {
  const id = task.id;
  return typeof id === "string" ? id : String(id);
}

// No board table, migration, or capture path writes a `result_commit`/`resultCommit`
// key on any task row today, so this clause is vacuous on every real cell; it stays
// wired up so grading is live the day a producer lands one.
function recordedCommitOf(task: YamlMapping): string | null {
  const raw = task.result_commit !== undefined ? task.result_commit : task.resultCommit;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function checkRecordedCommitIdentities(bundle: FrozenCellBundle, graph: CommitGraph): GradingCheck | null {
  if (bundle.boardBefore.status !== "ok" || bundle.boardAfter.status !== "ok") return null;

  for (const mapping of [bundle.boardBefore.value, bundle.boardAfter.value]) {
    for (const task of tasksOf(mapping)) {
      const recorded = recordedCommitOf(task);
      if (recorded === null) continue;
      if (!SHA_RE.test(recorded)) {
        return build("fail", `task ${taskIdOf(task)} records commit identity "${recorded}", which is not a concrete sha`);
      }
      if (!graph.commits.has(recorded) && !graph.refTips.has(recorded)) {
        const outcome = graph.truncated ? "operational-failure" : "fail";
        return build(outcome, `task ${taskIdOf(task)} records commit identity ${recorded}, which is not present in the frozen commit graph`);
      }
    }
  }
  return null;
}

export function gradeGitAncestry(bundle: FrozenCellBundle): GradingCheck {
  if (bundle.commitGraph.status === "missing") return build("operational-failure", "git-commit-graph.txt is missing");
  if (bundle.commitGraph.status === "unparseable") {
    return build("operational-failure", `git-commit-graph.txt is unparseable: ${bundle.commitGraph.reason}`);
  }
  if (bundle.gitAfter.status === "missing") return build("operational-failure", "git-after.txt is missing");
  if (bundle.gitAfter.status === "unparseable") {
    return build("operational-failure", `git-after.txt is unparseable: ${bundle.gitAfter.reason}`);
  }
  if (bundle.gitBefore.status === "missing") return build("operational-failure", "git-before.txt is missing");
  if (bundle.gitBefore.status === "unparseable") {
    return build("operational-failure", `git-before.txt is unparseable: ${bundle.gitBefore.reason}`);
  }

  const afterHead = headShaOf(bundle.gitAfter.value);
  if (afterHead === null) return build("not-applicable", null);

  if (bundle.commitGraph.value === "") {
    return build("operational-failure", "git-commit-graph.txt is empty for a cell that recorded a git HEAD");
  }

  const graph = parseCommitGraph(bundle.commitGraph.value);
  if (graph === null) return build("operational-failure", "git-commit-graph.txt is malformed");

  if (!graph.commits.has(afterHead)) {
    const suffix = graph.truncated ? " (graph truncated at 500)" : "";
    return build("operational-failure", `after-HEAD ${afterHead} is not present in the frozen commit graph${suffix}`);
  }

  const beforeHead = headShaOf(bundle.gitBefore.value);
  let reachabilityDetail: string | null = null;

  if (beforeHead === null) {
    reachabilityDetail = "no before-HEAD recorded; graded after-HEAD presence in the frozen commit graph only";
  } else if (beforeHead !== afterHead) {
    const { reached, sawUnknownParent } = isAncestor(graph.commits, afterHead, beforeHead);
    if (!reached) {
      if (!sawUnknownParent) {
        return build("fail", `before-HEAD ${beforeHead} is not an ancestor of after-HEAD ${afterHead}`);
      }
      const suffix = graph.truncated ? " (graph truncated at 500)" : "";
      return build(
        "operational-failure",
        `the frozen commit graph is incomplete: the walk from after-HEAD ${afterHead} reached commits whose parents are not recorded${suffix}`,
      );
    }
  }

  const identityFailure = checkRecordedCommitIdentities(bundle, graph);
  if (identityFailure) return identityFailure;

  return build("pass", reachabilityDetail);
}
