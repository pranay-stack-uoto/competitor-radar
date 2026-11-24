import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { securityHeaders, enforcedPolicy, fullPolicy } = createRequire(import.meta.url)('../../lib/security/headers.js');

const PROD = { NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co' };
const map = (env) => Object.fromEntries(securityHeaders(env).map((h) => [h.key, h.value]));
const directives = (p) => Object.fromEntries(p.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

test('every response gets the core headers', () => {
  const h = map(PROD);
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.match(h['Permissions-Policy'], /camera=\(\)/); assert.match(h['Permissions-Policy'], /geolocation=\(\)/);
  assert.ok(h['Content-Security-Policy'] && h['Content-Security-Policy-Report-Only']);
});
test('HSTS is sent in production only, with no subdomain or preload commitment', () => {
  assert.equal(map(PROD)['Strict-Transport-Security'], 'max-age=31536000');
  assert.doesNotMatch(map(PROD)['Strict-Transport-Security'], /includeSubDomains|preload/);
  for (const env of [{ NODE_ENV: 'development' }, { NODE_ENV: 'test' }, {}]) assert.equal(map(env)['Strict-Transport-Security'], undefined, JSON.stringify(env));
});
test('the enforced policy only contains directives that cannot break the app', () => {
  const d = directives(enforcedPolicy());
  assert.deepEqual(Object.keys(d).sort(), ['base-uri', 'form-action', 'frame-ancestors', 'object-src']);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]); assert.deepEqual(d['object-src'], ["'none'"]);
  assert.equal(map(PROD)['Content-Security-Policy'], enforcedPolicy());
});
test('the full policy (report-only) is tight: self by default, no eval, no wildcard scripts, only this origin and Supabase for connections', () => {
  const d = directives(fullPolicy(PROD));
  assert.deepEqual(d['default-src'], ["'self'"]);
  assert.deepEqual(d['script-src'], ["'self'", "'unsafe-inline'"], 'unsafe-inline is the one known exception (TD-34); never unsafe-eval');
  for (const [k, v] of Object.entries(d)) { assert.ok(!v.includes("'unsafe-eval'"), k); if (k !== 'connect-src') assert.ok(!v.some((s) => s === '*' || s === 'http:' || s === 'https:'), `${k} must not allow everything`); }
  assert.deepEqual(d['connect-src'], ["'self'", 'https://abcdefgh.supabase.co', 'wss://abcdefgh.supabase.co']);
  assert.deepEqual(d['frame-src'], ["'none'"]); assert.deepEqual(d['font-src'], ["'self'"]);
  assert.deepEqual(d['report-uri'], ['/api/csp-report']);
  assert.ok(directives(fullPolicy({}))['connect-src'].includes('https://*.supabase.co'), 'falls back to the project wildcard only when the URL is not set');
  assert.ok(!directives(fullPolicy({ NEXT_PUBLIC_SUPABASE_URL: 'http://evil.example.com' }))['connect-src'].includes('http://evil.example.com'), 'a non-https URL is not trusted');
});
test('Google sign-in needs nothing special: it is a redirect, so no external script, frame or form target is allowed for it', () => {
  const d = directives(fullPolicy(PROD));
  for (const k of ['script-src', 'frame-src', 'form-action', 'default-src']) assert.ok(!d[k].join(' ').includes('google'), k);
});
test('the app really does only use what the policy allows (no external script tags, iframes or inline event handlers in app code)', () => {
  const files = ['app/layout.js', 'app/page.js', 'app/login/page.js', 'app/dashboard/page.js', 'app/report/page.js', 'app/onboarding/page.js', 'app/welcome/page.js', 'app/components.js', 'app/panels.js', 'app/overview.js'];
  for (const f of files) {
    const code = readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /<script[^>]*\ssrc=|<iframe|dangerouslySetInnerHTML|eval\(|new Function\(/, f);
    assert.doesNotMatch(code, /https:\/\/fonts\.(googleapis|gstatic)\.com/, `${f} loads fonts through next/font (self-hosted)`);
  }
});
test('next.config.mjs applies the headers to every path and hides X-Powered-By', async () => {
  const cfg = (await import('../../next.config.mjs')).default;
  assert.equal(cfg.poweredByHeader, false);
  const rules = await cfg.headers();
  assert.equal(rules.length, 1); assert.equal(rules[0].source, '/:path*');
  const keys = rules[0].headers.map((h) => h.key);
  for (const k of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) assert.ok(keys.includes(k), k);
});
