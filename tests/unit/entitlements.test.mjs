import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { chargeRun, requireRun, EntitlementError } = createRequire(import.meta.url)('../../lib/entitlements.js');
const quiet = () => {};
const db = (res) => ({ rpc: async (fn, args) => { assert.equal(fn, 'entitlement_charge_run'); return typeof res === 'function' ? res(args) : res; } });

test('an allowed run passes through; a project without an organisation is not limited', async () => {
  assert.equal((await chargeRun(db({ data: { allowed: true, used: 1 } }), 'org', quiet)).allowed, true);
  assert.equal((await chargeRun(db({}), null, quiet)).skipped, true);
});
test('a refused run throws a 402 EntitlementError with a plain message that says the data stays', async () => {
  const e = await requireRun(db({ data: { allowed: false, reason: 'trial-runs-used' } }), 'org').catch((x) => x);
  assert.ok(e instanceof EntitlementError); assert.equal(e.status, 402); assert.equal(e.code, 'plan-limit'); assert.match(e.message, /data and reports stay available/);
});
test('before migration 0021 is applied runs are allowed; any other failure fails closed', async () => {
  assert.equal((await chargeRun(db({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }), 'org', quiet)).allowed, true);
  await assert.rejects(chargeRun(db({ data: null, error: { code: 'XX000', message: 'boom' } }), 'org', quiet), /Plan check unavailable/);
});
test('the daily start and the Crawl now route both spend a run before queuing', () => {
  const p = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
  assert.match(p.slice(p.indexOf('export async function startDay')), /chargeRun\(db, p\.organisation_id\)[\s\S]*enqueue\(db, \{ projectId: p\.id, day, kind: 'discover' \}\)/);
  const r = readFileSync(new URL('../../app/api/project/start/route.js', import.meta.url), 'utf8');
  assert.ok(r.indexOf('requireRun(') > 0 && r.indexOf('requireRun(') < r.indexOf("kind: 'discover'"));
});
