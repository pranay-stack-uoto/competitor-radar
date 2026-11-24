// Migration 0016: opt-in industry benchmarks with k-anonymity, immediate withdrawal and no identifiers.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser } from '../helpers/db.mjs';

const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const orgId = (n) => `a${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
let db;
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const agg = (industry = 'plumbing') => rows(`select * from public.benchmark_aggregates where industry = $1 order by metric`, [industry]);

// n organisations in an industry, owner uid(n), one project with one "own" score row today.
async function makeOrgs(from, to, industry, { optIn = true, overall = (i) => 40 + i } = {}) {
  for (let i = from; i <= to; i++) {
    await db.query('insert into auth.users (id) values ($1) on conflict do nothing', [uid(i)]);
    await db.query(`insert into public.organisations (id, name, industry, benchmark_opt_in) values ($1, $2, $3, $4)`, [orgId(i), 'Org ' + i, industry, optIn]);
    await db.query(`insert into public.organisation_members values ($1, $2, 'owner')`, [orgId(i), uid(i)]);
    const p = (await db.query(`insert into public.projects (user_id, organisation_id, name, url, domain) values ($1, $2, 'p', 'https://p.example.com', $3) returning id`, [uid(i), orgId(i), `site${i}.example.com`])).rows[0].id;
    await db.query(`insert into public.scores (project_id, day, domain, is_me, overall, seo, geo, local, keywords, method_version) values ($1, current_date, $2, true, $3, $3, $3, $3, $3, 2)`, [p, `site${i}.example.com`, overall(i)]);
  }
}
const refresh = () => db.query('select public.benchmark_refresh(30)');
beforeEach(async () => { db = await createDb(); });

test('five opted-in organisations produce aggregates; four do not (k-anonymity)', async () => {
  await makeOrgs(1, 4, 'plumbing'); await refresh();
  assert.equal((await agg()).length, 0, 'four organisations: nothing is published');
  await makeOrgs(5, 5, 'plumbing'); await refresh();
  const a = await agg(); assert.equal(a.length, 5, 'one row per metric');
  const o = a.find((x) => x.metric === 'overall');
  assert.equal(o.orgs, 5); assert.equal(Number(o.mean), 43); assert.equal(Number(o.p50), 43); assert.equal(Number(o.p25), 42); assert.equal(Number(o.p75), 44);
});
test('organisations that did not opt in are never counted, and cannot be inferred from the numbers', async () => {
  await makeOrgs(1, 5, 'plumbing'); await makeOrgs(6, 20, 'plumbing', { optIn: false, overall: () => 99 }); await refresh();
  const o = (await agg()).find((x) => x.metric === 'overall');
  assert.equal(o.orgs, 5); assert.equal(Number(o.mean), 43, 'the 15 organisations at 99 had no effect');
});
test('industries stay separate, and an organisation without an industry contributes nothing', async () => {
  await makeOrgs(1, 5, 'plumbing'); await makeOrgs(6, 10, 'roofing', { overall: () => 80 });
  await db.query(`update public.organisations set industry = null where id = $1`, [orgId(1)]);
  await refresh();
  assert.equal((await agg('plumbing')).length, 0, 'plumbing dropped to 4');
  assert.equal(Number((await agg('roofing')).find((x) => x.metric === 'overall').mean), 80);
});
test('withdrawal is immediate: when an owner opts out the aggregates are recomputed in the same step', async () => {
  await makeOrgs(1, 6, 'plumbing'); await refresh();
  assert.equal((await agg()).find((x) => x.metric === 'overall').orgs, 6);
  await asUser(db, uid(6), () => db.query(`update public.organisations set benchmark_opt_in = false where id = $1`, [orgId(6)]));
  const o = (await agg()).find((x) => x.metric === 'overall');
  assert.equal(o.orgs, 5); assert.equal(Number(o.mean), 43, 'organisation 6 (score 46) is gone from the mean');
  await asUser(db, uid(5), () => db.query(`update public.organisations set benchmark_opt_in = false where id = $1`, [orgId(5)]));
  assert.equal((await agg()).length, 0, 'below five organisations nothing remains');
});
test('opting in publishes at once and stamps the time', async () => {
  await makeOrgs(1, 5, 'plumbing'); await makeOrgs(6, 6, 'plumbing', { optIn: false }); await refresh();
  assert.equal((await agg()).find((x) => x.metric === 'overall').orgs, 5);
  await asUser(db, uid(6), () => db.query(`update public.organisations set benchmark_opt_in = true where id = $1`, [orgId(6)]));
  assert.equal((await agg()).find((x) => x.metric === 'overall').orgs, 6);
  assert.ok((await rows('select benchmark_opted_at from public.organisations where id = $1', [orgId(6)]))[0].benchmark_opted_at);
});
test('only own-site scores count, one value per organisation, and only the newest scoring method', async () => {
  await makeOrgs(1, 5, 'plumbing');
  // Organisation 1 gets a second project (counted as the organisation's average), a competitor row and an old-method row.
  const p2 = (await db.query(`insert into public.projects (user_id, organisation_id, name, url, domain) values ($1, $2, 'p2', 'https://p2.example.com', 'second.example.com') returning id`, [uid(1), orgId(1)])).rows[0].id;
  await db.query(`insert into public.scores (project_id, day, domain, is_me, overall, seo, geo, local, keywords, method_version) values ($1, current_date, 'second.example.com', true, 61, 61, 61, 61, 61, 2)`, [p2]);
  const p1 = (await rows(`select id from public.projects where organisation_id = $1 and domain <> 'second.example.com'`, [orgId(1)]))[0].id;
  await db.query(`insert into public.scores (project_id, day, domain, is_me, overall, method_version) values ($1, current_date, 'rival.example.org', false, 100, 2)`, [p1]);
  await db.query(`insert into public.scores (project_id, day, domain, is_me, overall, method_version) values ($1, current_date - 1, 'x.example.com', true, 5, 1)`, [p1]);
  await refresh();
  const o = (await agg()).find((x) => x.metric === 'overall');
  assert.equal(o.orgs, 5);
  assert.equal(Number(o.mean), (((41 + 61) / 2) + 42 + 43 + 44 + 45) / 5, 'organisation 1 counts once, as the average of its projects (51)');
  assert.equal((await agg()).filter((x) => x.metric === 'overall').length, 1, 'the method-1 day is not mixed in');
});
test('aggregates carry no identifiers at all', async () => {
  const cols = (await rows(`select column_name from information_schema.columns where table_name = 'benchmark_aggregates' order by 1`)).map((r) => r.column_name);
  assert.deepEqual(cols, ['day', 'industry', 'mean', 'metric', 'orgs', 'p25', 'p50', 'p75']);
  await makeOrgs(1, 5, 'plumbing'); await refresh();
  const blob = JSON.stringify(await agg());
  assert.doesNotMatch(blob, /site\d|Org \d|-0000-4000/);
});

// ---------------- who can read it ----------------
test('a member of an opted-in organisation sees their industry\'s aggregates next to their own value; others see nothing', async () => {
  await makeOrgs(1, 6, 'plumbing'); await makeOrgs(7, 7, 'plumbing', { optIn: false, overall: () => 90 }); await refresh();
  const mine = (await rows(`select id from public.projects where organisation_id = $1`, [orgId(2)]))[0].id;
  const view = async (u, p) => (await asUser(db, u, () => db.query('select * from public.benchmark_for_project($1)', [p]))).rows;
  const a = await view(uid(2), mine);
  assert.equal(a.length, 5); const o = a.find((x) => x.metric === 'overall');
  assert.equal(o.orgs, 6); assert.equal(Number(o.mine), 42);
  // A different organisation's owner cannot read through someone else's project.
  assert.equal((await view(uid(3), mine)).length, 0);
  // An organisation that did NOT opt in gets nothing, even for its own project (reciprocity).
  const notIn = (await rows(`select id from public.projects where organisation_id = $1`, [orgId(7)]))[0].id;
  assert.equal((await view(uid(7), notIn)).length, 0);
  // No industry set: nothing.
  await db.query(`update public.organisations set industry = null where id = $1`, [orgId(2)]);
  assert.equal((await view(uid(2), mine)).length, 0);
});
test('the aggregate table and the refresh function are not reachable by customers or anonymous visitors', async () => {
  await makeOrgs(1, 5, 'plumbing'); await refresh();
  await asUser(db, uid(1), async () => {
    await assert.rejects(db.query('select * from public.benchmark_aggregates'), /permission denied/);
    await assert.rejects(db.query('select public.benchmark_refresh(30)'), /permission denied/);
    await assert.rejects(db.query(`insert into public.benchmark_aggregates values ('x', current_date, 'seo', 9, 1, 1, 1, 1)`), /permission denied/);
  });
  await as(db, 'anon', null, async () => {
    await assert.rejects(db.query('select * from public.benchmark_aggregates'), /permission denied/);
    await assert.rejects(db.query('select * from public.benchmark_for_project($1)', [uid(1)]), /permission denied/);
  });
});
test('only an owner can change participation: admins, members and outsiders cannot', async () => {
  await makeOrgs(1, 1, 'plumbing', { optIn: false });
  for (const [n, role] of [[50, 'admin'], [51, 'member'], [52, 'viewer']]) {
    await db.query('insert into auth.users (id) values ($1)', [uid(n)]);
    await db.query('insert into public.organisation_members values ($1, $2, $3)', [orgId(1), uid(n), role]);
    const r = await asUser(db, uid(n), () => db.query(`update public.organisations set benchmark_opt_in = true where id = $1`, [orgId(1)]));
    assert.equal(r.affectedRows, 0, role);
  }
  await db.query('insert into auth.users (id) values ($1)', [uid(60)]);
  assert.equal((await asUser(db, uid(60), () => db.query(`update public.organisations set benchmark_opt_in = true`))).affectedRows, 0);
  assert.equal((await rows('select benchmark_opt_in from public.organisations where id = $1', [orgId(1)]))[0].benchmark_opt_in, false);
  assert.equal((await asUser(db, uid(1), () => db.query(`update public.organisations set benchmark_opt_in = true where id = $1`, [orgId(1)]))).affectedRows, 1);
});
test('every change of participation is in the audit trail', async () => {
  await makeOrgs(1, 1, 'plumbing', { optIn: false });
  await asUser(db, uid(1), () => db.query(`update public.organisations set benchmark_opt_in = true where id = $1`, [orgId(1)]));
  await asUser(db, uid(1), () => db.query(`update public.organisations set benchmark_opt_in = false where id = $1`, [orgId(1)]));
  const a = await rows(`select actor, detail from public.audit_log where action = 'organisation.updated' and detail ? 'benchmark_opt_in' order by id`);
  assert.equal(a.length, 2); assert.equal(a[0].actor, uid(1)); assert.deepEqual(a[0].detail.benchmark_opt_in, { from: false, to: true });
});
test('industry must be a short plain label', async () => {
  await makeOrgs(1, 1, 'plumbing');
  for (const bad of ['Plumbing', '', 'x'.repeat(61), '<script>', ' leading']) await assert.rejects(db.query(`update public.organisations set industry = $1`, [bad]), /check/i, bad);
  await db.query(`update public.organisations set industry = 'real estate & construction'`);
});
