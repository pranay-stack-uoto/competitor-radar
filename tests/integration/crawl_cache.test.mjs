// Shared crawl cache: SQL semantics (who crawls, who waits, who reuses), lease ownership, and no customer data.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, as, asUser, U1, MIGRATIONS_DIR, migrationFiles } from '../helpers/db.mjs';

let db;
before(async () => { db = await createDb(); });
beforeEach(async () => { await db.exec('delete from public.domain_crawls; delete from public.domain_crawl_snapshots'); });

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const lease = (d = 'a.example.com', v = 'f1-p40', age = 3600, secs = 180) => one('select * from public.acquire_domain_crawl_lease($1,$2,$3,$4)', [d, v, age, secs]);
const acquire = async (...a) => (await lease(...a)).state;
const finish = async (token, d = 'a.example.com', v = 'f1-p40', data = { pages: [{ url: 'https://a.example.com/' }] }, pages = 1) =>
  (await one('select public.finish_domain_crawl_lease($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8) as ok', [d, v, token, JSON.stringify(data), pages, JSON.stringify({ pagesCrawled: pages }), 'h1', 86400])).ok;
const fail = async (token, d = 'a.example.com', v = 'f1-p40', msg = 'boom') => (await one('select public.fail_domain_crawl_lease($1,$2,$3,$4) as ok', [d, v, token, msg])).ok;
const age = (secs, d = 'a.example.com') => db.query(`update public.domain_crawls set crawled_at = now() - make_interval(secs => $2) where domain = $1`, [d, secs]);
const expireLease = (d = 'a.example.com') => db.query(`update public.domain_crawls set lease_expires_at = now() - interval '1 second' where domain = $1`, [d]);
const row = (d = 'a.example.com') => one('select status, data, lease_token, error from public.domain_crawls where domain = $1', [d]);

test('the first caller must crawl and gets a lease token; a second caller is told to wait', async () => {
  const a = await lease();
  assert.equal(a.state, 'acquired'); assert.match(a.token, /^[0-9a-f-]{36}$/);
  const b = await lease();
  assert.equal(b.state, 'busy'); assert.equal(b.token, null);
});
test('after a successful crawl everyone gets the stored data and nobody crawls again', async () => {
  const a = await lease(); assert.equal(await finish(a.token), true);
  const again = await lease(); assert.equal(again.state, 'fresh'); assert.equal(again.token, null);
  assert.equal((await one('select public.get_domain_crawl($1, $2) as d', ['a.example.com', 'f1-p40'])).d.pages[0].url, 'https://a.example.com/');
});
test('data older than the allowed age is recrawled', async () => {
  const a = await lease(); await finish(a.token); await age(7200);
  assert.equal(await acquire('a.example.com', 'f1-p40', 3600), 'acquired');
  assert.equal(await acquire('a.example.com', 'f1-p40', 3600), 'busy');
});
test('a different crawler version or domain is separate', async () => {
  const a = await lease(); await finish(a.token);
  assert.equal(await acquire('a.example.com', 'f1-p60'), 'acquired');
  assert.equal(await acquire('b.example.com'), 'acquired');
});
test('domains are matched case-insensitively', async () => { await lease('A.Example.COM'); assert.equal(await acquire('a.example.com'), 'busy'); });
test('invalidate forces the next request to recrawl', async () => {
  const a = await lease(); await finish(a.token);
  assert.equal(await acquire(), 'fresh');
  assert.equal((await one('select public.invalidate_domain_crawl($1) as n', ['A.example.com'])).n, 1);
  assert.equal(await acquire(), 'acquired');
});
test('history: every finished crawl adds a small snapshot, the raw data is kept only for the latest', async () => {
  for (let i = 0; i < 3; i++) { const a = await lease(); await finish(a.token, 'a.example.com', 'f1-p40', { pages: [{ url: 'x' }], run: i }); await age(99999); }
  assert.equal(Number((await one('select count(*) n from public.domain_crawl_snapshots')).n), 3);
  assert.equal(Number((await one('select count(*) n from public.domain_crawls')).n), 1);
  const snap = await one('select profile, data_hash from public.domain_crawl_snapshots order by id desc limit 1');
  assert.deepEqual(snap.profile, { pagesCrawled: 1 }); assert.equal(snap.data_hash, 'h1');
});

