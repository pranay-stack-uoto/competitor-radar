// Organisations, members and roles (migration 0011): who can see and change what, across organisations and inside one.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser } from '../helpers/db.mjs';

const U = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`;
const [OWNER, ADMIN, MEMBER, VIEWER, OUTSIDER, CAND1, CAND2, OTHER_OWNER] = ['1', '2', '3', '4', '5', '6', '7', '8'].map(U);
const ORG_X = 'a0000000-0000-4000-8000-000000000001', ORG_Y = 'a0000000-0000-4000-8000-000000000002';
const PX = 'b0000000-0000-4000-8000-000000000001', PY = 'b0000000-0000-4000-8000-000000000002';

let db;
before(async () => {
  db = await createDb();
  for (const u of [OWNER, ADMIN, MEMBER, VIEWER, OUTSIDER, CAND1, CAND2, OTHER_OWNER]) await db.query('insert into auth.users (id) values ($1)', [u]);
  await db.query(`insert into public.organisations (id, name, type) values ($1, 'Org X', 'business'), ($2, 'Org Y', 'agency')`, [ORG_X, ORG_Y]);
  for (const [u, r] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member'], [VIEWER, 'viewer']]) await db.query('insert into public.organisation_members values ($1, $2, $3)', [ORG_X, u, r]);
  await db.query(`insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')`, [ORG_Y, OTHER_OWNER]);
  for (const [p, o, creator] of [[PX, ORG_X, OWNER], [PY, ORG_Y, OTHER_OWNER]]) {
    await db.query(`insert into public.projects (id, user_id, organisation_id, name, url, domain, verified) values ($1, $2, $3, 'p', 'https://p.example.com', $4, true)`, [p, creator, o, p === PX ? 'x.example.com' : 'y.example.com']);
    await db.query(`insert into public.competitors (project_id, domain, source) values ($1, 'rival.example.org', 'manual')`, [p]);
    await db.query(`insert into public.scores (project_id, day, domain, is_me, overall) values ($1, current_date, 'x.example.com', true, 50)`, [p]);
    await db.query(`insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'Title tags', 'seo', 't', '{}')`, [p]);
  }
});

const run = (uid, sql, params) => asUser(db, uid, async () => (await db.query(sql, params)));
const rows = async (uid, sql, params) => (await run(uid, sql, params)).rows;
const changed = async (uid, sql, params) => (await run(uid, sql, params)).affectedRows;
const refused = (uid, sql, params) => asUser(db, uid, () => assert.rejects(db.query(sql, params), /row-level security|permission denied|at least one owner/));
const roleOf = async (org, user) => (await db.query('select role from public.organisation_members where organisation_id = $1 and user_id = $2', [org, user])).rows[0]?.role ?? null;

// ---------------- reading ----------------
test('every role reads the organisation\'s project and its data; an outsider reads nothing', async () => {
  for (const u of [OWNER, ADMIN, MEMBER, VIEWER]) {
    assert.equal((await rows(u, 'select id from public.projects')).length, 1, u);
    for (const t of ['competitors', 'scores', 'action_log']) assert.equal((await rows(u, `select 1 from public.${t}`)).length, 1, `${u} ${t}`);
    assert.equal((await rows(u, 'select 1 from public.organisations')).length, 1);
    assert.equal((await rows(u, 'select 1 from public.organisation_members')).length, 4);
  }
  for (const t of ['projects', 'competitors', 'scores', 'action_log', 'organisations', 'organisation_members']) assert.equal((await rows(OUTSIDER, `select 1 from public.${t}`)).length, 0, t);
});

test('role helpers answer correctly for each role', async () => {
  const ask = async (u) => (await rows(u, 'select public.project_role($1) as r, public.owns_project($1) as w, public.can_admin_project($1) as a, public.can_view_project($1) as v', [PX]))[0];
  assert.deepEqual(await ask(OWNER), { r: 'owner', w: true, a: true, v: true });
  assert.deepEqual(await ask(ADMIN), { r: 'admin', w: true, a: true, v: true });
  assert.deepEqual(await ask(MEMBER), { r: 'member', w: true, a: false, v: true });
  assert.deepEqual(await ask(VIEWER), { r: 'viewer', w: false, a: false, v: true });
  assert.deepEqual(await ask(OUTSIDER), { r: null, w: false, a: false, v: false });
  assert.equal((await rows(OWNER, 'select public.project_role($1) as r', [PY]))[0].r, null);
});

