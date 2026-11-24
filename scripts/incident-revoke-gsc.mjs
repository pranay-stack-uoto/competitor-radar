#!/usr/bin/env node
// INCIDENT TOOL: revokes every stored Google (Search Console) refresh token at Google and deletes it here, so a leaked database copy or
// leaked encryption key cannot be used to read customers' Search Console data. Customers reconnect afterwards. Default is a dry run.
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEYS (all versions)  node scripts/incident-revoke-gsc.mjs [--confirm]
// Token values are never printed.
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(import.meta.url);
const { decrypt } = require('../lib/security/crypto.js');

const confirm = process.argv.includes('--confirm');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
const db = createClient(url, key, { auth: { persistSession: false } });
const { data: rows, error } = await db.from('gsc_tokens').select('project_id,token_enc');
if (error) { console.error('Could not read tokens:', error.code || 'error'); process.exit(1); }
const tally = { revokedAtGoogle: 0, undecryptable: 0, deleted: 0 };
for (const r of rows) {
  let refresh = null;
  try { refresh = decrypt(r.token_enc, process.env, r.project_id); } catch { tally.undecryptable++; }
  if (confirm && refresh) {
    const res = await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh), { method: 'POST' }).catch(() => null);
    if (res && res.ok) tally.revokedAtGoogle++;
  }
  if (confirm) {
    const { error: e } = await db.from('gsc_tokens').delete().eq('project_id', r.project_id);
    if (!e) { tally.deleted++; await db.from('gsc_connections').update({ status: 'revoked', error: 'Reconnect Search Console' }).eq('project_id', r.project_id); }
  }
}
console.log(confirm ? 'DONE' : 'DRY RUN (nothing changed; add --confirm)', JSON.stringify({ tokens: rows.length, ...tally }));