// ---------------- lease ownership (migration 0008) ----------------
test('every acquisition gets a different token', async () => {
  const a = await lease(); await expireLease(); const b = await lease();
  assert.equal(b.state, 'acquired'); assert.notEqual(a.token, b.token);
});
test('finishing needs the token: no token, a wrong token or a made-up token are all refused', async () => {
  const a = await lease();
  assert.equal(await finish(null), false);
  assert.equal(await finish('00000000-0000-4000-8000-000000000000'), false);
  assert.equal(await fail(null), false);
  assert.equal((await row()).status, 'running'); assert.equal((await row()).data, null);
  assert.equal(await finish(a.token), true);
});
test('STALE WORKER: after its lease expired and a newer worker took over, the old worker cannot finish', async () => {
  const oldW = await lease();            // worker A acquires
  await expireLease();                   // A is slow; its lease runs out
  const newW = await lease();            // worker B takes over
  assert.equal(newW.state, 'acquired');
  assert.equal(await finish(newW.token, 'a.example.com', 'f1-p40', { pages: [{ url: 'B' }] }), true); // B stores its result
  assert.equal(await finish(oldW.token, 'a.example.com', 'f1-p40', { pages: [{ url: 'A-STALE' }] }), false); // A is rejected
  assert.equal((await row()).data.pages[0].url, 'B', 'the newer result must survive');
  assert.equal(Number((await one('select count(*) n from public.domain_crawl_snapshots')).n), 1, 'the stale worker leaves no history entry');
});
test('STALE WORKER: it cannot overwrite even while the newer worker is still running', async () => {
  const oldW = await lease(); await expireLease(); const newW = await lease();
  assert.equal(await finish(oldW.token, 'a.example.com', 'f1-p40', { pages: [{ url: 'A-STALE' }] }), false);
  assert.equal((await row()).status, 'running'); assert.equal(await finish(newW.token), true);
});
test('STALE WORKER: it cannot mark the newer worker\'s crawl as failed', async () => {
  const oldW = await lease(); await expireLease(); const newW = await lease();
  assert.equal(await fail(oldW.token), false);
  const r = await row(); assert.equal(r.status, 'running'); assert.equal(r.lease_token, newW.token); assert.equal(r.error, null);
});
test('an expired lease cannot finish or fail, even if nobody else has taken over', async () => {
  const a = await lease(); await expireLease();
  assert.equal(await finish(a.token), false);
  assert.equal(await fail(a.token), false);
});
test('a token can be used once: finishing or failing consumes it', async () => {
  const a = await lease(); assert.equal(await finish(a.token), true);
  assert.equal(await finish(a.token), false); assert.equal(await fail(a.token), false);
  const b = await lease('b.example.com'); assert.equal(await fail(b.token, 'b.example.com'), true);
  assert.equal(await fail(b.token, 'b.example.com'), false);
  assert.equal(await finish(b.token, 'b.example.com'), false);
  assert.equal((await row('b.example.com')).lease_token, null);
});
test('a token for one domain or version does not work on another', async () => {
  const a = await lease('a.example.com'); await lease('b.example.com');
  assert.equal(await finish(a.token, 'b.example.com'), false);
  assert.equal(await finish(a.token, 'a.example.com', 'other-version'), false);
});
test('a failed crawl releases the domain; old data is not served as fresh; the next caller gets a new token', async () => {
  const first = await lease(); await finish(first.token); await age(7200);
  const second = await lease('a.example.com', 'f1-p40', 3600); assert.equal(second.state, 'acquired');
  assert.equal(await fail(second.token), true);
  const third = await lease('a.example.com', 'f1-p40', 3600);
  assert.equal(third.state, 'acquired'); assert.notEqual(third.token, second.token);
});
test('an expired lease from a crashed worker does not block the domain', async () => {
  await lease(); await expireLease();
  assert.equal(await acquire(), 'acquired');
});

