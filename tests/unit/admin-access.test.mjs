// Operator-only access (ADMIN_EMAILS) and the worker's separate watchdog secret.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const http = readFileSync(new URL('../../lib/http.js', import.meta.url), 'utf8');
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const requireAdmin = new Function('HttpError', http.slice(http.indexOf('export function requireAdmin'), http.indexOf("// The caller must belong to the project's organisation")).replace('export function', 'function') + '\nreturn requireAdmin;')(HttpError);
const auth = (email) => ({ user: { id: 'u', email } });

test('only emails listed in ADMIN_EMAILS are operators, case-insensitively; everyone else gets a plain 404', () => {
  const env = { ADMIN_EMAILS: 'Owner@Example.com, second@example.com' };
  assert.doesNotThrow(() => requireAdmin(auth('owner@example.com'), env));
  assert.doesNotThrow(() => requireAdmin(auth('SECOND@example.com'), env));
  for (const e of ['customer@example.com', '', undefined]) assert.throws(() => requireAdmin(auth(e), env), (x) => x.status === 404);
  assert.throws(() => requireAdmin(auth('owner@example.com'), {}), (x) => x.status === 404, 'with ADMIN_EMAILS unset nobody is an operator');
  assert.throws(() => requireAdmin(null, env), (x) => x.status === 404);
});
test('the watchdog secret can start the worker only; the daily start and report routes accept CRON_SECRET alone', () => {
  const db = readFileSync(new URL('../../lib/db.js', import.meta.url), 'utf8');
  assert.match(db, /export const authorizedWorker[\s\S]*authorizedCron\(req\)[\s\S]*WATCHDOG_SECRET[\s\S]*safeEqual/);
  const used = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
  assert.match(used('app/api/cron/work/route.js'), /authorizedWorker\(req\)/);
  for (const f of ['app/api/cron/start/route.js', 'app/api/cron/report/route.js']) { assert.match(used(f), /authorizedCron\(req\)/); assert.doesNotMatch(used(f), /authorizedWorker|WATCHDOG_SECRET/); }
});
