import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { progressOf, etaText } = createRequire(import.meta.url)('../../lib/progress.js');
const T = Date.parse('2026-11-25T04:00:00Z');
const crawl = (status, startOffset) => ({ kind: 'crawl', status, started_at: startOffset == null ? null : new Date(T - startOffset * 1000).toISOString() });

test('before anything exists: starting at 3%; while the search runs: 8%', () => {
  assert.deepEqual([progressOf([], T).phase, progressOf([], T).percent], ['starting', 3]);
  const p = progressOf([{ kind: 'discover', status: 'running' }], T);
  assert.deepEqual([p.phase, p.percent], ['searching', 8]);
});
test('crawling: 10% for the search, the rest by sites finished, never 100% until every job is finished', () => {
  const jobs = [{ kind: 'discover', status: 'done' }, crawl('done', 120), crawl('done', 100), crawl('running', 60), crawl('queued', null)];
  const p = progressOf(jobs, T);
  assert.deepEqual([p.phase, p.done, p.total, p.percent, p.complete], ['crawling', 2, 4, 55, false]);
  const all = progressOf([{ kind: 'discover', status: 'done' }, crawl('done', 60), crawl('failed', 30)], T);
  assert.deepEqual([all.percent, all.complete, all.etaSeconds], [100, true, 0]);
});
test('time left uses the pace of this refresh once a site has finished (120 s for 2 sites, 2 left = about 2 min), else an estimate', () => {
  const jobs = [{ kind: 'discover', status: 'done' }, crawl('done', 120), crawl('done', 110), crawl('running', 50), crawl('queued', null)];
  assert.equal(progressOf(jobs, T).etaSeconds, 120);
  const fresh = progressOf([{ kind: 'discover', status: 'done' }, crawl('queued', null), crawl('queued', null), crawl('queued', null), crawl('queued', null)], T);
  assert.equal(fresh.etaSeconds, 90); // 4 sites x 45 s / 2 workers
});
test('nothing to crawl after the search is done: finished at once', () => { assert.equal(progressOf([{ kind: 'discover', status: 'done' }], T).percent, 100); });
test('the time left is written in plain words', () => {
  assert.equal(etaText(20), 'under a minute left'); assert.equal(etaText(400), 'about 7 min left'); assert.equal(etaText(null), '');
});
