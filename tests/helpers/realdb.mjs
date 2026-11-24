// Shared setup for the tests that need a REAL Postgres server (tests/postgres): several simultaneous connections with real locks and
// real transactions, which the in-process test database (PGlite, one connection) cannot provide. Set TEST_DATABASE_URL to a throw-away
// database. WARNING: setup() drops and recreates the public and auth schemas.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { MIGRATIONS_DIR, migrationFiles, SUPABASE_STUB } from './db.mjs';

export const URL_ = process.env.TEST_DATABASE_URL;
// setup() DROPS the public and auth schemas. Refuse anything that looks like a hosted database unless the operator says it is a throw-away one.
if (URL_ && /supabase\.(co|com)|pooler\.|amazonaws\.com|neon\.tech/i.test(URL_) && process.env.I_UNDERSTAND_THIS_IS_A_SCRATCH_DATABASE !== 'yes') {
  throw new Error('TEST_DATABASE_URL looks like a hosted database. These tests drop schemas: use a throw-away database, or set I_UNDERSTAND_THIS_IS_A_SCRATCH_DATABASE=yes.');
}
export const skip = !URL_ && 'TEST_DATABASE_URL is not set';

export async function setup() {
  const admin = new pg.Client({ connectionString: URL_ }); await admin.connect();
  await admin.query('drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;');
  await admin.query(SUPABASE_STUB);
  for (const f of migrationFiles()) await admin.query(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  return admin;
}
export async function conn() { const c = new pg.Client({ connectionString: URL_ }); await c.connect(); return c; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 'pending' if the promise has not settled within ms, otherwise its outcome.
export async function settledWithin(promise, ms) {
  const tag = Symbol('pending');
  const r = await Promise.race([promise.then((v) => ({ ok: v }), (e) => ({ err: e })), sleep(ms).then(() => tag)]);
  return r === tag ? 'pending' : r;
}
