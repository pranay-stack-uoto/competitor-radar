#!/usr/bin/env node
// Writes an encrypted, checksummed logical backup of the application data (lib/ops/backup.js).
//   SUPABASE_DB_URL=postgres://...  BACKUP_PASSPHRASE='at least 16 characters'  node scripts/backup.mjs [--out backups/] [--no-encrypt]
// Use the DIRECT connection string (Supabase > Project Settings > Database), read-only if you have made such a role.
// Keep the passphrase somewhere other than the backup; without it the file cannot be opened.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
const require = createRequire(import.meta.url);
const { exportData, pack } = require('../lib/ops/backup.js');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const url = process.env.SUPABASE_DB_URL;
if (!url) { console.error('Set SUPABASE_DB_URL to the database connection string.'); process.exit(2); }
const noEncrypt = process.argv.includes('--no-encrypt');
const pass = process.env.BACKUP_PASSPHRASE;
if (!noEncrypt && !pass) { console.error('Set BACKUP_PASSPHRASE (16+ characters), or pass --no-encrypt to store it in the clear (not recommended).'); process.exit(2); }

const client = new pg.Client({ connectionString: url, ssl: /supabase\.(co|com)/.test(url) ? { rejectUnauthorized: false } : undefined });
await client.connect();
try {
  await client.query('begin read only isolation level repeatable read'); // one consistent snapshot of every table
  const data = await exportData(client);
  await client.query('commit');
  const buf = pack(data, noEncrypt ? null : pass);
  const dir = arg('--out') || 'backups';
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `radar-${data.createdAt.replace(/[:.]/g, '-')}.radarbackup`);
  writeFileSync(file, buf, { mode: 0o600 });
  console.log(`Wrote ${file} (${buf.length} bytes, ${noEncrypt ? 'NOT encrypted' : 'encrypted'})`);
  console.log('Rows:', JSON.stringify(data.counts), `accounts listed: ${data.userCount}`);
} finally { await client.end(); }
