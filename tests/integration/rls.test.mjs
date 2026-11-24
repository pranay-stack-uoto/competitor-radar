// Tenant isolation and least-privilege tests. They run the real migrations in an in-process Postgres and act as
// different database roles, exactly as Supabase does for the browser (authenticated, anon) and the server (service_role).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, asUser, seedTwoTenants, U1, U2 } from '../helpers/db.mjs';

let db, p1, p2;
before(async () => { db = await createDb(); ({ p1, p2 } = await seedTwoTenants(db)); });

const count = async (sql, params) => Number((await db.query(sql, params)).rows[0].n);

const CUSTOMER_TABLES = ['competitors', 'serp_results', 'scores', 'reports', 'action_log', 'gsc_connections', 'gsc_snapshots', 'site_audits'];

test('a user reads only their own project', async () => {
  await asUser(db, U1, async () => {
    const rows = (await db.query('select id from public.projects')).rows;
    assert.deepEqual(rows.map((r) => r.id), [p1]);
  });
});

for (const t of CUSTOMER_TABLES) {
  test(`${t}: a user cannot read another customer's rows`, async () => {
    await asUser(db, U1, async () => {
      assert.equal(await count(`select count(*) n from public.${t} where project_id = $1`, [p2]), 0);
      assert.equal(await count(`select count(*) n from public.${t} where project_id = $1`, [p1]), 1);
    });
  });
}

test('jobs and gsc_tokens are not readable from the browser at all', async () => {
  await asUser(db, U1, async () => {
    await assert.rejects(db.query('select * from public.jobs'), /permission denied/);
    await assert.rejects(db.query('select token_enc from public.gsc_tokens'), /permission denied/);
  });
});

test('the anon role cannot read any table', async () => {
  await as(db, 'anon', null, async () => {
    for (const t of ['projects', ...CUSTOMER_TABLES]) await assert.rejects(db.query(`select * from public.${t}`), /permission denied/, t);
  });
});

test('SEC-01: a user cannot verify their own project', async () => {
  await asUser(db, U1, async () => {
    await assert.rejects(db.query('update public.projects set verified = true where id = $1', [p1]), /permission denied/);
    await assert.rejects(db.query(`update public.projects set verify_token = 'x' where id = $1`, [p1]), /permission denied/);
    await assert.rejects(db.query('update public.projects set max_competitors = 25 where id = $1', [p1]), /permission denied/);
  });
});

test('SEC-01: a project cannot be created already verified', async () => {
  await asUser(db, U1, async () => {
    await assert.rejects(db.query(`insert into public.projects (user_id, name, url, domain, verified) values ($1, 'a', 'https://a.example.com', 'a.example.com', true)`, [U1]), /permission denied/);
    // The same row without the privileged column is accepted, and starts unverified.
    const r = await db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'a', 'https://a.example.com', 'a.example.com') returning verified`, [U1]);
    assert.equal(r.rows[0].verified, false);
    await db.query(`delete from public.projects where domain = 'a.example.com'`);
  });
});

test('a user cannot create a project for someone else', async () => {
  await asUser(db, U1, async () => {
    await assert.rejects(db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'b', 'https://b.example.com', 'b.example.com')`, [U2]), /row-level security/);
  });
});

test('a user can edit the fields the product lets them edit', async () => {
  await asUser(db, U1, async () => {
    const r = await db.query(`update public.projects set keywords = '{a,b}', locations = '{x}', summary = 'hello' where id = $1 returning keywords`, [p1]);
    assert.equal(r.rows.length, 1);
  });
});

test("a user cannot change another customer's project", async () => {
  await asUser(db, U1, async () => {
    const r = await db.query(`update public.projects set keywords = '{hacked}' where id = $1 returning id`, [p2]);
    assert.equal(r.rows.length, 0);
    const d = await db.query('delete from public.projects where id = $1 returning id', [p2]);
    assert.equal(d.rows.length, 0);
  });
  assert.equal(await count(`select count(*) n from public.projects where id = $1`, [p2]), 1);
});

test('SEC-03: keyword and location lists are bounded', async () => {
  const many = (n) => `{${Array.from({ length: n }, (_, i) => 'kw' + i).join(',')}}`;
  await asUser(db, U1, async () => {
    await assert.rejects(db.query('update public.projects set keywords = $2 where id = $1', [p1, many(31)]), /projects_keywords_limit/);
    await assert.rejects(db.query('update public.projects set locations = $2 where id = $1', [p1, many(13)]), /projects_locations_limit/);
    await assert.rejects(db.query('update public.projects set keywords = $2 where id = $1', [p1, `{${'x'.repeat(121)}}`]), /projects_keywords_limit/);
    await db.query('update public.projects set keywords = $2 where id = $1', [p1, many(30)]);
  });
});

