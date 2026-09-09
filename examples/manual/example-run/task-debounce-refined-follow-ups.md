# Follow-ups: Add a debounce utility

Append-only. Minor, non-blocking findings recorded during review for later operator triage.

- 2026-05-24 | source: quality-reviewer | src/utils/debounce.test.js:5 | The `sleep` helper is
  duplicated from throttle.test.js:5. Not a defect; both files are self-contained today. Suggested
  fix: if a third timing test file appears, extract `sleep` into a shared `test/helpers.js`.
