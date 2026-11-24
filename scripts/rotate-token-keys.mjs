#!/usr/bin/env node
// Moves every stored Search Console token to the active encryption key (and to the envelope format when TOKEN_ENVELOPE=1).
// Default is a DRY RUN: it only counts. Pass --apply to write. Run with the SAME environment variables as production:
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEYS (old and new versions), TOKEN_ENC_ACTIVE, TOKEN_ENVELOPE
// Token values are never printed. Each row is updated only if it still holds the value that was read (no overwriting a newer write).
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
const require = createRequire(import.meta.url);
const { rotateValue } = require('../lib/security/rotate.js');
const { cryptoReady } = require('../lib/security/crypto.js');

const apply = process.argv.includes('--apply');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
if (!cryptoReady(process.env)) { console.error('The encryption keys are not usable here (production needs a valid TOKEN_ENC_KEYS that is not derived from the service-role key). Nothing was changed.'); process.exit(2); }
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await db.from('gsc_tokens').select('project_id,token_enc');
if (error) { console.error('Could not read tokens:', error.code || 'error'); process.exit(1); }
const tally = { skip: 0, rewrap: 0, reencrypt: 0, failed: 0 };
for (const row of rows) {
  try {
    const r = rotateValue(row.token_enc, row.project_id);
    tally[r.how]++;
    if (apply && r.how !== 'skip') {
      const { data, error: e } = await db.from('gsc_tokens').update({ token_enc: r.blob }).eq('project_id', row.project_id).eq('token_enc', row.token_enc).select('project_id');
      if (e || !data?.length) { tally.failed++; console.error('not updated:', row.project_id); }
    }
  } catch (e) { tally.failed++; console.error('could not rotate', row.project_id, String(e.message).slice(0, 80)); }
}
console.log(apply ? 'APPLIED' : 'DRY RUN (nothing written; add --apply)', JSON.stringify({ total: rows.length, ...tally }));
process.exit(tally.failed ? 1 : 0);
