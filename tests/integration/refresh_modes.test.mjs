// A discovery job's `domain` carries the refresh mode: null (daily), 'full' (search Google again) or 'recrawl' (Crawl now: read every site again).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seedTwoTenants } from '../helpers/db.mjs';
import { readFileSync } from 'node:fs';

let db, p1;
before(async () => { db = await createDb(); ({ p1 } = await seedTwoTenants(db)); });
const enq = async (domain) => (await db.query(`select public.enqueue_job($1, current_date, 'discover', $2) as id`, [p1, domain])).rows[0].id;

test('the three modes are separate jobs, so a Crawl now is not swallowed by the daily discovery that already ran', async () => {
  const a = await enq(null), b = await enq('recrawl'), c = await enq('full');
  assert.ok(a && b && c && new Set([a, b, c]).size === 3);
  assert.equal(await enq('recrawl'), null, 'a second Crawl now while one is waiting adds nothing');
});
test('Crawl now sends recrawl, re-reads every site, and clears the shared crawl cache first', () => {
  const dash = readFileSync(new URL('../../app/dashboard/page.js', import.meta.url), 'utf8');
  assert.match(dash.slice(dash.indexOf('async function crawlNow')), /recrawl: true/);
  const route = readFileSync(new URL('../../app/api/project/start/route.js', import.meta.url), 'utf8');
  assert.match(route, /body\.recrawl === true \? 'recrawl'/);
  const p = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
  assert.match(p, /const recrawl = job\.domain === 'recrawl'[\s\S]*invalidateCrawl[\s\S]*recrawl \? wanted : wanted\.filter/);
});
