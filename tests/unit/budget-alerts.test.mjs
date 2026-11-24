import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chargeBudget, BudgetError } = require('../../lib/budget.js');
const { runMonitors } = require('../../lib/alerts.js');
const { recordAudit } = require('../../lib/auditTrail.js');
const { classifyError } = require('../../lib/queue.js');
const { ipKey, IP_LIMIT, checkLimit } = require('../../lib/security/ratelimit.js');

const rpcDb = (answer) => ({ calls: [], async rpc(fn, args) { this.calls.push([fn, args]); return typeof answer === 'function' ? answer(fn, args) : answer; } });
const quiet = () => {};

// ---------------- budget ----------------
test('an allowed charge returns the state and sends the organisation, metric and a whole amount', async () => {
  const db = rpcDb({ data: { allowed: true, used: 3, limit: 10 }, error: null });
  assert.equal((await chargeBudget(db, 'org-1', 'ai', 2.2)).used, 3);
  assert.deepEqual(db.calls[0], ['usage_charge', { p_org: 'org-1', p_metric: 'ai', p_amount: 3 }]);
});
test('a refused charge throws a permanent BudgetError that a queued job will not retry and a route turns into 429', async () => {
  const db = rpcDb({ data: { allowed: false, used: 10, limit: 10 }, error: null });
  const err = await chargeBudget(db, 'org-1', 'search').catch((e) => e);
  assert.ok(err instanceof BudgetError); assert.equal(err.code, 'budget-exceeded'); assert.match(err.message, /daily search limit/);
  assert.equal(classifyError(err).permanent, true);
});
test('amounts are clamped to what the database accepts', async () => {
  const db = rpcDb({ data: { allowed: true }, error: null });
  await chargeBudget(db, 'o', 'search', 99999); await chargeBudget(db, 'o', 'search', 0);
  assert.deepEqual(db.calls.map((c) => c[1].p_amount), [1000, 1]);
});
test('no organisation (a project from before organisations) and a missing migration both skip charging; other errors fail closed and retry', async () => {
  assert.equal((await chargeBudget(rpcDb({}), null, 'ai')).skipped, true);
  assert.equal((await chargeBudget(rpcDb({ data: null, error: { code: 'PGRST202' } }), 'o', 'ai')).skipped, true);
  const err = await chargeBudget(rpcDb({ data: null, error: { code: '57014', message: 'timeout' } }), 'o', 'ai', 1, quiet).catch((e) => e);
  assert.equal(err.code, 'budget-unavailable'); assert.equal(classifyError(err).permanent, false);
  const thrown = await chargeBudget({ rpc: async () => { throw new Error('network'); } }, 'o', 'ai', 1, quiet).catch((e) => e);
  assert.equal(thrown.code, 'budget-unavailable');
});

// ---------------- per-IP limit ----------------
test('the client address is taken from the platform headers, hashed, and absent when unusable', () => {
  const h = (o) => new Headers(o);
  const a = ipKey(h({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }));
  assert.match(a, /^ip:[0-9a-f]{24}$/); assert.doesNotMatch(a, /203/);
  assert.equal(ipKey(h({ 'x-real-ip': '203.0.113.9' })), a, 'same address, same key');
  assert.notEqual(ipKey(h({ 'x-real-ip': '203.0.113.10' })), a);
  assert.equal(ipKey(h({})), null); assert.equal(ipKey(h({ 'x-forwarded-for': 'not an ip!' })), null);
  assert.equal(ipKey(h({ 'x-real-ip': '2001:db8::1' })) !== null, true);
});
test('the per-IP limit uses the shared fail-closed limiter', async () => {
  assert.deepEqual([IP_LIMIT.max, IP_LIMIT.windowSec], [300, 600]);
  let n = 0;
  const rpc = async () => ({ data: ++n <= 2, error: null });
  await checkLimit({ rpc, key: 'ip:x', ...IP_LIMIT, max: 2 }); await checkLimit({ rpc, key: 'ip:x', ...IP_LIMIT, max: 2 });
  await assert.rejects(checkLimit({ rpc, key: 'ip:x', ...IP_LIMIT, max: 2 }), (e) => e.status === 429);
});

