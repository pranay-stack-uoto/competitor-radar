import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { fetchKeywordData, keywordDataFor } = createRequire(import.meta.url)('../../lib/keywordData.js');

const answer = (data) => async () => ({ ok: true, json: async () => ({ data, credits: 100, credits_consumed: data.length }) });
const ENV = { KEYWORDS_EVERYWHERE_API_KEY: 'ke-secret' };

test('without a key nothing is requested', async () => {
  let called = false;
  assert.equal((await fetchKeywordData(['a b'], { env: {}, fetchFn: async () => { called = true; } })).size, 0);
  assert.equal(called, false);
});
test('keywords go in the body, the key in a header only, and the answer is parsed', async () => {
  let seen;
  const out = await fetchKeywordData(['Glass Glazing  Ahmedabad', 'glass glazing ahmedabad', 'hvac'], { env: ENV, country: 'in', fetchFn: async (url, init) => { seen = [url, init]; return { ok: true, json: async () => ({ data: [{ keyword: 'glass glazing ahmedabad', vol: 320, cpc: { currency: '$', value: '0.45' }, competition: 0.31, trend: [{ month: 'Oct', year: 2026, value: 300 }] }, { keyword: 'hvac', vol: null }] }) }; } });
  assert.equal(seen[0], 'https://api.keywordseverywhere.com/v1/get_keyword_data');
  assert.ok(!String(seen[0]).includes('ke-secret'));
  assert.equal(seen[1].headers.authorization, 'Bearer ke-secret');
  assert.deepEqual(seen[1].body.getAll('kw[]'), ['glass glazing ahmedabad', 'hvac']); // cleaned and de-duplicated
  assert.equal(seen[1].body.get('country'), 'in');
  assert.equal(out.get('glass glazing ahmedabad').volume, 320);
  assert.equal(out.get('glass glazing ahmedabad').cpc, 0.45);
  assert.equal(out.get('hvac').volume, null);
});
test('failures never throw', async () => {
  for (const f of [async () => { throw new Error('down'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw new Error('x'); } })]) {
    assert.equal((await fetchKeywordData(['a'], { env: ENV, fetchFn: f })).size, 0);
  }
});
test('keywordDataFor: fresh cache is free, stale and missing are charged then fetched, a refused charge fetches nothing', async () => {
  const rows = [{ keyword: 'fresh', volume: 10, cpc: '1', competition: '0.1', trend: null, fetched_at: new Date().toISOString() }, { keyword: 'old', volume: 5, cpc: null, competition: null, trend: null, fetched_at: new Date(Date.now() - 20 * 86400000).toISOString() }];
  let upserted; const charged = []; let asked;
  const db = { from: () => ({ select: () => ({ eq: () => ({ in: async () => ({ data: rows }) }) }), upsert: async (r) => { upserted = r; return {}; } }) };
  const fetchFn = async (url, init) => { asked = init.body.getAll('kw[]'); return { ok: true, json: async () => ({ data: [{ keyword: 'old', vol: 50 }, { keyword: 'new', vol: 70 }] }) }; };
  const out = await keywordDataFor(db, ['fresh', 'old', 'new'], { env: ENV, fetchFn, charge: async (n) => { charged.push(n); } });
  assert.deepEqual(asked, ['old', 'new']); assert.deepEqual(charged, [2]);
  assert.equal(out.fresh.volume, 10); assert.equal(out.old.volume, 50); assert.equal(out.new.volume, 70);
  assert.equal(upserted.length, 2);
  asked = undefined;
  const refused = await keywordDataFor(db, ['fresh', 'old', 'new'], { env: ENV, fetchFn, charge: async () => { throw new Error('budget'); } });
  assert.equal(asked, undefined); assert.equal(refused.old.volume, 5); // stale value still shown
});
