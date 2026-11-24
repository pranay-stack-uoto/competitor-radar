// Weekly Google search, daily re-crawl: which days search Google and which reuse the last positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
const mode = src.slice(src.indexOf('export const FULL_SEARCH_EVERY_DAYS'), src.indexOf('async function runDiscovery'));
// Run the decision code against a fake database, without loading the whole pipeline (it imports Next-style paths).
const { searchMode } = await (async () => {
  const code = mode.replace(/export (async function|const)/g, '$1') + '\nreturn { searchMode, FULL_SEARCH_EVERY_DAYS };';
  return new Function(code)();
})();

const fakeDb = (rows) => ({ from: () => {
  const q = { select: () => q, eq: () => q, lte: () => q, order: () => q, limit: () => Promise.resolve({ data: rows.length ? [{ day: rows[0].day }] : [] }), range: () => Promise.resolve({ data: rows }) };
  return q;
} });
const rows = (day, kws = ['a', 'b']) => kws.map((keyword) => ({ day, keyword, location: '', position: 3, domain: 'x.com', title: null, url: null }));
const project = (extra = {}) => ({ id: 'p', keywords: ['a', 'b'], serp_searched_on: null, ...extra });

test('no stored positions: search in full', async () => { assert.equal((await searchMode(fakeDb([]), project(), { day: '2026-11-10', domain: null })).full, true); });
test('positions from 2 days ago are reused, not searched again', async () => {
  const m = await searchMode(fakeDb(rows('2026-11-08')), project(), { day: '2026-11-10', domain: null });
  assert.equal(m.full, false); assert.equal(m.from, '2026-11-08'); assert.equal(m.rows.length, 2);
});
test('after 7 days since the last REAL search a full search runs, even if carried-forward rows exist for yesterday', async () => {
  const m = await searchMode(fakeDb(rows('2026-11-09')), project({ serp_searched_on: '2026-11-02' }), { day: '2026-11-10', domain: null });
  assert.equal(m.full, true);
  assert.equal((await searchMode(fakeDb(rows('2026-11-09')), project({ serp_searched_on: '2026-11-05' }), { day: '2026-11-10', domain: null })).full, false);
});
test('"Find new competitors" (domain full) always searches; new keywords force a search', async () => {
  assert.equal((await searchMode(fakeDb(rows('2026-11-10')), project(), { day: '2026-11-10', domain: 'full' })).full, true);
  assert.equal((await searchMode(fakeDb(rows('2026-11-09')), project({ keywords: ['a', 'b', 'new'] }), { day: '2026-11-10', domain: null })).full, true);
});
test('a full search records its day through the fenced job_mark_search', () => {
  assert.match(src, /await searchAndStore\(db, job, lease, project\); await lease\.write\('job_mark_search', \{\}\)/);
});
