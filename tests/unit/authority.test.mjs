import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { fetchAuthority, authorityFor } = createRequire(import.meta.url)('../../lib/authority.js');

const ok = (rows) => async () => ({ ok: true, json: async () => ({ response: rows }) });

test('without a key nothing is requested and nothing is returned', async () => {
  let called = false;
  const out = await fetchAuthority(['example.com'], { env: {}, fetchFn: async () => { called = true; } });
  assert.equal(out.size, 0); assert.equal(called, false);
});
test('only valid domain names go into the request, the key goes in a header, and results are parsed', async () => {
  let seen;
  const out = await fetchAuthority(['Example.com', 'bad domain', 'a/b.com', '10.0.0.1'], { env: { OPENPAGERANK_API_KEY: 'secret-key' }, fetchFn: async (url, init) => { seen = [url, init]; return { ok: true, json: async () => ({ response: [{ status_code: 200, domain: 'example.com', page_rank_decimal: 4.236, rank: '987' }, { status_code: 404, domain: 'x.com' }] }) }; } });
  assert.equal(seen[0], 'https://openpagerank.com/api/v1.0/getPageRank?domains[]=example.com');
  assert.equal(seen[1].headers['API-OPR'], 'secret-key'); assert.ok(!seen[0].includes('secret-key'));
  assert.equal(seen[1].redirect, 'manual');
  assert.deepEqual([...out], [['example.com', { pageRank: 4.24, globalRank: 987 }]]);
});
test('a failing or malformed answer never throws', async () => {
  for (const f of [async () => { throw new Error('down'); }, async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })]) {
    assert.equal((await fetchAuthority(['example.com'], { env: { OPENPAGERANK_API_KEY: 'k' }, fetchFn: f })).size, 0);
  }
});
test('authorityFor uses fresh cache rows and fetches only what is missing or older than a week', async () => {
  const rows = [{ domain: 'fresh.com', page_rank: '5.5', global_rank: 10, fetched_at: new Date().toISOString() }, { domain: 'old.com', page_rank: '1', global_rank: 9, fetched_at: new Date(Date.now() - 9 * 86400000).toISOString() }];
  let upserted, asked;
  const db = { from: () => ({ select: () => ({ in: async () => ({ data: rows }) }), upsert: async (r) => { upserted = r; return {}; } }) };
  const out = await authorityFor(db, ['fresh.com', 'old.com', 'new.com'], { env: { OPENPAGERANK_API_KEY: 'k' }, fetchFn: async (url) => { asked = url; return { ok: true, json: async () => ({ response: [{ status_code: 200, domain: 'old.com', page_rank_decimal: 2, rank: 5 }, { status_code: 200, domain: 'new.com', page_rank_decimal: 3, rank: 6 }] }) }; } });
  assert.ok(!asked.includes('fresh.com')); assert.equal(out['fresh.com'].pageRank, 5.5);
  assert.equal(out['old.com'].pageRank, 2); assert.equal(out['new.com'].pageRank, 3);
  assert.equal(upserted.length, 2);
});
