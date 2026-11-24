// Migration 0014: the audit trail records the right things automatically, cannot be altered quietly, and raises alerts on unusual patterns.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser } from '../helpers/db.mjs';

const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`;
const [OWNER, ADMIN, MEMBER, OUTSIDER, CAND] = ['1', '2', '3', '4', '5'].map(U);
const ORG = 'a0000000-0000-4000-8000-000000000001', ORG2 = 'a0000000-0000-4000-8000-000000000002', P = 'b0000000-0000-4000-8000-000000000001';
let db;
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const actions = async (org = ORG) => (await rows('select action from public.audit_log where organisation_id = $1 order by id', [org])).map((r) => r.action);
const last = async () => (await rows('select * from public.audit_log order by id desc limit 1'))[0];

before(async () => {
  db = await createDb();
  for (const u of [OWNER, ADMIN, MEMBER, OUTSIDER, CAND]) await db.query('insert into auth.users (id) values ($1)', [u]);
  await db.query(`insert into public.organisations (id, name) values ($1, 'A'), ($2, 'B')`, [ORG, ORG2]);
  await db.query(`insert into public.organisation_members values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')`, [ORG, OWNER, ADMIN, MEMBER]);
  await db.query(`insert into public.projects (id, user_id, organisation_id, name, url, domain) values ($1, $2, $3, 'p', 'https://p.example.com', 'p.example.com')`, [P, OWNER, ORG]);
});

test('membership, project and Search Console changes are recorded automatically, with who did it', async () => {
  await asUser(db, OWNER, () => db.query(`insert into public.organisation_members values ($1, $2, 'viewer')`, [ORG, CAND]));
  await asUser(db, OWNER, () => db.query(`update public.organisation_members set role = 'member' where user_id = $1`, [CAND]));
  await asUser(db, OWNER, () => db.query(`delete from public.organisation_members where user_id = $1`, [CAND]));
  await db.query(`update public.projects set verified = true where id = $1`, [P]);
  await db.query(`insert into public.gsc_tokens (project_id, token_enc) values ($1, 'ciphertext-should-not-appear')`, [P]);
  await db.query(`update public.gsc_tokens set token_enc = 'another-ciphertext' where project_id = $1`, [P]);
  await db.query(`delete from public.gsc_tokens where project_id = $1`, [P]);
  const a = await actions();
  for (const want of ['member.added', 'member.role_changed', 'member.removed', 'project.created', 'project.verified_changed', 'gsc.connected', 'gsc.token_replaced', 'gsc.disconnected']) assert.ok(a.includes(want), `${want} in ${a}`);
  const added = (await rows(`select * from public.audit_log where action = 'member.added' and target_id = $1`, [CAND]))[0];
  assert.equal(added.actor, OWNER); assert.equal(added.detail.role, 'viewer');
  const changed = (await rows(`select * from public.audit_log where action = 'member.role_changed'`))[0];
  assert.deepEqual([changed.detail.from, changed.detail.to], ['viewer', 'member']);
});
test('no secret ever reaches the trail: token values are not stored and secret-looking keys are stripped', async () => {
  const all = JSON.stringify(await rows('select * from public.audit_log'));
  assert.doesNotMatch(all, /ciphertext/);
  const id = (await rows(`select public.audit_record($1, null, 'test.event', 'x', 'y', $2::jsonb) as id`, [ORG, JSON.stringify({ ok: 1, refresh_token: 'abc', apiKey: 'k', Password: 'p', note: 'fine' })]))[0].id;
  const d = (await rows('select detail from public.audit_log where id = $1', [id]))[0].detail;
  assert.deepEqual(d, { ok: 1, note: 'fine' });
});
test('organisation changes list the columns that changed', async () => {
  await asUser(db, OWNER, () => db.query(`update public.organisations set name = 'A renamed' where id = $1`, [ORG]));
  const r = await last();
  assert.equal(r.action, 'organisation.updated'); assert.deepEqual(r.detail.name, { from: 'A', to: 'A renamed' });
});
test('project deletion is recorded even though the project is gone', async () => {
  await db.query(`insert into public.projects (id, user_id, organisation_id, name, url, domain) values ('b0000000-0000-4000-8000-000000000009', $1, $2, 't', 'https://t.example.com', 't.example.com')`, [OWNER, ORG]);
  await asUser(db, OWNER, () => db.query(`delete from public.projects where id = 'b0000000-0000-4000-8000-000000000009'`));
  const r = (await rows(`select * from public.audit_log where action = 'project.deleted'`))[0];
  assert.equal(r.detail.domain, 't.example.com'); assert.equal(r.actor, OWNER);
});

