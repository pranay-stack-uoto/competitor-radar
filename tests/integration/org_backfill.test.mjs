// An existing customer's database, as it is in production today (migrations up to 0010), then migration 0011 is applied on top.
// Everything they own must still be there, unchanged, and they must still be able to use the product.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, as, asUser, seedTwoTenants, migrationFiles, MIGRATIONS_DIR, U1, U2 } from '../helpers/db.mjs';

const M0011 = '0011_organisations.sql';
const sql0011 = () => readFileSync(path.join(MIGRATIONS_DIR, M0011), 'utf8');
const TABLES = ['projects', 'competitors', 'serp_results', 'scores', 'reports', 'action_log', 'gsc_connections', 'gsc_snapshots', 'site_audits', 'gsc_tokens', 'jobs'];
// A fingerprint of every customer row, ignoring only the columns later migrations are allowed to add or fill in (organisation_id from 0011, serp_searched_on from 0022).
const fingerprint = async (db) => {
  const out = {};
  for (const t of TABLES) {
    const cols = (await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name not in ('organisation_id', 'serp_searched_on') order by column_name`, [t])).rows.map((r) => `"${r.column_name}"`);
    out[t] = (await db.query(`select md5(coalesce(string_agg(md5(row(${cols.join(', ')})::text), ',' order by md5(row(${cols.join(', ')})::text)), '')) as h, count(*)::int as n from public.${t}`)).rows[0];
  }
  return out;
};

let db, p1, p2, before_, extra;
before(async () => {
  db = await createDb({ only: migrationFiles().filter((f) => f < M0011) }); // the database as it was before 0011
  ({ p1, p2 } = await seedTwoTenants(db));
  // A third person with a project, and a person with no project at all.
  await db.query(`insert into auth.users (id) values ('33333333-3333-4333-8333-333333333333'), ('44444444-4444-4444-8444-444444444444')`);
  extra = (await db.query(`insert into public.projects (user_id, name, url, domain) values ('33333333-3333-4333-8333-333333333333', 'third', 'https://third.example.com', 'third.example.com') returning id`)).rows[0].id;
  before_ = await fingerprint(db);
});

test('the old database has no organisations, and the browser works as it does today', async () => {
  assert.equal((await db.query(`select to_regclass('public.organisations') as t`)).rows[0].t, null);
  assert.equal((await asUser(db, U1, async () => (await db.query('select id from public.projects')).rows)).length, 1);
});

test('applying 0011 gives every existing customer a personal organisation and puts their projects in it', async () => {
  await db.exec(sql0011());
  const orgs = (await db.query(`select personal_owner, type, name from public.organisations order by personal_owner`)).rows;
  assert.equal(orgs.length, 3, 'one per person with a project; none for the person with no project');
  for (const o of orgs) { assert.equal(o.type, 'business'); assert.equal(o.name, 'Personal workspace'); }
  const proj = (await db.query(`select p.id, p.user_id, p.organisation_id, o.personal_owner, m.role from public.projects p join public.organisations o on o.id = p.organisation_id left join public.organisation_members m on m.organisation_id = o.id and m.user_id = p.user_id`)).rows;
  assert.equal(proj.length, 3);
  for (const r of proj) { assert.equal(r.personal_owner, r.user_id); assert.equal(r.role, 'owner'); }
  assert.equal(Number((await db.query('select count(*) as n from public.projects where organisation_id is null')).rows[0].n), 0, 'the check to run on production before NOT NULL');
  assert.equal((await db.query('select count(*)::int as n from public.organisation_members')).rows[0].n, 3);
});

test('nothing the customer owns was changed, moved or lost', async () => {
  const after = await fingerprint(db);
  assert.deepEqual(after, before_);
});

test('the same people can still see exactly their own data, and nobody else\'s', async () => {
  const mine = (uid, t) => asUser(db, uid, async () => (await db.query(`select * from public.${t}`)).rows);
  assert.deepEqual((await mine(U1, 'projects')).map((r) => r.id), [p1]);
  assert.deepEqual((await mine(U2, 'projects')).map((r) => r.id), [p2]);
  for (const t of ['competitors', 'serp_results', 'scores', 'reports', 'action_log', 'gsc_connections', 'gsc_snapshots', 'site_audits']) {
    assert.equal((await mine(U1, t)).length, 1, t); assert.ok((await mine(U1, t)).every((r) => r.project_id === p1), t);
  }
  assert.equal((await mine('44444444-4444-4444-8444-444444444444', 'projects')).length, 0);
  assert.equal((await mine('33333333-3333-4333-8333-333333333333', 'projects'))[0].id, extra);
});

test('the existing owner can keep working: edit, mark a fix done, hide a competitor, delete a project', async () => {
  await asUser(db, U1, async () => {
    assert.equal((await db.query(`update public.projects set keywords = '{plumber,drain}' returning id`)).rows.length, 1);
    assert.equal((await db.query(`update public.competitors set status = 'ignored' returning project_id`)).rows.length, 1);
    await db.query(`insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'New fix', 'seo', 't', '{}')`, [p1]);
    assert.equal((await db.query(`delete from public.action_log where check_name = 'New fix' returning project_id`)).rows.length, 1);
  });
  await asUser(db, U2, async () => { assert.equal((await db.query(`delete from public.projects returning id`)).rows.length, 1); });
  assert.equal((await db.query('select count(*)::int as n from public.projects')).rows[0].n, 2);
  assert.equal((await db.query('select count(*)::int as n from public.competitors where project_id = $1', [p2])).rows[0].n, 0, 'cascade still works');
});

test('a brand new customer after the migration can sign up and add a project exactly as before', async () => {
  const NEW = '55555555-5555-4555-8555-555555555555';
  await db.query('insert into auth.users (id) values ($1)', [NEW]);
  const r = await asUser(db, NEW, async () => (await db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'new', 'https://new.example.com', 'new.example.com') returning id, verified, organisation_id`, [NEW])).rows);
  assert.equal(r[0].verified, false); assert.ok(r[0].organisation_id);
});

