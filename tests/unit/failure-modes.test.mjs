// What happens when an outside service or the database fails: retry or give up, never damage earlier results, never mark work done that was not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyError } = (() => { const q = require('../../lib/queue.js'); return { classifyError: q.classifyError }; })();
const discoverMod = require('../../lib/discover.js');
const { collectVitals } = require('../../lib/vitals.js');

test('errors are classified: network, timeouts, 429, 5xx and database outages are retried; client errors and budget refusals are not', () => {
  for (const e of [{ code: 'ECONNRESET', message: 'x' }, new Error('fetch failed'), { status: 429 }, { status: 503 }, { status: 408 }, { code: '57P01', message: 'terminating connection due to administrator command' }, { code: '08006', message: 'connection failure' }, new Error('something odd')]) {
    assert.equal(classifyError(e).permanent, false, JSON.stringify(e));
  }
  for (const e of [{ status: 404 }, { status: 403 }, { code: '23505', message: 'duplicate' }, { permanent: true, code: 'budget-exceeded', message: 'limit' }]) assert.equal(classifyError(e).permanent, true, JSON.stringify(e));
  assert.equal(classifyError({ retryable: true, code: 'serp-failed', message: 'x' }).permanent, false);
});

const project = { domain: 'me.example.com', keywords: ['a', 'b', 'c', 'd', 'e'], locations: ['x', 'y'], country: 'in' };
const withFetch = async (impl, fn) => { const real = globalThis.fetch; process.env.SERPER_API_KEY = 'k'; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = real; } };
const ok = (domain) => async () => ({ ok: true, json: async () => ({ organic: [{ link: `https://${domain}/`, title: 'T' }] }) });

test('Google search: every query failing fails the discovery (retryable) instead of returning an empty result that would be marked as searched', async () => {
  await withFetch(async () => { throw new Error('Serper down'); }, async () => {
    await assert.rejects(discoverMod.discover(project), (e) => e.code === 'serp-failed' && e.retryable === true);
  });
  await withFetch(async () => ({ ok: false, status: 500 }), async () => { await assert.rejects(discoverMod.discover(project), (e) => e.code === 'serp-failed'); });
});
test('Google search: more than one query in five failing is a failure; up to one in five is tolerated and the rest is used', async () => {
  let n = 0;
  const flaky = (failEvery) => async () => { n++; if (n % failEvery === 0) throw new Error('timeout'); return ok('rival.example.com')(); };
  n = 0;
  await withFetch(flaky(3), async () => { await assert.rejects(discoverMod.discover(project), (e) => e.code === 'serp-failed'); }); // 3 of 10 failing
  n = 0;
  await withFetch(flaky(10), async () => { const r = await discoverMod.discover(project); assert.equal(r.searches.total, 10); assert.equal(r.searches.failed, 1); assert.ok(r.serpRows.length >= 9); }); // 10% failing
});
test('Claude failing while judging competitors returns null (newcomers are then not stored) and never throws into the job', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const r = await discoverMod.filterCompetitors(project, [{ domain: 'x.example.com', serp_score: 5 }], {}, null, {});
  assert.equal(r, null);
});
test('PageSpeed failing never fails a crawl: no result, no throw', async () => {
  for (const getFn of [async () => { throw new Error('boom'); }, async () => ({ ok: false }), async () => ({ ok: true, body: 'not json' })]) assert.equal(await collectVitals({ domain: 'example.com', key: 'k', getFn }), null);
});
test('Search Console token expiry marks the connection expired and is never allowed to break the daily report', () => {
  const gsc = readFileSync(new URL('../../lib/gsc.js', import.meta.url), 'utf8');
  assert.match(gsc, /const expired = e\.code === 'invalid_grant';[\s\S]*status: expired \? 'expired' : 'ok'/);
  assert.match(gsc, /if \(!conn \|\| !conn\.site_url \|\| conn\.status === 'expired'\) return \{ skipped: true \}/, 'an expired connection is not retried every day');
  const pipeline = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
  assert.match(pipeline, /await syncGsc\(db, p\.id\)\.catch\(\(\) => \{\}\)/, 'a Search Console failure cannot block the report');
});
test('when Google cannot be searched the discovery falls back to the last positions, does not mark the weekly search done, and fails only if there are no earlier positions', () => {
  const p = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
  const body = p.slice(p.indexOf('async function runDiscovery'), p.indexOf('lease.assertHeld();', p.indexOf('async function runDiscovery')));
  assert.match(body, /await searchAndStore\(db, job, lease, project\); await lease\.write\('job_mark_search', \{\}\)/);
  assert.match(body, /e\.code !== 'serp-failed'\) throw e/);
  assert.match(body, /if \(!prior \|\| !prior\.rows\.length\) throw e/);
  assert.ok(body.indexOf("job_mark_search") < body.indexOf('latestPositions'), 'marking happens only on the success path, before the catch');
});
