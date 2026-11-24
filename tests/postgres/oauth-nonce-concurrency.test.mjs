// REAL-POSTGRES: concurrent callbacks presenting one OAuth nonce. Exactly one may succeed, whatever the interleaving.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { skip, setup, conn } from '../helpers/realdb.mjs';

let admin, project;
const U = '11111111-1111-4111-8111-111111111111';
before(async () => {
  if (skip) return;
  admin = await setup();
  await admin.query('insert into auth.users (id) values ($1)', [U]);
  project = (await admin.query(`insert into public.projects (user_id, name, url, domain) values ($1, 'p', 'https://p.example.com', 'p.example.com') returning id`, [U])).rows[0].id;
});
after(async () => { if (admin) await admin.end(); });

test('30 simultaneous consumptions of one nonce: exactly one wins; 25 rounds', { skip }, async () => {
  for (let round = 0; round < 25; round++) {
    const hash = crypto.randomBytes(32).toString('hex');
    assert.equal((await admin.query('select public.oauth_state_create($1, $2, $3, 600) as r', [hash, U, project])).rows[0].r, true);
    const wins = await Promise.all(Array.from({ length: 30 }, async () => {
      const c = await conn();
      try { return (await c.query('select public.oauth_state_consume($1, $2, $3) as r', [hash, U, project])).rows[0].r; } finally { await c.end(); }
    }));
    assert.equal(wins.filter(Boolean).length, 1, `round ${round}`);
  }
});
test('a nonce that expires while callers wait on its row lock is refused (wall clock, not transaction start)', { skip }, async () => {
  const hash = crypto.randomBytes(32).toString('hex');
  await admin.query('select public.oauth_state_create($1, $2, $3, 30)', [hash, U, project]);
  await admin.query(`update public.oauth_states set expires_at = clock_timestamp() + interval '1500 milliseconds' where nonce_hash = $1`, [hash]);
  const [a, b] = [await conn(), await conn()];
  try {
    await b.query('begin'); await b.query('select 1 from public.oauth_states where nonce_hash = $1 for update', [hash]);
    const waiting = a.query('select public.oauth_state_consume($1, $2, $3) as r', [hash, U, project]);
    await new Promise((r) => setTimeout(r, 2000));   // the nonce expires while the caller is blocked
    await b.query('commit');
    assert.equal((await waiting).rows[0].r, false);
  } finally { await a.end(); await b.end(); }
});