test('asking about another person\'s role is server-only', async () => {
  await asUser(db, OWNER, async () => {
    await assert.rejects(db.query('select public.project_role_for($1, $2)', [PX, MEMBER]), /permission denied/);
    await assert.rejects(db.query('select public.org_role_for($1, $2)', [ORG_X, MEMBER]), /permission denied/);
  });
  await as(db, 'anon', null, async () => { await assert.rejects(db.query('select public.project_role($1)', [PX]), /permission denied/); });
  await as(db, 'service_role', null, async () => {
    assert.equal((await db.query('select public.project_role_for($1, $2) as r', [PX, MEMBER])).rows[0].r, 'member');
    assert.equal((await db.query('select public.project_role_for($1, $2) as r', [PX, OUTSIDER])).rows[0].r, null);
  });
});

// ---------------- project work, by role ----------------
test('viewer is read-only: cannot edit the project, hide a competitor or change the fix log', async () => {
  assert.equal(await changed(VIEWER, `update public.projects set name = 'hacked'`), 0);
  assert.equal(await changed(VIEWER, `update public.competitors set status = 'ignored'`), 0);
  assert.equal(await changed(VIEWER, `update public.action_log set title = 'x'`), 0);
  assert.equal(await changed(VIEWER, `delete from public.action_log`), 0);
  await refused(VIEWER, `insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'a', 'seo', 't', '{}')`, [PX]);
  assert.equal(await changed(VIEWER, 'delete from public.projects'), 0);
  assert.equal((await db.query(`select name from public.projects where id = $1`, [PX])).rows[0].name, 'p');
});

test('member does normal project work but cannot delete the project or manage people', async () => {
  assert.equal(await changed(MEMBER, `update public.projects set name = 'renamed', keywords = '{a,b}'`), 1);
  assert.equal(await changed(MEMBER, `update public.competitors set status = 'ignored'`), 1);
  assert.equal(await changed(MEMBER, `update public.competitors set status = 'active'`), 1);
  await run(MEMBER, `insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'Another', 'seo', 't', '{}')`, [PX]);
  assert.equal(await changed(MEMBER, `delete from public.action_log where check_name = 'Another'`), 1);
  assert.equal(await changed(MEMBER, 'delete from public.projects'), 0, 'deleting a project is administration');
  await refused(MEMBER, `insert into public.organisation_members values ($1, $2, 'viewer')`, [ORG_X, CAND1]);
  assert.equal(await changed(MEMBER, `update public.organisation_members set role = 'viewer' where user_id = $1`, [VIEWER]), 0);
  assert.equal(await changed(MEMBER, `delete from public.organisation_members where user_id = $1`, [VIEWER]), 0);
  assert.equal(await changed(MEMBER, `update public.organisations set name = 'mine'`), 0);
  await db.query(`update public.projects set name = 'p', keywords = '{}' where id = $1`, [PX]);
});

test('no role can change the columns that are server-only: verified, organisation_id, user_id', async () => {
  for (const u of [OWNER, ADMIN, MEMBER]) {
    await refused(u, `update public.projects set verified = true`);
    await refused(u, `update public.projects set organisation_id = $1`, [ORG_Y]);
    await refused(u, `update public.projects set user_id = $1`, [u]);
  }
});

test('admin can delete a project; the data goes with it; others cannot', async () => {
  const [{ id }] = (await db.query(`insert into public.projects (user_id, organisation_id, name, url, domain) values ($1, $2, 'tmp', 'https://tmp.example.com', 'tmp.example.com') returning id`, [OWNER, ORG_X])).rows;
  await db.query(`insert into public.competitors (project_id, domain) values ($1, 'c.example.org')`, [id]);
  assert.equal(await changed(MEMBER, 'delete from public.projects where id = $1', [id]), 0);
  assert.equal(await changed(VIEWER, 'delete from public.projects where id = $1', [id]), 0);
  assert.equal(await changed(ADMIN, 'delete from public.projects where id = $1', [id]), 1);
  assert.equal((await db.query('select 1 from public.competitors where project_id = $1', [id])).rows.length, 0);
});