// A name that merely looks public can still resolve to a private address (for example 127.0.0.1.nip.io).
// The database cannot know that. Resolution is checked by the crawler's SSRF guard (tests/unit/ssrf.test.mjs).
test('SEC-02 (first line): the project domain must be a real-looking hostname', async () => {
  await asUser(db, U1, async () => {
    for (const bad of ['localhost', '169.254.169.254', '10.0.0.1', 'example.com:8080', 'example.com/path', 'user@example.com', 'EXAMPLE.com', 'a b.com', '[::1]']) {
      await assert.rejects(db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'x', 'https://x', $2)`, [U1, bad]), /projects_domain_format|invalid|violates/, bad);
    }
    await db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'ok', 'https://ok.co.in', 'ok.co.in')`, [U1]);
    await db.query(`delete from public.projects where domain = 'ok.co.in'`);
  });
});

test('competitors: a user can hide a competitor but not insert or rewrite scoring fields', async () => {
  await asUser(db, U1, async () => {
    const ok = await db.query(`update public.competitors set status = 'ignored' where project_id = $1 returning id`, [p1]);
    assert.equal(ok.rows.length, 1);
    await assert.rejects(db.query(`update public.competitors set serp_score = 999 where project_id = $1`, [p1]), /permission denied/);
    await assert.rejects(db.query(`update public.competitors set project_id = $1 where project_id = $2`, [p2, p1]), /permission denied/);
    await assert.rejects(db.query(`insert into public.competitors (project_id, domain) values ($1, 'new.example.org')`, [p1]), /permission denied/);
    const other = await db.query(`update public.competitors set status = 'ignored' where project_id = $1 returning id`, [p2]);
    assert.equal(other.rows.length, 0);
  });
});

test('read-only tables cannot be written from the browser', async () => {
  await asUser(db, U1, async () => {
    for (const t of ['scores', 'reports', 'serp_results', 'gsc_connections', 'gsc_snapshots', 'site_audits']) {
      await assert.rejects(db.query(`delete from public.${t} where project_id = $1`, [p1]), /permission denied/, t);
    }
    await assert.rejects(db.query(`update public.scores set overall = 100 where project_id = $1`, [p1]), /permission denied/);
  });
});

test('action_log: a user can mark and undo fixes on their own project only', async () => {
  await asUser(db, U1, async () => {
    await db.query(`insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'HTTPS', 'seo', 't', '{}')`, [p1]);
    await assert.rejects(db.query(`insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'HTTPS', 'seo', 't', '{}')`, [p2]), /row-level security/);
    assert.equal((await db.query(`delete from public.action_log where project_id = $1 and check_name = 'HTTPS' returning 1`, [p1])).rows.length, 1);
    assert.equal((await db.query(`delete from public.action_log where project_id = $1 returning 1`, [p2])).rows.length, 0);
  });
});

test('the service role can do the server-side writes the app needs', async () => {
  await as(db, 'service_role', null, async () => {
    await db.query('update public.projects set verified = true, max_competitors = 12 where id = $1', [p1]);
    await db.query(`insert into public.jobs (project_id, day, kind) values ($1, current_date, 'discover')`, [p1]);
    assert.ok(await count('select count(*) n from public.gsc_tokens') >= 2);
  });
});

test('owns_project() answers only about the caller', async () => {
  await asUser(db, U1, async () => {
    assert.equal((await db.query('select public.owns_project($1) as o', [p1])).rows[0].o, true);
    assert.equal((await db.query('select public.owns_project($1) as o', [p2])).rows[0].o, false);
  });
});

// The exact calls the browser makes today (onboarding.js, panels.js, dashboard.js, lib/fixes.js, lib/data.js).
test('compatibility: the browser flows the app already uses keep working', async () => {
  await asUser(db, U1, async () => {
    const ins = await db.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'new.example.com', 'https://new.example.com', 'new.example.com') returning *`, [U1]);
    const id = ins.rows[0].id;
    assert.equal(typeof ins.rows[0].verify_token, 'string');
    await db.query(`update public.projects set keywords = '{a}', locations = '{b}', summary = 's' where id = $1`, [id]);
    await db.query(`update public.competitors set status = 'active', source = 'manual' where project_id = $1`, [p1]);
    const up = `insert into public.action_log (project_id, check_name, area, title, done_at, baseline) values ($1, 'Canonical tags', 'seo', 't', now(), '{}')
                on conflict (project_id, check_name) do update set title = excluded.title, done_at = excluded.done_at, baseline = excluded.baseline`;
    await db.query(up, [p1]); await db.query(up, [p1]);
    await db.query(`delete from public.action_log where project_id = $1 and check_name = 'Canonical tags'`, [p1]);
    await db.query('select * from public.projects order by created_at');
    await db.query('select * from public.competitors where project_id = $1 order by serp_score desc', [p1]);
    await db.query('delete from public.projects where id = $1', [id]);
  });
});
