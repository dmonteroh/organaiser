// Stress the regex-collapse approach with tricky precedence / nesting to see
// if it really handles grouping or just got lucky.

function matchTerm(term, record) {
  const [field, value] = term.split(":");
  const recVal = record[field];
  if (recVal === undefined) return false;
  if (value === "me" && field === "assignee") return recVal === record.__me;
  return String(recVal) === value;
}

function evalRegexCollapse(query, record) {
  let s = query.replace(/[A-Za-z_]+:[A-Za-z0-9_]+/g, (m) =>
    matchTerm(m, record) ? "T" : "F"
  );
  let prev, guard = 0;
  do {
    prev = s;
    guard++;
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

// Reference: a correct recursive-descent parser to compute ground truth.
function refEval(query, record) {
  const toks = query.match(/\(|\)|\bAND\b|\bOR\b|[A-Za-z_]+:[A-Za-z0-9_]+/g) || [];
  let pos = 0;
  const peek = () => toks[pos];
  function parseOr() {
    let left = parseAnd();
    while (peek() === "OR") { pos++; const r = parseAnd(); left = left || r; }
    return left;
  }
  function parseAnd() {
    let left = parseAtom();
    while (peek() === "AND") { pos++; const r = parseAtom(); left = left && r; }
    return left;
  }
  function parseAtom() {
    if (peek() === "(") { pos++; const v = parseOr(); pos++; /* ) */ return v; }
    const t = toks[pos++]; return matchTerm(t, record);
  }
  return parseOr();
}

const record = { status: "open", assignee: "alice", priority: "high", __me: "alice" };

const queries = [
  // deep nesting
  "((status:open))",
  "status:open AND (priority:high OR (assignee:bob AND status:closed))",
  // the classic precedence trap inside parens, multiple ANDs and ORs mixed
  "status:open OR priority:low AND status:closed OR assignee:bob",
  // bug-prone: collapsing across paren boundaries.
  // "F AND ( T OR F )" -> if regex collapses "F AND (" wrongly it breaks.
  "status:closed AND (assignee:me OR priority:high) OR status:open",
  // adjacent: a value next to a paren group
  "(status:open AND priority:high) OR (assignee:bob AND status:closed)",
  // tricky: AND outside, OR inside, then AND again
  "status:open AND (priority:low OR assignee:me) AND priority:high",
  // all false group
  "status:closed OR (priority:low AND assignee:bob)",
  // operator precedence where wrong grouping changes answer
  "priority:high OR status:closed AND assignee:bob", // = high OR (closed AND bob) = T
  "(priority:high OR status:closed) AND assignee:bob", // = T AND F = F
];

let mism = 0;
for (const q of queries) {
  const got = evalRegexCollapse(q, record);
  const ref = refEval(q, record);
  const ok = got === ref;
  if (!ok) mism++;
  console.log((ok ? "OK  " : "MISMATCH") + " | collapse=" + JSON.stringify(got) + " ref=" + ref + " | " + q);
}
console.log("\nmismatches: " + mism + "/" + queries.length);
