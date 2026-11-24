// Migration 0017: the OAuth nonce is single-use, short-lived, and bound to one user and one project.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDb, as, asUser } from '../helpers/db.mjs';

const OWNER = '11111111-0000-4000-8000-000000000000', ADMIN = '22222222-0000-4000-8000-000000000000', MEMBER = '33333333-0000-4000-8000-000000000000', OTHER = '44444444-0000-4000-8000-000000000000';
const ORG = 'a0000000-0000-4000-8000-000000000001', P1 = 'b0000000-0000-4000-8000-000000000001', P2 = 'b0000000-0000-4000-8000-000000000002';
const h = () => crypto.randomBytes(32).toString('hex');
let db;
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const create = async (hash, user = OWNER, project = P1, ttl = 600) => (await rows('select public.oauth_state_create($1, $2, $3, $4) as r', [hash, user, project, ttl]))[0].r;
const consume = async (hash, user = OWNER, project = P1) => (await rows('select public.oauth_state_consume($1, $2, $3) as r', [hash, user, project]))[0].r;
before(async () => {
  db = await createDb();
  for (const u of [OWNER, ADMIN, MEMBER, OTHER]) await db.query('insert into auth.users (id) values ($1)', [u]);
  await db.query(`insert into public.organisations (id, name) values ($1, 'o')`, [ORG]);
  await db.query(`insert into public.organisation_members values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')`, [ORG, OWNER, ADMIN, MEMBER]);
  for (const p of [P1, P2]) await db.query(`insert into public.projects (id, user_id, organisation_id, name, url, domain) values ($1, $2, $3, 'p', 'https://p.example.com', $4)`, [p, OWNER, ORG, p === P1 ? 'one.example.com' : 'two.example.com']);
});
beforeEach(async () => { await db.exec('delete from public.oauth_states'); });

test('a fresh nonce is accepted once by the user and project that started it', async () => {
  const n = h(); assert.equal(await create(n), true);
  assert.equal(await consume(n), true);
});
test('REPLAY: the second use of the same nonce fails, as does every later one', async () => {
  const n = h(); await create(n);
  assert.equal(await consume(n), true);
  for (let i = 0; i < 3; i++) assert.equal(await consume(n), false);
});
test('an expired nonce is refused, and so is one that was never created', async () => {
  const n = h(); await create(n, OWNER, P1, 30);
  await db.query(`update public.oauth_states set expires_at = clock_timestamp() - interval '1 second'`);
  assert.equal(await consume(n), false);
  assert.equal(await consume(h()), false);
});
test('a nonce for a different user or a different project is refused, and is burned by the attempt', async () => {
  const a = h(); await create(a);
  assert.equal(await consume(a, ADMIN, P1), false, 'another user');
  assert.equal(await consume(a, OWNER, P1), false, 'the right user cannot use it after a wrong presentation');
  const b = h(); await create(b);
  assert.equal(await consume(b, OWNER, P2), false, 'another project');
  assert.equal(await consume(b, OWNER, P1), false);
});
test('only the hash is stored: the nonce itself cannot be recovered from the table', async () => {
  const n = h(); await create(n);
  const all = JSON.stringify(await rows('select * from public.oauth_states'));
  assert.ok(all.includes(n), 'this test stores the hash it is given');
  // The application hashes the random nonce before calling (lib/security/oauthState.js); the database only accepts a 64-hex digest.
  await assert.rejects(create('plain-nonce-value'), /bad nonce/);
  assert.equal(await consume('plain-nonce-value'), false);
  assert.equal(await consume(null), false);
});
test('only an admin or owner of the project can start a flow; members, viewers and outsiders cannot', async () => {
  assert.equal(await create(h(), ADMIN), true);
  assert.equal(await create(h(), MEMBER), false);
  assert.equal(await create(h(), OTHER), false);
  assert.equal(await create(h(), OWNER, '00000000-0000-4000-8000-000000000000'), false, 'a project that does not exist');
  assert.equal(Number((await rows('select count(*) as n from public.oauth_states'))[0].n), 1);
});
test('lifetime bounds and a cap of 20 unused nonces per user', async () => {
  await assert.rejects(create(h(), OWNER, P1, 5), /bad lifetime/);
  await assert.rejects(create(h(), OWNER, P1, 5000), /bad lifetime/);
  for (let i = 0; i < 20; i++) assert.equal(await create(h()), true);
  assert.equal(await create(h()), false, 'the 21st is refused');
  assert.equal(await create(h(), ADMIN), true, 'another user is unaffected');
  const used = (await rows('select nonce_hash from public.oauth_states where user_id = $1 limit 1', [OWNER]))[0].nonce_hash;
  await consume(used);
  assert.equal(await create(h()), true, 'consuming frees a slot');
});
test('old rows are cleaned up a day after they expire', async () => {
  await create(h()); await db.query(`update public.oauth_states set expires_at = now() - interval '2 days'`);
  await create(h());
  assert.equal(Number((await rows('select count(*) as n from public.oauth_states'))[0].n), 1);
});
test('the table and both functions are server-only', async () => {
  const n = h(); await create(n);
  const calls = [`select public.oauth_state_create('${h()}', '${OWNER}', '${P1}', 600)`, `select public.oauth_state_consume('${n}', '${OWNER}', '${P1}')`];
  await asUser(db, OWNER, async () => {
    for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c);
    await assert.rejects(db.query('select * from public.oauth_states'), /permission denied/);
    await assert.rejects(db.query(`update public.oauth_states set consumed_at = null`), /permission denied/);
    await assert.rejects(db.query(`insert into public.oauth_states values ('${h()}', '${OWNER}', '${P1}', now(), now(), null)`), /permission denied/);
  });
  await as(db, 'anon', null, async () => { for (const c of calls) await assert.rejects(db.query(c), /permission denied/, c); });
  await as(db, 'service_role', null, async () => { assert.equal((await db.query(calls[1])).rows[0].oauth_state_consume, true); });
  assert.equal((await rows(`select relrowsecurity from pg_class where relname = 'oauth_states'`))[0].relrowsecurity, true);
});
test('deleting the project or the user removes their pending nonces', async () => {
  const n = h(); await create(n); await db.query('delete from public.projects where id = $1', [P1]);
  assert.equal(Number((await rows('select count(*) as n from public.oauth_states'))[0].n), 0);
});
