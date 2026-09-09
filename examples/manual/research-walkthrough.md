# Worked example: research workflow

This is an end-to-end run of [research-workflow](../../workflows/research-workflow.md) on one real question, so you can see what to expect before pointing it at your own. The workflow's job is to produce evidence-backed findings: a `researcher` gathers and cites, an independent `cross-checker` verifies the citations and coverage from a fresh context, and only then does the orchestrator synthesize a final answer.

The question for this run is a classic, portable one: when should an API use cursor-based versus offset-based pagination, and what are the tradeoffs?

## How to read this

This run is a hybrid. Two steps were executed for real against the live web, and their output is reproduced here. The final synthesis is the orchestrator's consolidation step. Each section is tagged:

- **[REAL]**: genuine subagent output, captured from an actual run (findings reproduced verbatim; the long "sources consulted" list is condensed for length where noted).
- **[ILLUSTRATIVE]**: the orchestrator's synthesis, built only from the verified findings (it adds no new claims).

Same caveat as the other examples, echoed from the README: this spends more tokens than just asking a model the question. What you get back is different in kind: every load-bearing claim has a URL that a second agent actually opened and confirmed, and the things that could not be confirmed are labeled as such instead of being stated confidently.

A note on roles: the **operator** is you, the human. The **orchestrator** is the agent that drives the workflow and dispatches the `researcher` and `cross-checker`.

## The research question

The orchestrator dispatches the researcher with a specific question and an explicit scope, including which kinds of sources count as authoritative:

> For a REST or HTTP API list endpoint, when should a team use cursor-based (keyset) pagination versus offset-based (LIMIT/OFFSET) pagination, and what are the concrete tradeoffs (correctness under concurrent inserts/deletes, performance at deep pages, total-count and random-page access, implementation and UX complexity)?

Scope given: prefer first-party or canonical references (official API docs that take a position, the Relay cursor connections spec, database references on keyset pagination); engineering blogs may corroborate but cannot be the sole basis for a `verified` claim; do not write code; deliverable is a findings list with evidence tags plus a comparison and guidance.

---

# Step 1: Researcher **[REAL]**

The `researcher` is read-only. It searched the web, opened sources, and tagged every claim with an evidence level (`verified`, `corroborated`, `inferred`, `unverified`). Crucially, for anything tagged `verified` it had to actually open the page and confirm the wording. Here is the real report (findings verbatim; sources-consulted list condensed):

