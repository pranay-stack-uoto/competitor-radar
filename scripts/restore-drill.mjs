#!/usr/bin/env node
// Proves a backup can be restored. Restores into an EMPTY scratch database (never production), checks row counts, the audit hash chain and
// organisation membership, and prints PASS or FAIL. Run it after every new backup routine and at least quarterly.
//   RESTORE_DATABASE_URL=postgres://...scratch  BACKUP_PASSPHRASE=...  node scripts/restore-drill.mjs backups/radar-....radarbackup
// The scratch database must be a throw-away Postgres where you are a superuser (docker, local, or a temporary Supabase branch). The script
// refuses anything that looks like a hosted production database, applies the migrations itself, then loads the data.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { unpack, restoreData, verifyRestore } = require('../lib/ops/backup.js');

const file = process.argv[2], url = process.env.RESTORE_DATABASE_URL;
if (!file || !url) { console.error('Usage: RESTORE_DATABASE_URL=... BACKUP_PASSPHRASE=... node scripts/restore-drill.mjs <backup file>'); process.exit(2); }
if (/supabase\.(co|com)|pooler\.|amazonaws\.com|neon\.tech/i.test(url) && process.env.I_UNDERSTAND_THIS_IS_A_SCRATCH_DATABASE !== 'yes') {
  console.error('That looks like a hosted database. Use a throw-away scratch database, or set I_UNDERSTAND_THIS_IS_A_SCRATCH_DATABASE=yes if it really is one.'); process.exit(2);
}
const data = unpack(readFileSync(file), process.env.BACKUP_PASSPHRASE);
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '../supabase/migrations');
const client = new pg.Client({ connectionString: url }); await client.connect();
try {
  const { rows: [{ n }] } = await client.query(`select count(*)::int as n from information_schema.tables where table_schema = 'public'`);
  if (n) throw new Error('The scratch database is not empty (it already has tables in the public schema).');
  // What Supabase provides before the migrations (roles, auth schema); harmless if they already exist.
  await client.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if; end $$;
    create schema if not exists auth; create table if not exists auth.users (id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
    grant usage on schema auth to anon, authenticated, service_role; grant usage on schema public to anon, authenticated, service_role;`);
  for (const f of readdirSync(dir).filter((x) => /^\d+_.+\.sql$/.test(x)).sort()) await client.query(readFileSync(path.join(dir, f), 'utf8'));
  await restoreData(client, data);
  const result = await verifyRestore(client, data);
  console.log(result.ok ? 'PASS' : 'FAIL', JSON.stringify({ backupCreatedAt: data.createdAt, tables: Object.keys(data.counts).length, rows: Object.values(data.counts).reduce((a, b) => a + b, 0), problems: result.problems }));
  process.exit(result.ok ? 0 : 1);
} finally { await client.end(); }