// ---------------- cross-organisation isolation ----------------
test('a member of one organisation cannot see, change or add anything in another', async () => {
  assert.deepEqual((await rows(OTHER_OWNER, 'select id from public.projects')).map((r) => r.id), [PY]);
  assert.equal(await changed(OTHER_OWNER, `update public.projects set name = 'y2' where id = $1`, [PY]), 1);
  for (const u of [OWNER, ADMIN, MEMBER, VIEWER]) {
    assert.equal((await rows(u, 'select 1 from public.projects where id = $1', [PY])).length, 0);
    assert.equal(await changed(u, `update public.projects set name = 'pwned' where id = $1`, [PY]), 0);
    assert.equal(await changed(u, `update public.competitors set status = 'ignored' where project_id = $1`, [PY]), 0);
    assert.equal(await changed(u, 'delete from public.projects where id = $1', [PY]), 0);
    await refused(u, `insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'a', 'seo', 't', '{}')`, [PY]);
    await refused(u, `insert into public.organisation_members values ($1, $2, 'viewer')`, [ORG_Y, CAND1]);
    assert.equal(await changed(u, `update public.organisation_members set role = 'owner' where organisation_id = $1`, [ORG_Y]), 0);
    assert.equal(await changed(u, `delete from public.organisation_members where organisation_id = $1`, [ORG_Y]), 0);
  }
  assert.equal((await db.query('select name from public.projects where id = $1', [PY])).rows[0].name, 'y2');
  assert.equal(await roleOf(ORG_Y, OTHER_OWNER), 'owner');
});

test('a person who belongs to two organisations sees both, with the right role in each', async () => {
  await db.query(`insert into public.organisation_members values ($1, $2, 'viewer')`, [ORG_Y, ADMIN]);
  try {
    assert.equal((await rows(ADMIN, 'select 1 from public.projects')).length, 2);
    assert.equal((await rows(ADMIN, 'select public.project_role($1) as r', [PY]))[0].r, 'viewer');
    assert.equal(await changed(ADMIN, `update public.projects set name = 'x' where id = $1`, [PY]), 0);
    assert.equal(await changed(ADMIN, `update public.projects set name = 'p' where id = $1`, [PX]), 1);
  } finally { await db.query(`delete from public.organisation_members where organisation_id = $1 and user_id = $2`, [ORG_Y, ADMIN]); }
});

test('removing someone from the organisation removes their access at once', async () => {
  await db.query(`insert into public.organisation_members values ($1, $2, 'member')`, [ORG_X, CAND1]);
  assert.equal((await rows(CAND1, 'select 1 from public.projects')).length, 1);
  assert.equal(await changed(ADMIN, 'delete from public.organisation_members where user_id = $1', [CAND1]), 1);
  assert.equal((await rows(CAND1, 'select 1 from public.projects')).length, 0);
  assert.equal(await changed(CAND1, `update public.projects set name = 'x'`), 0);
});