// ---------------- audit helper ----------------
test('recording an audit event never throws, even when the database fails', async () => {
  const logs = [];
  await recordAudit({ rpc: async () => { throw new Error('down'); } }, { action: 'x' }, (...a) => logs.push(a.join(' ')));
  await recordAudit({ rpc: async () => ({ error: { code: '500' } }) }, { action: 'x' }, (...a) => logs.push(a.join(' ')));
  await recordAudit({ rpc: async () => ({ error: { code: 'PGRST202' } }) }, { action: 'x' }, (...a) => logs.push(a.join(' ')));
  assert.equal(logs.length, 2);
  const db = rpcDb({ error: null });
  await recordAudit(db, { org: 'o', actor: 'u', action: 'competitor.added', targetType: 'project', targetId: 7, detail: { domain: 'a.com' } });
  assert.deepEqual(db.calls[0][1], { p_org: 'o', p_actor: 'u', p_action: 'competitor.added', p_target_type: 'project', p_target_id: '7', p_detail: { domain: 'a.com' } });
});

// ---------------- monitor ----------------
const monitorDb = ({ pending = [], head = [{ id: 5, hash: 'abc' }], raised = 2, updates = [] } = {}) => ({
  async rpc(fn) { if (fn === 'monitor_run') return { data: raised, error: null }; if (fn === 'audit_head') return { data: head, error: null }; return { data: null, error: null }; },
  from() { const q = { select: () => q, is: () => q, order: () => q, limit: async () => ({ data: pending }), update: (v) => { updates.push(v); return { in: async (c, ids) => { updates.push(ids); } }; } }; return q; },
});
test('without a webhook the alerts are logged (critical ones loudly) and nothing is marked as sent', async () => {
  const logs = [];
  const out = await runMonitors(monitorDb({ pending: [{ id: 1, kind: 'owner_changed', severity: 'critical', subject: 'u', detail: {} }] }), { env: {}, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(out.raised, 2); assert.equal(out.webhook, false); assert.equal(out.sent, 0);
  assert.ok(logs.some((l) => /ALERT .*owner_changed/.test(l)));
});
test('with a webhook the alerts and the audit head hash are posted, then the alerts are marked as notified', async () => {
  const updates = [], posts = [];
  const fetchFn = async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { ok: true, status: 200 }; };
  const out = await runMonitors(monitorDb({ pending: [{ id: 9, kind: 'budget_exhausted', severity: 'warning', organisation_id: 'a'.repeat(36), subject: 'ai', detail: { limit: 10 } }], updates }),
    { env: { ALERT_WEBHOOK_URL: 'https://hooks.example.com/abc' }, fetchFn, log: quiet });
  assert.equal(out.webhook, true); assert.equal(out.sent, 1);
  assert.equal(posts.length, 1); assert.equal(posts[0][0], 'https://hooks.example.com/abc');
  assert.match(posts[0][1].text, /budget_exhausted/); assert.match(posts[0][1].text, /audit head #5 abc/);
  assert.deepEqual(updates[1], [9]);
});
test('a failing webhook leaves alerts unsent for the next run; unsafe webhook addresses are never called', async () => {
  const updates = [];
  const db = monitorDb({ pending: [{ id: 3, kind: 'k', severity: 'info', detail: {} }], updates });
  const out = await runMonitors(db, { env: { ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' }, fetchFn: async () => ({ ok: false, status: 500 }), log: quiet });
  assert.equal(out.webhook, false); assert.equal(updates.length, 0);
  for (const bad of ['http://hooks.example.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'ftp://x.example.com', 'nonsense']) {
    let called = false;
    await runMonitors(monitorDb(), { env: { ALERT_WEBHOOK_URL: bad }, fetchFn: async () => { called = true; return { ok: true }; }, log: quiet });
    assert.equal(called, false, bad);
  }
});
test('a database without migration 0014 is skipped quietly', async () => {
  const out = await runMonitors({ rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }, { env: {}, log: quiet });
  assert.match(out.skipped, /0014/);
});
