import { test } from 'node:test';
import assert from 'node:assert/strict';
import pool from '../../lib/pool.js';
const { mapLimit } = pool;

test('results keep the input order whatever order the work finishes in', async () => {
  const r = await mapLimit([30, 5, 20, 1, 10], 3, async (ms, i) => { await new Promise((x) => setTimeout(x, ms)); return i; });
  assert.deepEqual(r, [0, 1, 2, 3, 4]);
});
test('never more than `limit` run at once, and all of them run', async () => {
  let running = 0, peak = 0, done = 0;
  await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => { running++; peak = Math.max(peak, running); await new Promise((x) => setTimeout(x, 5)); running--; done++; });
  assert.equal(peak, 4); assert.equal(done, 20);
});
test('edge cases: empty list, limit larger than the list, limit of zero', async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit([1, 2], 10, async (x) => x * 2), [2, 4]);
  assert.deepEqual(await mapLimit([1, 2, 3], 0, async (x) => x), [1, 2, 3]);
});
test('an error in one item rejects the whole call (callers that want isolation catch inside the function)', async () => {
  await assert.rejects(mapLimit([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x; }), /boom/);
});
