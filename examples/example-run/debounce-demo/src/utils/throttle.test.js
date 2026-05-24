import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttle } from './throttle.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('throttle runs immediately on the first call', () => {
  let calls = 0;
  const t = throttle(() => calls++, 50);
  t();
  assert.equal(calls, 1);
});

test('throttle drops calls inside the window', async () => {
  let calls = 0;
  const t = throttle(() => calls++, 50);
  t();
  t();
  t();
  assert.equal(calls, 1);
  await sleep(60);
  t();
  assert.equal(calls, 2);
});