// ---------------- managing people ----------------
test('admin can add and remove members and viewers, but cannot grant admin or owner', async () => {
  assert.equal(await changed(ADMIN, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'member')`, [ORG_X, CAND1]), 1);
  assert.equal(await changed(ADMIN, `update public.organisation_members set role = 'viewer' where user_id = $1`, [CAND1]), 1);
  await refused(ADMIN, `update public.organisation_members set role = 'admin' where user_id = $1`, [CAND1]);
  await refused(ADMIN, `update public.organisation_members set role = 'owner' where user_id = $1`, [CAND1]);
  await refused(ADMIN, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin')`, [ORG_X, CAND2]);
  await refused(ADMIN, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')`, [ORG_X, CAND2]);
  assert.equal(await roleOf(ORG_X, CAND1), 'viewer');
  assert.equal(await changed(ADMIN, 'delete from public.organisation_members where user_id = $1', [CAND1]), 1);
});

test('admin cannot touch owners or other admins', async () => {
  await db.query(`insert into public.organisation_members values ($1, $2, 'admin')`, [ORG_X, CAND2]);
  assert.equal(await changed(ADMIN, `update public.organisation_members set role = 'viewer' where user_id = $1`, [OWNER]), 0);
  assert.equal(await changed(ADMIN, `update public.organisation_members set role = 'viewer' where user_id = $1`, [CAND2]), 0);
  assert.equal(await changed(ADMIN, 'delete from public.organisation_members where user_id = $1', [OWNER]), 0);
  assert.equal(await changed(ADMIN, 'delete from public.organisation_members where user_id = $1', [CAND2]), 0);
  assert.equal(await roleOf(ORG_X, OWNER), 'owner'); assert.equal(await roleOf(ORG_X, CAND2), 'admin');
  await db.query('delete from public.organisation_members where user_id = $1 and organisation_id = $2', [CAND2, ORG_X]);
});

test('nobody can give themselves a role, whatever they hold', async () => {
  // Members and viewers try to promote themselves.
  for (const u of [MEMBER, VIEWER, ADMIN]) {
    for (const role of ['admin', 'owner']) assert.equal(await changed(u, `update public.organisation_members set role = $2 where user_id = $1`, [u, role]).catch(() => 0), 0, `${u} -> ${role}`);
  }
  // An owner cannot change their own role either, and nobody can add themselves to an organisation.
  assert.equal(await changed(OWNER, `update public.organisation_members set role = 'viewer' where user_id = $1`, [OWNER]), 0);
  await refused(OUTSIDER, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'owner')`, [ORG_X, OUTSIDER]);
  await refused(OUTSIDER, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'viewer')`, [ORG_X, OUTSIDER]);
  await refused(ADMIN, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'member')`, [ORG_Y, ADMIN]);
  assert.equal(await roleOf(ORG_X, MEMBER), 'member'); assert.equal(await roleOf(ORG_X, VIEWER), 'viewer'); assert.equal(await roleOf(ORG_X, ADMIN), 'admin');
  assert.equal(await roleOf(ORG_X, OUTSIDER), null);
});

test('owner can grant any role, including owner, and rename the organisation', async () => {
  await run(OWNER, `insert into public.organisation_members (organisation_id, user_id, role) values ($1, $2, 'admin')`, [ORG_X, CAND1]);
  assert.equal(await changed(OWNER, `update public.organisation_members set role = 'owner' where user_id = $1`, [CAND1]), 1);
  assert.equal(await roleOf(ORG_X, CAND1), 'owner');
  assert.equal(await changed(OWNER, `update public.organisations set name = 'Org X renamed' where id = $1`, [ORG_X]), 1);
  assert.equal(await changed(ADMIN, `update public.organisations set name = 'nope'`), 0);
  // Now there are two owners, so one of them may be demoted; then clean up.
  assert.equal(await changed(OWNER, `update public.organisation_members set role = 'viewer' where user_id = $1`, [CAND1]), 1);
  assert.equal(await changed(OWNER, 'delete from public.organisation_members where user_id = $1', [CAND1]), 1);
  await db.query(`update public.organisations set name = 'Org X' where id = $1`, [ORG_X]);
});

test('an organisation cannot lose its last owner while other people remain, but anyone else can leave', async () => {
  await assert.rejects(db.query(`update public.organisation_members set role = 'admin' where user_id = $1 and organisation_id = $2`, [OWNER, ORG_X]), /at least one owner/);
  await assert.rejects(db.query(`delete from public.organisation_members where user_id = $1 and organisation_id = $2`, [OWNER, ORG_X]), /at least one owner/);
  await refused(OWNER, `delete from public.organisation_members where user_id = $1`, [OWNER]);
  assert.equal(await roleOf(ORG_X, OWNER), 'owner');
  assert.equal(await changed(VIEWER, 'delete from public.organisation_members where user_id = $1', [VIEWER]), 1, 'leaving is always allowed');
  await db.query(`insert into public.organisation_members values ($1, $2, 'viewer')`, [ORG_X, VIEWER]);
});

test('the browser cannot create or delete organisations', async () => {
  await refused(OUTSIDER, `insert into public.organisations (name) values ('mine')`);
  await refused(OWNER, `delete from public.organisations where id = $1`, [ORG_X]);
  await refused(OWNER, `update public.organisations set type = 'agency'`);
});

test('an organisation that still has projects cannot be deleted, even by the server', async () => {
  await assert.rejects(db.query('delete from public.organisations where id = $1', [ORG_X]), /violates RESTRICT/);
});

// ---------------- personal organisations ----------------
test('a person\'s first project creates their personal organisation and makes them its owner, and RETURNING works', async () => {
  const r = await rows(CAND2, `insert into public.projects (user_id, name, url, domain) values ($1, 'mine', 'https://mine.example.com', 'mine.example.com') returning id, organisation_id`, [CAND2]);
  assert.equal(r.length, 1); assert.ok(r[0].organisation_id);
  const org = (await db.query('select * from public.organisations where id = $1', [r[0].organisation_id])).rows[0];
  assert.equal(org.personal_owner, CAND2); assert.equal(org.type, 'business');
  assert.equal(await roleOf(r[0].organisation_id, CAND2), 'owner');
  // The second project joins the same organisation.
  const r2 = await rows(CAND2, `insert into public.projects (user_id, name, url, domain) values ($1, 'two', 'https://two.example.com', 'two.example.com') returning organisation_id`, [CAND2]);
  assert.equal(r2[0].organisation_id, r[0].organisation_id);
  assert.equal((await db.query('select count(*)::int as n from public.organisations where personal_owner = $1', [CAND2])).rows[0].n, 1);
  // And it is invisible to everyone else.
  assert.equal((await rows(OWNER, `select 1 from public.projects where user_id = $1`, [CAND2])).length, 0);
  assert.equal((await rows(CAND2, 'select 1 from public.projects')).length, 2);
});

test('the browser cannot choose the organisation of a new project, nor insert one for someone else', async () => {
  await refused(OUTSIDER, `insert into public.projects (user_id, organisation_id, name, url, domain) values ($1, $2, 'n', 'https://n.example.com', 'n.example.com')`, [OUTSIDER, ORG_X]);
  await refused(OUTSIDER, `insert into public.projects (user_id, name, url, domain) values ($1, 'n', 'https://n.example.com', 'n.example.com')`, [OWNER]);
  await refused(OUTSIDER, `insert into public.projects (user_id, name, url, domain, verified) values ($1, 'n', 'https://n.example.com', 'n.example.com', true)`, [OUTSIDER]);
  assert.equal((await rows(OWNER, 'select 1 from public.projects')).length, 1);
});

test('a project that has not been moved into an organisation still belongs to its creator', async () => {
  await db.exec('alter table public.projects disable trigger projects_assign_organisation');
  const [{ id }] = (await db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'legacy', 'https://legacy.example.com', 'legacy.example.com') returning id`, [OUTSIDER])).rows;
  await db.exec('alter table public.projects enable trigger projects_assign_organisation');
  assert.equal((await db.query('select organisation_id from public.projects where id = $1', [id])).rows[0].organisation_id, null);
  assert.equal((await rows(OUTSIDER, 'select public.project_role($1) as r', [id]))[0].r, 'owner');
  assert.equal((await rows(OUTSIDER, 'select 1 from public.projects where id = $1', [id])).length, 1);
  assert.equal(await changed(OUTSIDER, `update public.projects set name = 'ok' where id = $1`, [id]), 1);
  assert.equal((await rows(OWNER, 'select 1 from public.projects where id = $1', [id])).length, 0);
  assert.equal((await rows(MEMBER, 'select public.project_role($1) as r', [id]))[0].r, null);
});

test('the new tables are protected like the rest: RLS on, no anonymous access', async () => {
  const r = await db.query(`select relname, relrowsecurity from pg_class where relname in ('organisations', 'organisation_members') and relkind = 'r'`);
  assert.equal(r.rows.length, 2); for (const x of r.rows) assert.equal(x.relrowsecurity, true, x.relname);
  await as(db, 'anon', null, async () => {
    for (const t of ['organisations', 'organisation_members']) await assert.rejects(db.query(`select 1 from public.${t}`), /permission denied/, t);
  });
});

test('the last-owner guard takes the organisation lock first (migration 0013), so concurrent removals are serialised', async () => {
  const def = (await db.query(`select pg_get_functiondef('public.guard_last_owner()'::regprocedure) as d`)).rows[0].d;
  assert.match(def, /for no key update/i);
});
