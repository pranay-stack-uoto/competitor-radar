// REAL-POSTGRES restore drill: back up a populated database, restore the backup into a second EMPTY database, and prove nothing was lost.
// Needs TEST_DATABASE_URL (see tests/helpers/realdb.mjs); the role must be allowed to create databases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';
import { skip, setup, URL_ } from '../helpers/realdb.mjs';
import { MIGRATIONS_DIR, SUPABASE_STUB } from '../helpers/db.mjs';
const { exportData, pack, unpack, restoreData, verifyRestore } = createRequire(import.meta.url)('../../lib/ops/backup.js');

const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
let admin, scratchUrl, scratch, data;
const PASS = 'a-long-test-passphrase-123';

before(async () => {
  if (skip) return;
  admin = await setup();
  await admin.query(`insert into auth.users (id) values ($1), ($2)`, [U1, U2]);
  for (const [u, d] of [[U1, 'one.example.com'], [U2, 'two.example.com']]) {
    const p = (await admin.query(`insert into public.projects (user_id, name, url, domain, keywords, verified) values ($1, $2, $3, $2, '{plumber}', true) returning id`, [u, d, 'https://' + d])).rows[0].id;
    await admin.query(`insert into public.competitors (project_id, domain) values ($1, 'rival.example.org')`, [p]);
    await admin.query(`insert into public.scores (project_id, day, domain, is_me, overall, details) values ($1, current_date, $2, true, 55, '{"a":[1,2,{"b":"c"}]}')`, [p, d]);
    await admin.query(`insert into public.reports (project_id, day, summary) values ($1, current_date, '{"ok":true}')`, [p]);
    await admin.query(`insert into public.gsc_tokens (project_id, token_enc) values ($1, 'v1.aaa.bbb.ccc')`, [p]);
    await admin.query(`select public.enqueue_job($1, current_date, 'crawl', 'x.example.com')`, [p]);
    await admin.query(`select public.rate_limit_hit('k' || $1::text, 60, 5)`, [d]);
  }
  await admin.query(`insert into public.org_budgets select id, 'ai', 7 from public.organisations limit 1`);
  await admin.query(`select public.usage_charge((select id from public.organisations limit 1), 'ai', 2)`);
  const dbname = 'radar_restore_' + Date.now();
  await admin.query(`create database ${dbname}`);
  scratchUrl = URL_.replace(/\/[^/]*$/, '/' + dbname);
  scratch = new pg.Client({ connectionString: scratchUrl }); await scratch.connect();
  await scratch.query(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) await scratch.query(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  data = await exportData(admin);
});
after(async () => { if (scratch) await scratch.end(); if (admin) await admin.end(); });

test('the export covers every customer table, skips the rebuildable caches, and lists accounts', { skip }, () => {
  for (const t of ['projects', 'competitors', 'scores', 'reports', 'gsc_tokens', 'organisations', 'organisation_members', 'audit_log', 'jobs', 'usage_daily', 'org_budgets']) assert.ok(data.counts[t] > 0, t);
  for (const t of ['rate_limits', 'ai_cache', 'domain_crawls', 'domain_crawl_snapshots', 'benchmark_aggregates', 'oauth_states']) assert.equal(data.tables[t], undefined, t);
  assert.equal(data.userCount, 2);
});
test('the export works inside one read-only snapshot transaction, as the backup script runs it', { skip }, async () => {
  await admin.query('begin read only isolation level repeatable read');
  try { const d = await exportData(admin); assert.deepEqual(d.counts, data.counts); assert.equal(d.userCount, 2); } finally { await admin.query('commit'); }
});
test('the file is encrypted: not readable without the passphrase, not openable with a wrong one, and any change is detected', { skip }, () => {
  const buf = pack(data, PASS);
  assert.equal(buf.subarray(0, 4).toString(), 'RBK1');
  assert.ok(!buf.includes(Buffer.from('one.example.com')), 'no plaintext inside');
  assert.throws(() => unpack(buf), /passphrase is required/);
  assert.throws(() => unpack(buf, 'a-different-long-passphrase'), /Wrong passphrase/);
  for (const at of [10, 40, 60, buf.length - 5]) { const bad = Buffer.from(buf); bad[at] ^= 1; assert.throws(() => unpack(bad, PASS), /Wrong passphrase|altered/, `byte ${at}`); }
  assert.throws(() => pack(data, 'short'), /at least 16/);
  assert.deepEqual(unpack(buf, PASS).counts, data.counts);
});
test('DRILL: restoring into an empty database reproduces every row, the audit chain verifies, and identity counters continue', { skip }, async () => {
  const restored = unpack(pack(data, PASS), PASS);
  await restoreData(scratch, restored);
  const v = await verifyRestore(scratch, restored);
  assert.deepEqual(v.problems, []); assert.equal(v.ok, true);
  // Row for row: every table's content is identical to the source.
  for (const t of Object.keys(data.counts)) {
    const a = await admin.query(`select md5(coalesce(string_agg(to_jsonb(x)::text, ',' order by to_jsonb(x)::text), '')) as h from public."${t}" x`);
    const b = await scratch.query(`select md5(coalesce(string_agg(to_jsonb(x)::text, ',' order by to_jsonb(x)::text), '')) as h from public."${t}" x`);
    assert.equal(b.rows[0].h, a.rows[0].h, `table ${t} differs after restore`);
  }
  // Triggers did not fire during the load (no duplicate audit rows), but they work afterwards, and the sequence continues.
  assert.equal(Number((await scratch.query('select count(*) as n from public.audit_log')).rows[0].n), data.counts.audit_log);
  const before_ = data.counts.audit_log;
  await scratch.query(`select public.audit_record(null, null, 'after.restore')`);
  assert.equal(Number((await scratch.query('select max(id) as m from public.audit_log')).rows[0].m), Number((await admin.query('select max(id) as m from public.audit_log')).rows[0].m) + 1);
  assert.equal((await scratch.query('select * from public.audit_verify()')).rows[0].first_bad_id, null);
  assert.ok(before_ > 0);
});
test('restoring twice, or into a database that has data, is refused instead of mixing', { skip }, async () => {
  await assert.rejects(restoreData(scratch, data), /not empty/);
});
test('a damaged restore is caught by the verification, not silently accepted', { skip }, async () => {
  await scratch.query('alter table public.audit_log disable trigger audit_log_no_change');
  await scratch.query(`update public.audit_log set detail = '{"x":1}' where id = (select min(id) from public.audit_log)`);
  await scratch.query('alter table public.audit_log enable trigger audit_log_no_change');
  await scratch.query(`delete from public.reports`);
  const v = await verifyRestore(scratch, data);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /audit chain broken/.test(p)) && v.problems.some((p) => /reports: backup has/.test(p)), v.problems.join('; '));
});
