import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debounce } from './debounce.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('debounce does not run synchronously', () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  assert.equal(calls, 0);
});

test('debounce runs once after the wait following the last call', async () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  assert.equal(calls, 0);
  await sleep(70);
  assert.equal(calls, 1);
});

test('debounce collapses a burst into a single trailing call', async () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  d();
  d();
  await sleep(70);
  assert.equal(calls, 1);
});

test('debounce resets the timer on each call rather than stacking', async () => {
  let calls = 0;
  const d = debounce(() => calls++, 50);
  d();
  await sleep(30);
  d();
  await sleep(30);
  // 60ms have elapsed since the first call, but only 30ms since the last,
  // so nothing should have fired yet.
  assert.equal(calls, 0);
  await sleep(40);
  assert.equal(calls, 1);
});

test('debounce forwards the latest arguments and this', async () => {
  const seen = [];
  const obj = {
    tag: 'ctx',
    handler: debounce(function (value) {
      seen.push({ tag: this.tag, value });
    }, 50),
  };
  obj.handler('first');
  obj.handler('second');
  await sleep(70);
  assert.deepEqual(seen, [{ tag: 'ctx', value: 'second' }]);
});

test('debounce returns undefined', () => {
  const d = debounce(() => 42, 50);
  assert.equal(d(), undefined);
});
