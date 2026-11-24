// REAL-POSTGRES tests of the last-owner guard (migrations 0011 and 0013). Needs TEST_DATABASE_URL (see tests/helpers/realdb.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, setup, conn, sleep, settledWithin } from '../helpers/realdb.mjs';

let admin, seq = 0;
const uid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
before(async () => { if (skip) return; admin = await setup(); });
after(async () => { if (admin) await admin.end(); });

// An organisation with `owners` owners and one member. Returns the ids.
async function makeOrg(owners = 2) {
  const org = (await admin.query(`insert into public.organisations (name) values ('o') returning id`)).rows[0].id;
  const people = [];
  for (let i = 0; i < owners + 1; i++) { const u = uid(++seq); await admin.query('insert into auth.users (id) values ($1)', [u]); people.push(u); }
  for (let i = 0; i < owners; i++) await admin.query(`insert into public.organisation_members values ($1, $2, 'owner')`, [org, people[i]]);
  await admin.query(`insert into public.organisation_members values ($1, $2, 'member')`, [org, people[owners]]);
  return { org, owners: people.slice(0, owners), member: people[owners] };
}
const ownerCount = async (org) => Number((await admin.query(`select count(*) as n from public.organisation_members where organisation_id = $1 and role = 'owner'`, [org])).rows[0].n);

test('two owners removing each other at the same time: the second is made to wait, then refused', { skip }, async () => {
  const { org, owners } = await makeOrg(2);
  const [a, b] = [await conn(), await conn()];
  try {
    await a.query('begin'); await b.query('begin');
    await a.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, owners[0]]);
    const second = b.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, owners[1]]);
    assert.equal(await settledWithin(second, 400), 'pending', 'the second owner removal must wait for the first');
    await a.query('commit');
    const outcome = await settledWithin(second, 2000);
    assert.ok(outcome !== 'pending' && outcome.err && /at least one owner/.test(outcome.err.message), JSON.stringify(outcome.err && outcome.err.message));
    await b.query('rollback');
    assert.equal(await ownerCount(org), 1, 'the organisation still has an owner');
  } finally { await a.end(); await b.end(); }
});

test('an owner deleting themselves while the other demotes themselves: never ownerless', { skip }, async () => {
  const { org, owners } = await makeOrg(2);
  const [a, b] = [await conn(), await conn()];
  try {
    await a.query('begin'); await b.query('begin');
    await a.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, owners[0]]);
    const second = b.query(`update public.organisation_members set role = 'admin' where organisation_id = $1 and user_id = $2`, [org, owners[1]]);
    assert.equal(await settledWithin(second, 400), 'pending');
    await a.query('commit');
    const outcome = await settledWithin(second, 2000);
    assert.ok(outcome !== 'pending' && outcome.err, 'the demotion must be refused');
    await b.query('rollback');
    assert.equal(await ownerCount(org), 1);
  } finally { await a.end(); await b.end(); }
});

test('many simultaneous attempts to remove or demote the last two owners: at least one owner always remains, and exactly one attempt wins', { skip }, async () => {
  for (let round = 0; round < 15; round++) {
    const { org, owners } = await makeOrg(2);
    const [a, b] = [await conn(), await conn()];
    try {
      const attempt = (c, u, kind) => (kind === 'delete'
        ? c.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, u])
        : c.query(`update public.organisation_members set role = 'viewer' where organisation_id = $1 and user_id = $2`, [org, u])).then(() => 'ok', () => 'refused');
      const results = await Promise.all([attempt(a, owners[0], round % 2 ? 'delete' : 'demote'), attempt(b, owners[1], round % 3 ? 'demote' : 'delete')]);
      assert.deepEqual([...results].sort(), ['ok', 'refused'], `round ${round}: ${results}`);
      assert.equal(await ownerCount(org), 1, `round ${round}`);
    } finally { await a.end(); await b.end(); }
  }
});

test('people can still leave: a non-last owner, any member, and the only person in an organisation', { skip }, async () => {
  const { org, owners, member } = await makeOrg(2);
  await admin.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, member]);   // a member leaves
  await admin.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, owners[0]]); // one of two owners leaves
  assert.equal(await ownerCount(org), 1);
  // The last owner may leave once nobody else is in the organisation.
  await admin.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, owners[1]]);
  assert.equal(Number((await admin.query('select count(*) as n from public.organisation_members where organisation_id = $1', [org])).rows[0].n), 0);
});

test('the last owner cannot leave while others remain, even in one statement removing both owners', { skip }, async () => {
  const { org } = await makeOrg(2);
  await assert.rejects(admin.query(`delete from public.organisation_members where organisation_id = $1 and role = 'owner'`, [org]), /at least one owner/);
  assert.equal(await ownerCount(org), 2, 'the refused statement changed nothing');
});

test('the owner lock does not block ordinary work in the organisation (projects, new members)', { skip }, async () => {
  const { org, owners } = await makeOrg(2);
  const [a, b] = [await conn(), await conn()];
  // The audit trail (0014) has its own single-writer lock, held to the end of a transaction. Switch its triggers off here so this test
  // looks only at the organisation lock; the audit lock is covered in audit-budget-concurrency.test.mjs and documented in TECHNICAL_DEBT.md.
  await admin.query('alter table public.projects disable trigger audit_projects; alter table public.organisation_members disable trigger audit_members');
  try {
    await a.query('begin');
    await a.query('delete from public.organisation_members where organisation_id = $1 and user_id = $2', [org, owners[0]]);  // holds the organisation lock
    const u = uid(++seq); await admin.query('insert into auth.users (id) values ($1)', [u]);
    const project = b.query(`insert into public.projects (user_id, organisation_id, name, url, domain) values ($1, $2, 'p', 'https://p.example.com', 'p.example.com')`, [u, org]);
    const member = b.query(`insert into public.organisation_members values ($1, $2, 'viewer')`, [org, u]);
    assert.notEqual(await settledWithin(project, 1500), 'pending', 'creating a project must not wait');
    assert.notEqual(await settledWithin(member, 1500), 'pending', 'adding a member must not wait');
    await a.query('commit');
  } finally {
    await admin.query('alter table public.projects enable trigger audit_projects; alter table public.organisation_members enable trigger audit_members');
    await a.end(); await b.end();
  }
});
