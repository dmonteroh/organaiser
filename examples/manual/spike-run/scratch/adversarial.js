// Target the suspected flaw in Approach B: the OR collapse is gated on
// "no AND collapsible ANYWHERE in the whole string", not "within this group".
// Build a case where one group needs an OR collapsed while another group
// still has a pending AND, AND where order of collapsing changes the answer.

function matchTerm(term, record) {
  const [field, value] = term.split(":");
  const recVal = record[field];
  if (recVal === undefined) return false;
  if (value === "me" && field === "assignee") return recVal === record.__me;
  return String(recVal) === value;
}

function evalRegexCollapse(query, record) {
  let s = query.replace(/[A-Za-z_]+:[A-Za-z0-9_]+/g, (m) => (matchTerm(m, record) ? "T" : "F"));
  let prev, guard = 0;
  do {
    prev = s; guard++;
    s = s.replace(/\b([TF])\s+AND\s+([TF])\b/, (_, a, b) => (a === "T" && b === "T" ? "T" : "F"));
    if (s === prev) s = s.replace(/\b([TF])\s+OR\s+([TF])\b/, (_, a, b) => (a === "T" || b === "T" ? "T" : "F"));
    if (s === prev) s = s.replace(/\(\s*([TF])\s*\)/, "$1");
    if (guard > 1000) break;
  } while (s !== prev);
  s = s.trim();
  if (s === "T") return true;
  if (s === "F") return false;
  return { error: "could not collapse", remaining: s };
}

function refEval(query, record) {
  const toks = query.match(/\(|\)|\bAND\b|\bOR\b|[A-Za-z_]+:[A-Za-z0-9_]+/g) || [];
  let pos = 0; const peek = () => toks[pos];
  function parseOr() { let l = parseAnd(); while (peek() === "OR") { pos++; l = parseAnd() || l ? (l || parseAndDummy()) : l; } return l; }
  // simpler correct version:
  function pOr() { let l = pAnd(); while (peek() === "OR") { pos++; const r = pAnd(); l = l || r; } return l; }
  function pAnd() { let l = pAtom(); while (peek() === "AND") { pos++; const r = pAtom(); l = l && r; } return l; }
  function pAtom() { if (peek() === "(") { pos++; const v = pOr(); pos++; return v; } return matchTerm(toks[pos++], record); }
  return pOr();
}

// records to flip values
const recs = [
  { status: "open", assignee: "alice", priority: "high", __me: "alice" },
  { status: "closed", assignee: "bob", priority: "low", __me: "alice" },
  { status: "open", assignee: "bob", priority: "low", __me: "alice" },
  { status: "closed", assignee: "alice", priority: "high", __me: "alice" },
];

// Adversarial queries: mixed AND/OR in separate groups, and a top-level
// expression that mixes OR groups with a trailing AND.
const queries = [
  "(status:open OR priority:low) AND (assignee:bob OR status:closed)",
  "(status:open AND priority:high) OR assignee:bob AND status:closed",
  "status:open OR priority:low AND (assignee:bob OR status:closed)",
  "(status:open OR assignee:bob) AND priority:high OR (status:closed AND priority:low)",
  "status:closed OR status:open AND priority:low OR assignee:bob AND status:closed",
];

let mism = 0;
for (const r of recs) {
  for (const q of queries) {
    const got = evalRegexCollapse(q, r);
    const ref = refEval(q, r);
    const ok = got === ref;
    if (!ok) { mism++; console.log("MISMATCH | got=" + JSON.stringify(got) + " ref=" + ref + " | rec=" + JSON.stringify({s:r.status,a:r.assignee,p:r.priority}) + " | " + q); }
  }
}
console.log("\ntotal mismatches: " + mism + " over " + (recs.length*queries.length) + " evals");