// ---------------- compatibility with data created before 0008 ----------------
test('existing cache rows from before 0008 are preserved and still served', async () => {
  const old = await createDb({ only: migrationFiles().filter((f) => Number(f.slice(0, 4)) <= 7) });
  await old.query(`insert into public.domain_crawls (domain, crawl_version, status, crawled_at, expires_at, pages, data) values ('keep.example.com', 'f1-p40', 'ok', now(), now() + interval '1 day', 2, '{"pages":[{"url":"https://keep.example.com/"}]}')`);
  await old.query(`insert into public.domain_crawls (domain, crawl_version, status, lease_expires_at) values ('mid.example.com', 'f1-p40', 'running', now() - interval '1 minute')`);
  await old.exec(readFileSync(path.join(MIGRATIONS_DIR, '0008_crawl_lease_tokens.sql'), 'utf8'));
  const r = (await old.query(`select domain, status, pages, data, lease_token from public.domain_crawls order by domain`)).rows;
  assert.equal(r[0].domain, 'keep.example.com'); assert.equal(r[0].pages, 2); assert.equal(r[0].data.pages[0].url, 'https://keep.example.com/'); assert.equal(r[0].lease_token, null);
  assert.equal((await old.query(`select * from public.acquire_domain_crawl_lease('keep.example.com', 'f1-p40', 3600)`)).rows[0].state, 'fresh');
  assert.equal((await old.query(`select * from public.acquire_domain_crawl_lease('mid.example.com', 'f1-p40', 3600)`)).rows[0].state, 'acquired'); // expired lease with no token: taken over
});
test('the legacy functions from 0005 can no longer store or fail anything, and legacy acquire never hands out a usable token', async () => {
  const state = (await one(`select public.acquire_domain_crawl('l.example.com', 'f1-p40', 3600) as s`)).s;
  assert.equal(state, 'acquired');
  assert.equal((await one(`select public.finish_domain_crawl('l.example.com', 'f1-p40', '{"pages":[]}'::jsonb, 1, null, 'h', 60) as ok`)).ok, false);
  assert.equal((await one(`select public.fail_domain_crawl('l.example.com', 'f1-p40', 'x') as ok`)).ok, false);
  assert.equal((await row('l.example.com')).data, null);
  assert.equal(await acquire('l.example.com'), 'busy');
});

test('no customer data can be stored in the shared tables (no project, user or score columns)', async () => {
  const cols = (await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name in ('domain_crawls', 'domain_crawl_snapshots')`)).rows.map((r) => r.column_name);
  for (const c of cols) assert.doesNotMatch(c, /project|user|score|rank|keyword|location|gsc|^token/i, c);
});
test('the domain must look like a real hostname', async () => {
  for (const bad of ['localhost', '127.0.0.1', 'a b.com', 'x.y:80']) await assert.rejects(db.query(`select * from public.acquire_domain_crawl_lease($1, 'v', 60)`, [bad]), /domain_crawls_domain_format/, bad);
});
test('server-only: browser roles cannot read the tables or call any of the functions', async () => {
  const calls = [`select * from public.acquire_domain_crawl_lease('a.example.com','v',60)`, `select public.finish_domain_crawl_lease('a.example.com','v','00000000-0000-4000-8000-000000000000','{}'::jsonb,1,null,'h',60)`,
    `select public.fail_domain_crawl_lease('a.example.com','v','00000000-0000-4000-8000-000000000000','x')`, `select public.get_domain_crawl('a.example.com','v')`, `select public.invalidate_domain_crawl('a.example.com')`,
    `select public.acquire_domain_crawl('a.example.com','v',60)`, `select public.finish_domain_crawl('a.example.com','v','{}'::jsonb,1,null,'h',60)`, `select public.fail_domain_crawl('a.example.com','v','x')`];
  await asUser(db, U1, async () => {
    for (const t of ['domain_crawls', 'domain_crawl_snapshots']) await assert.rejects(db.query(`select * from public.${t}`), /permission denied/, t);
    for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c);
  });
  await as(db, 'anon', null, async () => { await assert.rejects(db.query(`select * from public.domain_crawls`), /permission denied/); });
  await as(db, 'service_role', null, async () => { await db.query(calls[0]); });
});
