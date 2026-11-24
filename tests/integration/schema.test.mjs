// The database must be reproducible from the repository, and every customer table must be protected.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDb, migrationFiles, MIGRATIONS_DIR } from '../helpers/db.mjs';

let db;
before(async () => { db = await createDb(); });

test('migrations apply cleanly, in order, to an empty database', async () => {
  const names = migrationFiles();
  assert.ok(names.length >= 2);
  assert.equal(names[0], '0001_baseline_schema.sql');
  // numbering has no gaps and no duplicates
  names.forEach((n, i) => assert.equal(Number(n.slice(0, 4)), i + 1, `${n} breaks the sequence`));
});

test('every migration after the baseline can be run twice (re-runnable)', async () => {
  for (const f of migrationFiles().slice(1)) await db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
});

test('every table in the public schema has row-level security on', async () => {
  const r = await db.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  assert.deepEqual(r.rows.map((x) => x.relname), []);
});

test('every customer-owned table is tied to a project with a cascading foreign key', async () => {
  const tables = (await db.query(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'project_id'`)).rows.map((r) => r.table_name);
  assert.ok(tables.length >= 10);
  for (const t of tables) {
    const fk = await db.query(`select 1 from pg_constraint where conrelid = $1::regclass and contype = 'f' and confrelid = 'public.projects'::regclass and confdeltype = 'c'`, [`public.${t}`]);
    assert.equal(fk.rows.length, 1, `${t} needs a cascading FK to projects`);
  }
});

test('every table the browser can read has a select policy decided by the role helpers', async () => {
  const r = await db.query(`select p.tablename, p.qual, exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = p.tablename and c.column_name = 'project_id') as per_project
    from pg_policies p where p.schemaname = 'public' and p.cmd = 'SELECT'`);
  assert.ok(r.rows.length >= 14, `found ${r.rows.length} select policies`);
  for (const row of r.rows) {
    if (row.tablename === 'projects') assert.match(row.qual, /row_project_role/, row.tablename);
    else if (row.tablename === 'legal_consents') assert.match(row.qual, /user_id = auth\.uid\(\)/, row.tablename); // a person's own acceptance record (0023)
    else if (row.per_project) assert.match(row.qual, /can_view_project/, row.tablename); // customer data hangs off a project
    else assert.match(row.qual, /org_role/, row.tablename); // organisation-level data is for members (or owners and admins) only
  }
});

test('server-only tables have no policy and no browser privilege', async () => {
  for (const t of ['jobs', 'gsc_tokens']) {
    const pol = await db.query(`select 1 from pg_policies where schemaname = 'public' and tablename = $1`, [t]);
    assert.equal(pol.rows.length, 0, t);
    const priv = await db.query(`select has_table_privilege('authenticated', $1, 'select') as s, has_table_privilege('anon', $1, 'select') as a`, [`public.${t}`]);
    assert.deepEqual(priv.rows[0], { s: false, a: false }, t);
  }
});

test('the supporting indexes exist', async () => {
  const r = await db.query(`select indexname from pg_indexes where schemaname = 'public'`);
  const have = new Set(r.rows.map((x) => x.indexname));
  for (const i of ['projects_user_domain', 'jobs_queue', 'jobs_project_day_kind', 'scores_project_domain_day']) assert.ok(have.has(i), i);
});
