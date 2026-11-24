// Static guards: everything that spends money is behind a budget charge, and the archive script never ships secrets or history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');

test('routes that spend AI or crawl money charge the organisation budget after the rate limit', () => {
  for (const [f, metric] of [['app/api/report/insights/route.js', 'ai'], ['app/api/extract/route.js', 'crawl']]) {
    const code = read(f);
    assert.match(code, new RegExp(`charge\\(\\w+, '${metric}'`), `${f} must charge ${metric}`);
    assert.ok(code.indexOf("limit(auth,") < code.indexOf('charge('), `${f}: rate limit first, then budget`);
  }
});
test('every job handler that spends charges its budget before the spend', () => {
  const src = read('lib/pipeline.js');
  const part = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
  const discovery = part('async function runDiscovery', 'async function runCrawl'), crawl = part('async function runCrawl', 'async function runAudit'), audit = part('async function runAudit', '// Ranks are assigned');
  assert.match(discovery, /chargeBudget\([^)]*'search'/); assert.match(discovery, /chargeBudget\([^)]*'ai'/);
  assert.ok(discovery.indexOf('chargeBudget') < discovery.indexOf('discover(project'));
  assert.match(crawl, /chargeBudget\([^)]*'crawl'/); assert.ok(crawl.indexOf('chargeBudget') < crawl.indexOf('getCrawl('));
  assert.match(audit, /chargeBudget\([^)]*'crawl', 5/); assert.ok(audit.indexOf('chargeBudget') < audit.indexOf('crawlSite('));
});
test('the audit trail and the alert table are only written through their functions', () => {
  for (const f of ['lib/pipeline.js', 'lib/http.js', 'lib/auditTrail.js', 'lib/alerts.js', 'lib/budget.js']) {
    assert.doesNotMatch(read(f), /from\('audit_log'\)\.(insert|update|delete|upsert)|from\('alerts'\)\.(insert|delete|upsert)/, f);
  }
  assert.match(read('lib/alerts.js'), /from\('alerts'\)\.select/, 'alerts are only read, then marked as notified');
});
test('the per-IP limit runs before authentication in requireUser', () => {
  const http = read('lib/http.js');
  const fn = http.slice(http.indexOf('export async function requireUser'), http.indexOf('export async function requireProject'));
  assert.ok(fn.indexOf('ipKey(') > -1 && fn.indexOf('ipKey(') < fn.indexOf('userFromRequest('));
});
test('the clean archive script ships no history, secrets, backups or internal reports, and checks its own output', () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'radar-arch-')), 'code.zip');
  const stdout = execFileSync('bash', [new URL('../../scripts/make-archive.sh', import.meta.url).pathname, out], { encoding: 'utf8' });
  assert.match(stdout, /Wrote/);
  const list = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(list.includes('package.json') && list.includes('.env.example') && list.includes('supabase/migrations/0011_organisations.sql'));
  for (const bad of [/^\.git\//, /(^|\/)\.env$/, /\.env\.local$/, /\.radarbackup$/, /^backups\//, /\.vercel\//, /node_modules\//, /Build-Report/i, /^build-report/, /\.zip$/]) assert.ok(!list.some((f) => bad.test(f)), String(bad));
  assert.equal(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8').match(/^[A-Z_]+=\S+/gm)?.length || 0, 0, '.env.example has no values');
});
