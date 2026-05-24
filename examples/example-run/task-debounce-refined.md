# Task: Add a debounce utility (refined, implementation-ready)

## Context

The project has a leading-edge `throttle` helper in `src/utils/throttle.js` with tests in
`src/utils/throttle.test.js`. We need a matching `debounce` helper so handlers stop firing on
every keystroke and instead run once the input settles.

## Decisions carried from refinement

- **Edge: trailing.** Fire once after calls stop, not on the first call. This matches the
  keystroke use case. (Throttle is leading-edge; debounce here is deliberately the opposite.)
- **Return value: undefined.** A trailing-edge debounce defers the call, so it cannot return
  `fn`'s result synchronously.
- **No `cancel()`/`flush()`.** Operator decision: keep it minimal, matching throttle. Can be
  added later if a consumer needs it.

## Acceptance criteria

1. `debounce(fn, wait)` is exported as a named ESM export from `src/utils/debounce.js`.
2. Calling the debounced function does not invoke `fn` synchronously.
3. After a burst of rapid calls, `fn` runs exactly once, `wait` ms after the last call.
4. Each call resets the timer (a pending invocation is rescheduled, not stacked).
5. `fn` receives the latest call's arguments and `this`.
6. `src/utils/debounce.test.js` covers the above with `node --test`, matching the style of
   `throttle.test.js`.

## Verification

- Command: `npm test` (runs `node --test`) from the `debounce-demo` directory.
- Expected: all debounce tests pass, and the existing throttle tests still pass.

## Implementation Constraints

- **Reference pattern**: mirror `src/utils/throttle.js` (ESM `export function`, a single closure,
  a short leading comment describing the chosen semantics) and `src/utils/throttle.test.js`
  (`node:test`, `node:assert/strict`, an inline `sleep` helper).
- **Negative scope**: no `cancel()`/`flush()`; no leading-edge option; no new dependencies; do
  not modify `throttle.js`, `package.json`, or any other file.
- **Deployment context reminder**: ESM project (`"type": "module"`), Node built-in test runner
  only, no bundler or transpile step.
- **Playbook-like instructions**: one closure over a single timer id. On each call,
  `clearTimeout` the previous timer, then `setTimeout` a call to `fn.apply(this, args)` after
  `wait` ms. That is the whole implementation.

## Sizing Budget

- **Concern axes count**: 1 (a timing utility plus its test).
- **Acceptance criteria count**: 6.
- **Estimated file touch count**: 2 (both new).
- **Independent failure classes**: 1 (timer scheduling).

## Execution Gates

- **Blocked by**: none.
- **Order constraints**: none (standalone).
- **Dispatchability**: `dispatchable`.
- **Follow-up tasks**: none.
