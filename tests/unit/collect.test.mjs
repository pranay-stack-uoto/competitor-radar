import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import collect from '../../lib/scoring/collect.js';
import ai from '../../lib/ai.js';

const get = (body, ok = true) => async () => ({ ok, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('Places: disabled without a key or a place, validated otherwise', async () => {
  assert.deepEqual(await collect.collectPlaces({ query: 'x', key: '' }), { status: 'disabled' });
  assert.deepEqual(await collect.collectPlaces({ query: '', key: 'k' }), { status: 'disabled' });
  assert.deepEqual(await collect.collectPlaces({ query: 'x', key: 'k', getFn: get({ results: [{ rating: 4.5, user_ratings_total: 120 }] }) }), { status: 'ok', rating: 4.5, reviews: 120 });
  assert.deepEqual(await collect.collectPlaces({ query: 'x', key: 'k', getFn: get({ results: [{ rating: 'high', user_ratings_total: null }] }) }), { status: 'ok', rating: 0, reviews: 0 });
  for (const bad of [{ results: [] }, { results: 'x' }, {}, 'not json', { results: [null] }]) assert.deepEqual(await collect.collectPlaces({ query: 'x', key: 'k', getFn: get(bad) }), { status: 'none' }, JSON.stringify(bad));
  assert.deepEqual(await collect.collectPlaces({ query: 'x', key: 'k', getFn: get('', false) }), { status: 'none' });
});

test('AI probe: disabled unless configured, counts brand mentions, survives failed questions', async () => {
  const env = { ANTHROPIC_API_KEY: 'k' };
  assert.deepEqual(await collect.collectAiProbe({ prompts: ['q'], brand: 'Acme', host: 'acme.com', env: {} }), { status: 'disabled' });
  assert.deepEqual(await collect.collectAiProbe({ prompts: [], brand: 'Acme', host: 'acme.com', env }), { status: 'disabled' });
  const answers = ['Try Acme Plumbing', 'Try someone else', 'See acme.com for details', 'nothing'];
  let i = 0;
  const r = await collect.collectAiProbe({ prompts: ['a', 'b', 'c', 'd', 'e', 'f'], brand: 'Acme', host: 'acme.com', env, ask: async () => { if (i === 4) { i++; throw new Error('429'); } return answers[i++] || 'x'; } });
  assert.ok(r.asked <= 5 && r.hits === 2);
  assert.deepEqual(await collect.collectAiProbe({ prompts: ['a'], brand: 'Acme', host: 'acme.com', env, ask: async () => { throw new Error('down'); } }), { status: 'none' });
});

test('PageSpeed: parsed defensively', async () => {
  assert.deepEqual(await collect.collectPagespeed({ url: 'https://x.com', getFn: get({ lighthouseResult: { categories: { performance: { score: 0.8 }, seo: { score: 0.9 } } } }) }), { perf: 0.8, seo: 0.9 });
  for (const bad of [{}, { lighthouseResult: {} }, 'garbage']) assert.equal(await collect.collectPagespeed({ url: 'https://x.com', getFn: get(bad) }), null, JSON.stringify(bad));
});

test('collectExternal gathers Places and the AI probe for one site', async () => {
  const r = await collect.collectExternal({ crawl: { origin: 'https://www.acme.com' }, locations: ['Pune'], aiPrompts: [], siteName: 'acme.com', env: { GOOGLE_PLACES_API_KEY: 'k' }, getFn: get({ results: [{ rating: 4, user_ratings_total: 10 }] }) });
  assert.deepEqual(r, { places: { status: 'ok', rating: 4, reviews: 10 }, aiProbe: { status: 'disabled' } });
});

// ---- lib/ai.js ----
let realKey;
beforeEach(() => { realKey = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'test-key'; });
afterEach(() => { if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey; });
const reply = (json, ok = true, status = 200) => async () => ({ ok, status, json: async () => json });

test('askClaude validates the response and joins text parts', async () => {
  assert.equal(await ai.askClaude({ prompt: 'p', fetchFn: reply({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { text: 'b' }] }) }), 'ab');
  for (const bad of [{}, { content: 'x' }, { content: [] }, { content: [{ text: 5 }] }, { content: [{ text: '   ' }] }]) await assert.rejects(ai.askClaude({ prompt: 'p', fetchFn: reply(bad) }), /empty answer/, JSON.stringify(bad));
  await assert.rejects(ai.askClaude({ prompt: 'p', fetchFn: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) }), /not JSON/);
});
test('askClaude reports HTTP failures with a status the queue can classify, and a missing key as permanent', async () => {
  const e = await ai.askClaude({ prompt: 'p', fetchFn: reply({}, false, 529) }).catch((x) => x);
  assert.equal(e.status, 529);
  delete process.env.ANTHROPIC_API_KEY;
  const k = await ai.askClaude({ prompt: 'p', fetchFn: reply({}) }).catch((x) => x);
  assert.equal(k.permanent, true);
});
test('extractJson accepts one object and nothing else', () => {
  assert.deepEqual(ai.extractJson('sure! {"a": 1} done'), { a: 1 });
  for (const bad of ['no json', '[1,2]', '{broken', '']) assert.throws(() => ai.extractJson(bad), undefined, bad);
});
test('identical prompts are answered from the cache, different ones are not', async () => {
  const store = new Map(); let calls = 0;
  const db = { rpc: async (fn, a) => (fn === 'get_ai_cache' ? { data: store.get(a.p_key) ?? null, error: null } : (store.set(a.p_key, a.p_value), { data: null, error: null })) };
  const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ content: [{ text: 'answer ' + calls }] }) }; };
  const opts = { db, cacheTtlSeconds: 60, fetchFn };
  assert.equal(await ai.askClaude({ prompt: 'same', ...opts }), 'answer 1');
  assert.equal(await ai.askClaude({ prompt: 'same', ...opts }), 'answer 1');
  assert.equal(calls, 1);
  assert.equal(await ai.askClaude({ prompt: 'different', ...opts }), 'answer 2');
  assert.equal(await ai.askClaude({ prompt: 'same', system: 's', ...opts }), 'answer 3'); // the system prompt is part of the key
  assert.equal(await ai.askClaude({ prompt: 'same', db, fetchFn }), 'answer 4'); // no ttl: never cached
});
test('a broken cache never blocks an AI call', async () => {
  const db = { rpc: async () => { throw new Error('db down'); } };
  assert.equal(await ai.askClaude({ prompt: 'p', db, cacheTtlSeconds: 60, fetchFn: reply({ content: [{ text: 'ok' }] }) }), 'ok');
});
