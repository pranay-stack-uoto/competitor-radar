// Reliability of the daily run: the worker keeps itself alive, and a day with unfinished crawls still gets a clearly marked report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { shouldSpawnWorker, workload } = createRequire(import.meta.url)('../../lib/queue.js');

test('another worker is started only while work is claimable and fewer than two jobs are running', () => {
  assert.equal(shouldSpawnWorker({ claimable: 5, running: 0 }), true);
  assert.equal(shouldSpawnWorker({ claimable: 5, running: 1 }), true);
  assert.equal(shouldSpawnWorker({ claimable: 5, running: 2 }), false); // enough already running: no runaway chain
  assert.equal(shouldSpawnWorker({ claimable: 0, running: 0 }), false);  // nothing to do
  assert.equal(shouldSpawnWorker({ claimable: 3, running: 3 }, 4), true);
});
test('workload counts claimable and running jobs with two cheap count queries', async () => {
  const db = { from: () => { let status; const q = { select: () => q, eq: (c, v) => { if (c === 'status') status = v; return q; }, lte: () => q, gt: () => q, then: (r) => r({ count: status === 'queued' ? 3 : 7 }) }; return q; } };
  assert.deepEqual(await workload(db), { claimable: 3, running: 7 });
});
test('the work route starts a successor at the start and again at the end, and never loops after a failure', () => {
  const r = readFileSync(new URL('../../app/api/cron/work/route.js', import.meta.url), 'utf8');
  const first = r.indexOf('shouldSpawnWorker(await workload(db))'), loop = r.indexOf('while (Date.now() < deadline'), last = r.lastIndexOf('shouldSpawnWorker(await workload(db))');
  assert.ok(first > 0 && first < loop && last > loop, 'a spawn check before the loop and one after it');
  assert.match(r, /maxDuration - 180/, 'new jobs stop 180 s before the platform limit');
  assert.match(r, /more = false; \}[^\n]*never re-kick after a failure/);
});
test('the daily report cron starts a worker as a safety net and publishes partial reports', () => {
  const r = readFileSync(new URL('../../app/api/cron/report/route.js', import.meta.url), 'utf8');
  assert.match(r, /kickWorker\(\)\.done[\s\S]*finishProjects\(undefined, \{ partial: true \}\)/);
});
test('coverage says how much of the planned work a report is built on, and is partial only when something was still waiting', () => {
  const src = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
  const fn = new Function(src.slice(src.indexOf('export function coverageOf'), src.indexOf('export async function finishProjects')).replace('export function', 'function') + '\nreturn coverageOf;')();
  assert.deepEqual(fn(14, 6, true), { planned: 14, scored: 6, partial: true });
  assert.deepEqual(fn(14, 14, true), { planned: 14, scored: 14, partial: false }); // all scored even though a job is still marked running
  assert.deepEqual(fn(14, 14, false), { planned: 14, scored: 14, partial: false });
  assert.deepEqual(fn(0, 5, false), { planned: 5, scored: 5, partial: false });
});