```text
Research Findings:
- Sources consulted (condensed): use-the-index-luke.com (/no-offset and /sql/partial-results/
  fetch-next-page); Relay Cursor Connections spec; Stripe API pagination reference; Slack web-api
  pagination docs + Slack engineering "Evolving API Pagination" blog; Google AIP-158; Atlassian
  developer-community deprecation announcement; Citus Data "Five ways to paginate in Postgres";
  GitHub REST pagination + best-practices docs.

- Findings:
  - OFFSET forces the database to read and discard all rows up to the offset before returning the
    page, so cost grows with page depth. [verified]
    Source: https://use-the-index-luke.com/sql/partial-results/fetch-next-page
  - Large offsets are expensive even with an index; a measured Postgres example went from 0.059 ms
    at LIMIT 100 to 758.484 ms at OFFSET 5,000,000, while a keyset filter (n > 5000000) stayed
    fast. [verified] Source: https://www.citusdata.com/blog/2016/03/30/five-ways-to-paginate/
  - OFFSET is not stable under concurrent writes: inserts between page fetches cause duplicates,
    deletes cause skips, because numbering is recomputed from scratch each query. [verified]
    Source: https://use-the-index-luke.com/no-offset and .../sql/partial-results/fetch-next-page
  - Concrete failure: moving from page n to n+1 while an element is inserted into page n causes both
    a duplication and an omission. [verified]
    Source: https://www.citusdata.com/blog/2016/03/30/five-ways-to-paginate/
  - Keyset/seek pagination uses the last row's values in a WHERE clause (for example
    WHERE (sale_date, sale_id) < (?, ?)) so the DB uses index access to skip prior rows directly.
    [verified] Source: https://use-the-index-luke.com/sql/partial-results/fetch-next-page
  - Keyset pagination is unaffected by inserts/deletes before the current page and stays fast at
    deep pages. [verified] Source: https://www.citusdata.com/blog/2016/03/30/five-ways-to-paginate/
  - Keyset/cursor pagination cannot navigate directly to an arbitrary page. [verified]
    Source: https://use-the-index-luke.com/no-offset and the Citus article
  - Keyset correctness requires a deterministic (unique) sort order; ties must be broken by
    appending a unique column. [verified]
    Source: https://use-the-index-luke.com/sql/partial-results/fetch-next-page
  - Cursor pagination as deployed provides no total page/result count and no random page jump; an
    explicit accepted tradeoff. [verified]
    Source: https://slack.engineering/evolving-api-pagination-at-slack/
  - Slack moved off offset because LIMIT/OFFSET does not scale for large datasets and high-frequency
    writes make the window unreliable. [verified] Source: same Slack engineering post
  - Stripe list APIs are cursor-only (starting_after/ending_before, mutually exclusive), expose
    has_more instead of a total, default limit 10 max 100, no offset/random page. [verified]
    Source: https://docs.stripe.com/api/pagination
  - The Relay Cursor Connections spec models forward (first/after) and backward (last/before)
    paging, treats cursors as opaque, exposes PageInfo (hasNextPage, hasPreviousPage, startCursor,
    endCursor), and does NOT specify insert/delete stability. [verified]
    Source: https://relay.dev/graphql/connections.htm
  - Google AIP-158 requires page tokens to be opaque and not user-parseable; base64-encoding a
    transparent token is explicitly insufficient. [verified] Source: https://google.aip.dev/158
  - Google AIP-158 makes total count optional (response "may" provide int32 total_size).
    [verified] Source: https://google.aip.dev/158
  - Atlassian deprecated offset (startAt) on search APIs because high start values get very slow and
    worse as data grows; developers lose random page access and parallel pagination. [verified]
    Source: https://community.developer.atlassian.com/t/upcoming-changes-to-modernize-search-rest-apis/37746
  - GitHub REST supports both cursor (before/after) and page-based pagination per endpoint; clients
    should follow Link header URLs. [verified]
    Source: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
  - GitHub docs reportedly state cursor pagination "can help assure data consistency and improve
    response times." [unverified] This wording appeared in search-engine summaries but could not be
    located on the live pages, so it is not relied upon.
  - Offset is reasonable for small or static datasets, admin dashboards, and search UIs where users
    rarely go deep and numbered-page navigation or page deep-linking is required. [corroborated]
    Source: two engineering blogs (Gusto, Design Gurus); not first-party, treat as guidance.
  - Implementation/UX synthesis comparing the two approaches. [inferred] Basis: the verified
    findings above.

- Contradictions: offset acceptability is a scope/emphasis difference (small/static fine,
  large/changing unsuitable), not a factual conflict. Total-count handling is a design choice
  (AIP-158 allows optional total_size; Stripe/Slack/Relay omit totals). The GitHub consistency
  claim is flagged unverified rather than picked.
- Coverage map: PostgreSQL official wiki keyset page returned 404 at the guessed URL, so Citus was
  substituted. Did not consult Microsoft/Zalando API guidelines, Shopify, AWS, or Twitter/X docs;
  these would corroborate rather than overturn.
- Open questions: exact wording/presence of the GitHub statement; canonical PostgreSQL wiki keyset
  URL; how vendors handle a deleted cursor-anchor row.
- Summary: offset is simple and gives random-page and total-count UIs but degrades on deep pages and
  is incorrect under concurrent writes; cursor/keyset anchors on the last row via an indexed WHERE,
  giving near-constant deep-page performance and write-stable results at the cost of no arbitrary
  page jumps, no free total, mandatory deterministic ordering, and opaque-token handling. Major
  vendors back cursor for scale (Stripe cursor-only, Slack, Atlassian, Google AIP-158, Relay).
```

What to notice: the report does not just assert "cursor is better." Every load-bearing claim carries an evidence tag and a real URL. The one claim it could not confirm on a live page (the GitHub consistency wording) is tagged `unverified` and explicitly not relied upon, rather than being quietly upgraded to fact. The contradiction section distinguishes genuine factual conflicts (none here) from design-choice differences. And the coverage map admits what it did not reach (a 404 on the PostgreSQL wiki, several un-consulted API guidelines). That honesty is what the next gate checks.

# Step 2: Cross-check **[REAL]**

The `cross-checker` runs from a fresh context. It is given the findings and citations, not the researcher's reasoning, and its job is to distrust the report and verify independently by opening the cited sources itself. Its real verdict:

