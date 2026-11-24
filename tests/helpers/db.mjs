// Builds a throwaway Postgres (PGlite, WebAssembly, no install needed) from the real migration files and gives
// tests a way to act as a signed-in user, the anon role, or the service role, the same way Supabase does.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../supabase/migrations');
export const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

// What Supabase provides before our migrations run: roles, the auth schema, auth.uid().
export const SUPABASE_STUB = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

export async function createDb({ only } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const f of migrationFiles()) {
    if (only && !only.includes(f)) continue;
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return db;
}

// Runs fn as the given role. For 'authenticated', uid is the user the JWT would name.
export async function as(db, role, uid, fn) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${uid || ''}', false);`);
  try { return await fn(db); }
  finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
export const asUser = (db, uid, fn) => as(db, 'authenticated', uid, fn);

export const U1 = '11111111-1111-4111-8111-111111111111';
export const U2 = '22222222-2222-4222-8222-222222222222';

// Two customers, each with one verified project and a row in every customer-owned table.
export async function seedTwoTenants(db) {
  await db.exec(`insert into auth.users (id) values ('${U1}'), ('${U2}')`);
  const mk = async (uid, domain) => (await db.query(
    `insert into public.projects (user_id, name, url, domain, keywords, locations, verified, verified_at)
     values ($1, $2, $3, $2, '{plumber}', '{pune}', true, now()) returning id`, [uid, domain, 'https://' + domain])).rows[0].id;
  const p1 = await mk(U1, 'one.example.com');
  const p2 = await mk(U2, 'two.example.com');
  for (const p of [p1, p2]) {
    await db.query(`insert into public.competitors (project_id, domain, source) values ($1, 'rival.example.org', 'manual')`, [p]);
    await db.query(`insert into public.serp_results (project_id, day, keyword, position, domain) values ($1, current_date, 'plumber', 1, 'rival.example.org')`, [p]);
    await db.query(`insert into public.scores (project_id, day, domain, is_me, overall) values ($1, current_date, 'x.example.com', true, 50)`, [p]);
    await db.query(`insert into public.reports (project_id, day, summary) values ($1, current_date, '{}')`, [p]);
    await db.query(`insert into public.action_log (project_id, check_name, area, title, baseline) values ($1, 'Title tags', 'seo', 't', '{}')`, [p]);
    await db.query(`insert into public.gsc_connections (project_id, site_url) values ($1, 'sc-domain:x.example.com')`, [p]);
    await db.query(`insert into public.gsc_snapshots (project_id, day, data) values ($1, current_date, '{}')`, [p]);
    await db.query(`insert into public.site_audits (project_id, day, domain, data) values ($1, current_date, 'x.example.com', '{}')`, [p]);
    await db.query(`insert into public.gsc_tokens (project_id, token_enc) values ($1, 'secret-ciphertext')`, [p]);
    await db.query(`insert into public.jobs (project_id, day, kind, domain) values ($1, current_date, 'crawl', 'x.example.com')`, [p]);
  }
  return { p1, p2 };
}

// Makes a PGlite database look like the part of the Supabase client the server code uses (db.rpc), so the real wrapper
// code in lib/queue.js and lib/crawlCache.js can be tested against the real SQL functions.
export function asSupabase(db) {
  return {
    async rpc(fn, args = {}) {
      const keys = Object.keys(args);
      const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const params = keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]));
      try {
        const { rows } = await db.query(sql, params);
        // PostgREST returns the bare value for functions returning one column, and rows for setof/table functions.
        const scalar = rows.length === 1 && Object.keys(rows[0]).length === 1 && Object.keys(rows[0])[0] === fn;
        return { data: scalar ? rows[0][fn] : rows, error: null };
      } catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    },
  };
}
