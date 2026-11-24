// Architecture guards: cheap static checks that keep the security model from eroding as code is added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const rel = (p) => path.relative(ROOT, p);
const src = (p) => readFileSync(p, 'utf8');

const routes = walk(path.join(ROOT, 'app/api')).filter((p) => p.endsWith('route.js'));
// Routes that are not called by a signed-in user. Each has its own, different, authentication.
const CRON = ['app/api/cron/report/route.js', 'app/api/cron/start/route.js', 'app/api/cron/work/route.js'];
const ADMIN = ['app/api/admin/ops/route.js']; // platform operator only: checked with requireAdmin instead of a project
const PUBLIC = ['app/api/gsc/callback/route.js', 'app/api/csp-report/route.js']; // Google redirects the browser here; it carries a signed, expiring state instead of a session

test('there is something to check', () => assert.ok(routes.length >= 12));

test('every user-facing API route authenticates and validates input through the shared helpers', () => {
  for (const f of routes) {
    const name = rel(f), code = src(f);
    if (ADMIN.includes(name)) { assert.match(code, /requireAdmin\(await requireUser\(req\)\)/, `${name} must call requireAdmin(requireUser)`); assert.match(code, /readJsonBody\(req/); assert.match(code, /export const POST = route\(/); continue; }
    if (CRON.includes(name) || PUBLIC.includes(name)) continue;
    if (name === 'app/api/gsc/connect/route.js') { assert.match(code, /requireUser/, name); continue; } // its GET only reports a boolean
    assert.match(code, /requireUser\(req\)/, `${name} must call requireUser`);
    assert.match(code, /requireProject\(/, `${name} must check project ownership with requireProject`);
    assert.match(code, /readJsonBody\(req/, `${name} must read its body with readJsonBody (size cap, shape check)`);
    assert.match(code, /export const POST = route\(/, `${name} must be wrapped in route() for safe error handling`);
    assert.doesNotMatch(code, /req\.json\(\)/, `${name} must not call req.json() directly`);
    assert.doesNotMatch(code, /userFromRequest/, `${name} must use requireUser, not userFromRequest`);
  }
});

test('cron routes verify the cron secret before doing anything', () => {
  for (const f of CRON) {
    const code = src(path.join(ROOT, f));
    const body = code.slice(code.indexOf('export async function GET'));
    const guard = Math.max(body.indexOf('authorizedCron(req)'), body.indexOf('authorizedWorker(req)'));
    assert.ok(guard > 0, `${f} must call authorizedCron or authorizedWorker`);
    assert.ok(guard < body.search(/await |workOne\(|startDay\(|finishProjects\(/), `${f}: the check must come first`);
  }
});

test('routes that spend money (search, AI, crawling) are rate limited', () => {
  for (const f of ['app/api/extract/route.js', 'app/api/verify/route.js', 'app/api/report/insights/route.js', 'app/api/competitor/add/route.js', 'app/api/project/nudge/route.js', 'app/api/project/start/route.js', 'app/api/gsc/sync/route.js', 'app/api/gsc/connect/route.js', 'app/api/gsc/disconnect/route.js'])
    assert.match(src(path.join(ROOT, f)), /await limit\(auth, '/, `${f} must call limit()`);
});

test('the service-role client and secrets are never reachable from browser code', () => {
  const FORBIDDEN = [/lib\/db['"]/, /lib\/gsc['"]/, /lib\/pipeline['"]/, /lib\/security\/crypto['"]/, /lib\/security\/netguard['"]/, /lib\/crawl['"]/, /lib\/auth['"]/, /lib\/http['"]/];
  const files = [...walk(path.join(ROOT, 'app')).filter((p) => /\.js$/.test(p) && !p.includes('/api/')), ...walk(path.join(ROOT, 'lib')).filter((p) => /\.js$/.test(p))];
  for (const f of files) {
    const code = src(f);
    if (!/^\s*['"]use client['"]/.test(code)) continue;
    for (const re of FORBIDDEN) assert.doesNotMatch(code, new RegExp(`from\\s+['"][^'"]*${re.source}`), `${rel(f)} is a client file and must not import server-only code (${re})`);
  }
});

test('SUPABASE_SERVICE_ROLE_KEY is read in exactly two server-only places', () => {
  const hits = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib'))].filter((p) => /\.js$/.test(p) && /SUPABASE_SERVICE_ROLE_KEY/.test(src(p))).map(rel).sort();
  assert.deepEqual(hits, ['lib/db.js', 'lib/security/crypto.js']);
});

test('no NEXT_PUBLIC variable carries a secret', () => {
  const names = new Set();
  for (const f of [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib'))].filter((p) => /\.js$/.test(p))) for (const m of src(f).matchAll(/process\.env\.(NEXT_PUBLIC_\w+)/g)) names.add(m[1]);
  assert.deepEqual([...names].sort(), ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_URL']);
});

test('no route echoes server key details, stack traces or raw database errors', () => {
  for (const f of routes) {
    const code = src(f);
    assert.doesNotMatch(code, /SERVICE_ROLE|key type|startsWith\('sb_/i, `${rel(f)} must not mention key types`);
    assert.doesNotMatch(code, /error\??\.message\s*[}`)]/, `${rel(f)} must not put raw error messages in a response`);
    assert.doesNotMatch(code, /\.stack/, `${rel(f)}`);
  }
});

test('outbound HTTP to user-influenced hosts uses the SSRF guard, never a raw fetch', () => {
  // fetch() is allowed only for fixed vendor hosts. Files that handle user-influenced URLs must not call it.
  for (const f of ['lib/crawl.js', 'lib/audit.js', 'app/api/verify/route.js']) assert.doesNotMatch(src(path.join(ROOT, f)), /(^|[^.\w])fetch\(/m, `${f} must use the guarded fetch`);
});

test('sign-in requires an explicit, recorded acceptance of the Terms and Privacy Policy', () => {
  const login = src(path.join(ROOT, 'app/login/page.js'));
  assert.match(login, /type="checkbox"[\s\S]*Terms of Service[\s\S]*Privacy Policy/);
  assert.match(login, /disabled=\{busy \|\| !agree\}/);
  assert.match(login, /if \(!agree\)/, 'the handler refuses too, not only the button');
  const gate = src(path.join(ROOT, 'app/consent.js'));
  assert.match(gate, /legal_consents/);
  assert.match(src(path.join(ROOT, 'app/components.js')), /<ConsentGate \/>/, 'every app page shows the gate through Nav');
  assert.match(src(path.join(ROOT, 'lib/legal-version.js')), /LEGAL_VERSION = '\d{4}-\d{2}-\d{2}'/);
});
