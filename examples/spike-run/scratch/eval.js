// Throwaway spike: regex-based tokenizer + evaluator for the search-filter mini-language.
// Mini-language: field:value terms, AND / OR operators, parentheses for grouping.

// ---- Special "me" handling: assignee:me resolves against record's currentUser context. ----
function matchTerm(term, record) {
  const [field, value] = term.split(":");
  const recVal = record[field];
  if (recVal === undefined) return false;
  // assignee:me means assignee equals the record's current user.
  if (value === "me" && field === "assignee") {
    return recVal === record.__me;
  }
  return String(recVal) === value;
}

// ---- Tokenizer: regex splits into terms, operators, parens. ----
function tokenize(query) {
  const re = /\(|\)|\bAND\b|\bOR\b|[A-Za-z_]+:[A-Za-z0-9_]+/g;
  return query.match(re) || [];
}

// ============================================================
// APPROACH A: pure regex + left-to-right scan, NO grouping.
// Evaluate flat queries only. Treats AND/OR strictly left to right.
// ============================================================
function evalFlatLeftToRight(query, record) {
  const tokens = tokenize(query);
  // tokens: term (op term)*
  let result = matchTerm(tokens[0], record);
  let i = 1;
  while (i < tokens.length) {
    const op = tokens[i];
    const operand = matchTerm(tokens[i + 1], record);
    if (op === "AND") result = result && operand;
    else if (op === "OR") result = result || operand;
    i += 2;
  }
  return result;
}

// ============================================================
// APPROACH B: regex tokenize, but try to handle precedence via
// regex-only manipulation of the string (no recursion / no stack).
// We attempt: replace each term with true/false, then... can regex
// evaluate nested parens with precedence? Test the claim.
// We simulate the "regex + simple replace" idea: collapse innermost
// parens repeatedly using regex. This is the honest test of whether
// a "regex approach" (no real parser) can do grouping.
// ============================================================
function evalRegexCollapse(query, record) {
  // Step 1: replace terms with T/F using regex.
  let s = query.replace(/[A-Za-z_]+:[A-Za-z0-9_]+/g, (m) =>
    matchTerm(m, record) ? "T" : "F"
  );
  // Now s looks like: "T AND ( F OR T )"
  // Step 2: collapse using regex until stable.
  // Precedence: AND binds tighter than OR. We must do AND before OR.
  let prev;
  let guard = 0;
  do {
    prev = s;
    guard++;
    // collapse AND first (tighter)
    s = s.replace(/\b([TF])\s+AND\s+([TF])\b/, (_, a, b) =>
      a === "T" && b === "T" ? "T" : "F"
    );
    // only collapse OR if no AND remains at this level... but regex
    // cannot know "at this level". Collapse one OR.
    if (s === prev) {
      s = s.replace(/\b([TF])\s+OR\s+([TF])\b/, (_, a, b) =>
        a === "T" || b === "T" ? "T" : "F"
      );
    }
    // strip parens around a single value
    if (s === prev) {
      s = s.replace(/\(\s*([TF])\s*\)/, "$1");
    }
    if (guard > 1000) break;
  } while (s !== prev);
  s = s.trim();
  if (s === "T") return true;
  if (s === "F") return false;
  return { error: "could not collapse", remaining: s };
}

// ---- Sample record ----
const record = {
  status: "open",
  assignee: "alice",
  priority: "high",
  __me: "alice",
};

// ---- Representative queries with expected results ----
// For record: status=open, assignee=alice(=me), priority=high
const cases = [
  // flat
  ["status:open", true],
  ["status:closed", false],
  ["status:open AND priority:high", true],
  ["status:open AND priority:low", false],
  ["status:closed OR priority:high", true],
  ["status:closed OR priority:low", false],
  // precedence: AND tighter than OR. status:closed OR (assignee:me AND priority:high)
  // = false OR (true AND true) = true
  ["status:closed OR assignee:me AND priority:high", true],
  // = (false AND ...) OR true style: priority:low AND status:closed OR assignee:me
  // with AND-tighter: (low AND closed) OR me = (F AND F) OR T = T
  ["priority:low AND status:closed OR assignee:me", true],
  // nested / parenthesized
  ["status:open AND (assignee:me OR priority:high)", true],
  ["status:closed AND (assignee:me OR priority:high)", false],
  ["status:open AND (assignee:bob OR priority:low)", false],
  ["(status:closed OR assignee:me) AND priority:high", true],
  ["(status:closed OR assignee:bob) AND priority:high", false],
];

function run(label, fn) {
  console.log("\n=== " + label + " ===");
  let pass = 0;
  for (const [q, expected] of cases) {
    let got;
    try {
      got = fn(q, record);
    } catch (e) {
      got = "THREW: " + e.message;
    }
    const ok = got === expected;
    if (ok) pass++;
    console.log(
      (ok ? "PASS" : "FAIL") +
        " | got=" + JSON.stringify(got) +
        " exp=" + expected +
        " | " + q
    );
  }
  console.log("--> " + pass + "/" + cases.length + " passed");
}

run("Approach A: regex tokenize + left-to-right (no grouping)", evalFlatLeftToRight);
run("Approach B: regex tokenize + iterative regex collapse", evalRegexCollapse);