```text
Cross-Check Report:
- Verdict: pass
- Claims verified (spot-checked):
  - Citus measured timings (LIMIT 100 = 0.059 ms, OFFSET 5,000,000 = 758.484 ms, keyset stays
    fast). confirmed. Opened the Citus article; both timings present exactly as quoted, keyset
    returns in 0.119 ms. The insert duplication+omission scenario and no-arbitrary-page-jump are
    also stated verbatim there.
  - OFFSET reads/discards all prior rows, cost grows with depth. confirmed. Opened the
    use-the-index-luke fetch-next-page page; states the DB must count all rows from the beginning
    and response time increases browsing further back.
  - Keyset uses last-row values in WHERE; requires deterministic/unique sort. confirmed. Same page
    shows the (sale_date, sale_id) < (?, ?) pattern and the unique-ordering requirement.
  - Stripe cursor-only model (starting_after/ending_before, has_more, default 10 max 100, no
    offset). confirmed. Opened the Stripe pagination reference; all specifics match.
  - AIP-158 opaque/non-parseable tokens + base64 insufficiency; total_size optional. confirmed.
    Opened google.aip.dev/158; both present.
  - Slack: offset does not scale, window unreliable under writes, no total/page-jump. confirmed.
    Opened the Slack engineering post.
  - Atlassian startAt deprecation rationale + loss of page-jump/parallel paging. confirmed. Opened
    the developer-community announcement.
  - GitHub "data consistency and improve response times" sentence. confirmed as NOT present,
    matching the researcher's own unverified flag. Opened the live GitHub pages; covers before/
    after, page, since, and Link-header following, but no such sentence.
- Missing sources: none identified that would change conclusions. Coverage map is honest about the
  PostgreSQL wiki 404 and the un-consulted guidelines, which would reinforce not overturn.
- Unsupported conclusions: none material. Finding on offset-for-small/static rests only on
  engineering blogs, which is exactly how it was labeled (corroborated, not verified).
- Contradictions missed: none.
- Coverage gaps: one minor attribution nuance: the "limit 100 to 200 (max 1000)" numbers belong to
  the Slack docs page, not the engineering blog; the finding cites both, so this is a labeling
  tidiness item, not a substantive gap.
- Recommendations: none required for pass. (Optional: attribute the Slack limit numbers to the docs
  page specifically.)
```

The cross-checker opened the sources itself and confirmed the decision-relevant claims, including reading the exact millisecond timings off the Citus page rather than trusting the quote. It agreed the GitHub claim was correctly withheld, and it raised one minor, non-blocking attribution nuance. Verdict: `pass`.

If it had returned `fail-with-gaps`, the workflow would re-dispatch the researcher on the named gaps only, then re-run the cross-check, up to the loop cap of two rounds. Remaining gaps after that would ship in the final report as explicitly labeled `unverified` items rather than being hidden.

# Step 3: Synthesis **[ILLUSTRATIVE]**

On `pass`, the orchestrator consolidates the verified findings into the deliverable. It trims and organizes; it does not add new claims. Here is the synthesized answer.

| Dimension | Offset (LIMIT/OFFSET) | Cursor/keyset |
|---|---|---|
| Deep-page performance | Degrades; the DB scans and discards all skipped rows (0.059 ms to 758 ms in the Citus measurement) | Near-constant; an indexed WHERE on the last row's values seeks directly |
| Correctness under concurrent writes | Unstable; inserts cause duplicates, deletes cause skips as the window shifts | Stable; unaffected by inserts/deletes before the current page |
| Random page jump | Yes, jump to any page N directly | No; cannot reach page N without prior boundary values |
| Total count / numbered pages | Easy and natural | Not provided by default; total is a separate, best-effort feature |
| Ordering requirement | Any sort works | Must be deterministic and unique (break ties with a unique column) |
| Implementation / UX complexity | Simplest; trivial UI | More complex; opaque tokens, backward paging, no page numbers |

Guidance on when to pick each, drawn only from the verified and corroborated findings:

- Prefer **cursor/keyset** for large, frequently-changing, or high-traffic list endpoints, for infinite scroll, and for next/previous navigation. This is the direction major vendors took for scale: Stripe is cursor-only, Slack moved off offset under write load, Atlassian deprecated `startAt` on search, Google AIP-158 mandates opaque page tokens, and the Relay spec standardizes opaque cursors with `PageInfo` instead of totals.
- Use **offset** only for small or static datasets and UIs that genuinely need numbered pages or deep-linking to a specific page (corroborated at engineering-blog level, not first-party, and consistent with the verified tradeoffs).
- If you need both cursor stability and a total count or page jumps, expose those as separate, explicitly best-effort features rather than as guarantees, since no source treats a total count as free or correct under concurrent writes.

One item is carried forward labeled, not buried: the claim that GitHub's docs frame cursor pagination as improving data consistency and response times is **unverified** (the wording could not be found on the live pages), so it is not part of the recommendation.

---

# What to expect when you run this

- **Every claim is tagged and sourced.** The output is not prose with a confident tone; it is findings with `verified` / `corroborated` / `inferred` / `unverified` levels, each carrying a real URL.
- **A second agent actually re-opens the sources.** The cross-checker read the millisecond timings off the cited page itself. Independent verification from a fresh context is the structural gate, not the researcher's own confidence.
- **Honesty about limits is required, not optional.** The unconfirmable GitHub claim was flagged and excluded; the coverage map admitted a 404 and un-consulted sources. Findings that cannot be verified ship as `unverified`, not as facts.
- **Contradictions are surfaced, not resolved silently.** The report separated genuine conflicts (none here) from design-choice differences.
- **It costs more tokens than a single prompt.** Two web-research subagents ran, opening and re-opening real pages. The return is a citation trail you can audit, not a fast guess.

To go deeper, read the contract itself: [research-workflow](../../workflows/research-workflow.md), plus the [researcher](../../workflows/subagents/researcher-prompt.md) and [cross-checker](../../workflows/subagents/cross-checker-prompt.md) prompt templates.