// ---------------- tamper evidence ----------------
test('the trail is append-only: update, delete and truncate are refused, even for the database owner', async () => {
  await assert.rejects(db.query(`update public.audit_log set action = 'x'`), /append-only/);
  await assert.rejects(db.query('delete from public.audit_log'), /append-only/);
  await assert.rejects(db.query('truncate public.audit_log'), /append-only/);
});
test('nobody can write to it through the API: no role has write privileges, and the function is server-only', async () => {
  await asUser(db, OWNER, async () => {
    await assert.rejects(db.query(`insert into public.audit_log (at, action, prev_hash, hash) values (now(), 'x', 'a', 'b')`), /permission denied/);
    await assert.rejects(db.query(`select public.audit_record(null, null, 'x')`), /permission denied/);
    await assert.rejects(db.query('select public.audit_verify()'), /permission denied/);
  });
  await as(db, 'anon', null, async () => { await assert.rejects(db.query('select 1 from public.audit_log'), /permission denied/); });
  await as(db, 'service_role', null, async () => {
    await assert.rejects(db.query(`insert into public.audit_log (at, action, prev_hash, hash) values (now(), 'x', 'a', 'b')`), /permission denied/);
    assert.ok((await db.query('select * from public.audit_verify()')).rows[0]);
  });
});
test('the hash chain verifies, and tampering (done by disabling the trigger as the owner) is detected at the exact row', async () => {
  const ok = (await rows('select * from public.audit_verify()'))[0];
  assert.equal(ok.first_bad_id, null); assert.ok(Number(ok.checked) >= 10);
  const { id: victim, detail: original } = (await rows(`select id, detail from public.audit_log where action = 'member.added' order by id limit 1`))[0];
  await db.exec('alter table public.audit_log disable trigger audit_log_no_change');
  await db.query(`update public.audit_log set detail = '{"role":"tampered"}' where id = $1`, [victim]);
  await db.exec('alter table public.audit_log enable trigger audit_log_no_change');
  assert.equal(String((await rows('select * from public.audit_verify()'))[0].first_bad_id), String(victim));
  // The monitor turns it into a critical alert.
  await db.query('select public.monitor_run()');
  const a = (await rows(`select * from public.alerts where kind = 'audit_chain_broken'`))[0];
  assert.equal(a.severity, 'critical'); assert.equal(a.subject, String(victim));
  // Put it back so the rest of the file sees an intact chain.
  await db.exec('alter table public.audit_log disable trigger audit_log_no_change');
  await db.query(`update public.audit_log set detail = $2 where id = $1`, [victim, JSON.stringify(original)]);
  await db.exec('alter table public.audit_log enable trigger audit_log_no_change');
  assert.equal((await rows('select * from public.audit_verify()'))[0].first_bad_id, null);
});
test('audit_head returns the newest row\'s id and hash', async () => {
  const head = (await rows('select * from public.audit_head()'))[0];
  const l = await last();
  assert.equal(String(head.id), String(l.id)); assert.equal(head.hash, l.hash);
});

// ---------------- who can read it ----------------
test('owners and admins read their own organisation\'s trail; members and outsiders read nothing; other organisations stay separate', async () => {
  await db.query(`select public.audit_record($1, null, 'other.org.event')`, [ORG2]);
  const own = async (u) => (await asUser(db, u, () => db.query('select organisation_id from public.audit_log'))).rows;
  for (const u of [OWNER, ADMIN]) { const r = await own(u); assert.ok(r.length > 5); assert.ok(r.every((x) => x.organisation_id === ORG), u); }
  for (const u of [MEMBER, OUTSIDER]) assert.equal((await own(u)).length, 0, u);
});

// ---------------- anomalies and alerts ----------------
test('an owner change raises a critical alert, once per day', async () => {
  await db.query(`update public.organisation_members set role = 'owner' where organisation_id = $1 and user_id = $2`, [ORG, MEMBER]);
  assert.ok(Number((await rows('select public.monitor_run() as n'))[0].n) >= 1);
  const a = (await rows(`select * from public.alerts where kind = 'owner_changed'`));
  assert.equal(a.length, 1); assert.equal(a[0].severity, 'critical'); assert.equal(a[0].organisation_id, ORG);
  assert.equal(Number((await rows('select public.monitor_run() as n'))[0].n), 0, 'the same condition is not alerted twice in a day');
  await db.query(`update public.organisation_members set role = 'member' where organisation_id = $1 and user_id = $2`, [ORG, MEMBER]);
});
test('repeated denied access by one person is flagged as probing; a few are not', async () => {
  for (let i = 0; i < 5; i++) await db.query(`select public.audit_record(null, $1, 'access.denied', 'project', $2, '{"status":404}')`, [CAND, 'p' + i]);
  assert.equal((await rows(`select * from public.audit_anomalies() where kind = 'access_probing'`)).length, 0);
  for (let i = 0; i < 20; i++) await db.query(`select public.audit_record(null, $1, 'access.denied', 'project', $2, '{"status":404}')`, [CAND, 'q' + i]);
  const a = await rows(`select * from public.audit_anomalies() where kind = 'access_probing'`);
  assert.equal(a.length, 1); assert.equal(a[0].subject, CAND); assert.ok(Number(a[0].n) > 20);
});
test('bulk membership changes and bulk project deletion are flagged', async () => {
  for (let i = 0; i < 12; i++) await db.query(`select public.audit_record($1, null, 'member.added', 'user', $2, '{}')`, [ORG2, 'u' + i]);
  for (let i = 0; i < 4; i++) await db.query(`select public.audit_record($1, null, 'project.deleted', 'project', $2, '{}')`, [ORG2, 'p' + i]);
  const k = (await rows('select kind from public.audit_anomalies()')).map((r) => r.kind);
  assert.ok(k.includes('many_membership_changes') && k.includes('many_projects_deleted'), String(k));
});
test('alerts are server-only', async () => {
  await asUser(db, OWNER, async () => { await assert.rejects(db.query('select 1 from public.alerts'), /permission denied/); });
  await as(db, 'service_role', null, async () => { assert.ok((await db.query('select 1 from public.alerts')).rows.length > 0); });
});