test('0011 is safe to run again: no duplicates, no changes', async () => {
  const snap = async () => ({ orgs: (await db.query('select id, personal_owner from public.organisations order by id')).rows, members: (await db.query('select * from public.organisation_members order by organisation_id, user_id')).rows, projects: (await db.query('select id, organisation_id from public.projects order by id')).rows });
  const first = await snap();
  await db.exec(sql0011()); await db.exec(sql0011());
  assert.deepEqual(await snap(), first);
});

test('the service role (server routes and the daily worker) is unaffected', async () => {
  await as(db, 'service_role', null, async () => {
    assert.equal((await db.query('select count(*)::int as n from public.projects')).rows[0].n, 3);
    assert.equal((await db.query('select count(*)::int as n from public.jobs')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int as n from public.organisations')).rows[0].n, 4);
  });
});

test('migrations after 0011 (0012 to 0016) apply on top of an existing customer\'s data without changing it, and can be applied twice', async () => {
  const later = migrationFiles().filter((f) => f > M0011);
  assert.ok(later.length >= 5, later.join());
  const rows = async () => ({ f: await fingerprint(db), orgs: (await db.query('select id, name, personal_owner, type from public.organisations order by id')).rows });
  const before2 = await rows();
  for (const f of later) await db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  for (const f of later) await db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  assert.deepEqual(await rows(), before2, 'customer data and organisations are exactly as before');
  // New columns have safe defaults: nobody is opted in, no budgets are set, the audit trail only holds what happened after it was installed.
  assert.equal((await db.query('select count(*)::int as n from public.organisations where benchmark_opt_in').then((r) => r.rows[0].n)), 0);
  assert.equal((await db.query('select count(*)::int as n from public.org_budgets').then((r) => r.rows[0].n)), 0);
  assert.equal((await db.query('select first_bad_id from public.audit_verify()').then((r) => r.rows[0].first_bad_id)), null);
  // And the product still works for the existing owner afterwards.
  await asUser(db, U1, async () => {
    assert.equal((await db.query(`update public.projects set keywords = '{a}' returning id`)).rows.length, 1);
    assert.equal((await db.query('select * from public.organisations')).rows.length, 1);
  });
});
