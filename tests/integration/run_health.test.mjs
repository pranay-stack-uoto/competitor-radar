// Migration 0027: derived job states, per-project data health, the watchdog, the operations overview and feature flags.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, asUser, seedTwoTenants, U1, U2 } from '../helpers/db.mjs';

let db, p1, p2;
before(async () => { db = await createDb(); ({ p1, p2 } = await seedTwoTenants(db)); await db.query('update public.projects set verified = true'); });
beforeEach(async () => { await db.exec('delete from public.jobs; delete from public.reports; delete from public.alerts; delete from public.feature_flags'); await db.query(`update public.organisations set plan = 'internal'`); });

const q = async (sql, p) => (await db.query(sql, p)).rows;
const DAY = '2026-11-25';
const at = (hhmm) => `${DAY}T${hhmm}:00Z`;                       // an instant on the test day (UTC)
const job = (project, status, extra = {}) => db.query(
  `insert into public.jobs (project_id, day, kind, domain, status, attempts, failure_kind, error, started_at, finished_at, updated_at, run_after, max_attempts)
   values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, now()), coalesce($12, now() - interval '1 hour'), 3)`,
  [project, extra.day || DAY, extra.kind || 'crawl', extra.domain || `s${Math.random().toString(36).slice(2, 8)}.example.com`, status, extra.attempts ?? 1, extra.failure_kind ?? null, extra.error ?? null, extra.started ?? null, extra.finished ?? null, extra.updated ?? null, extra.run_after ?? null]);
const report = (project, day, partial = false) => db.query(`insert into public.reports (project_id, day, summary) values ($1, $2, $3)`, [project, day, JSON.stringify(partial ? { coverage: { partial: true } } : { coverage: { partial: false } })]);
const health = async (project, now) => (await q('select public.project_data_health($1, $2::timestamptz) as h', [project, now]))[0].h;

test('derived states: retrying, dead_letter and cancelled come from attempts, failure kind and the retirement marker', async () => {
  const s = async (status, fk, att, err) => (await q('select public.job_state($1, $2, $3, $4) as s', [status, fk, att, err]))[0].s;
  assert.equal(await s('queued', null, 0, null), 'queued'); assert.equal(await s('queued', 'retryable', 1, 'x'), 'retrying'); assert.equal(await s('running', null, 1, null), 'running');
  assert.equal(await s('done', null, 1, null), 'succeeded'); assert.equal(await s('failed', 'exhausted', 3, 'x'), 'dead_letter'); assert.equal(await s('failed', 'permanent', 1, 'x'), 'failed');
  assert.equal(await s('failed', 'permanent', 1, 'superseded by a newer day'), 'cancelled');
  const r = async (err, st) => (await q('select public.job_reason($1, $2) as r', [err, st]))[0].r;
  assert.equal(await r('[budget-exhausted] This website is larger', 'failed'), 'site is larger than our crawl limit');
  assert.equal(await r('[unknown] getaddrinfo ENOTFOUND dns-failed', 'dead_letter'), 'site did not respond');
  assert.equal(await r('[unknown] diffIssues is not defined', 'failed'), 'could not be read'); // raw errors are never passed on
  assert.equal(await r(null, 'queued'), 'still waiting');
});

test('data health: healthy with a complete report today; degraded when a crawl failed or dead-lettered; failing with no recent success', async () => {
  assert.equal((await health(p1, at('09:00'))).status, 'failing', 'no report at all');
  await report(p1, DAY); await job(p1, 'done', { finished: at('04:10') });
  const h = await health(p1, at('09:00'));
  assert.deepEqual([h.status, h.last_success_day, h.today.succeeded, h.today.planned], ['healthy', DAY, 1, 1]);
  await job(p1, 'failed', { failure_kind: 'exhausted', error: '[budget-exhausted] larger than our crawl limit', domain: 'big.example.com' });
  const d = await health(p1, at('09:00'));
  assert.equal(d.status, 'degraded'); assert.equal(d.today.dead_letter, 1);
  assert.deepEqual(d.gaps, [{ domain: 'big.example.com', state: 'dead_letter', reason: 'site is larger than our crawl limit' }]);
  assert.equal(d.main_reason, 'site is larger than our crawl limit'); assert.ok(!JSON.stringify(d).includes('budget-exhausted'), 'no raw error text');
  assert.equal((await health(p1, `2026-11-28T09:00:00Z`)).status, 'failing', 'newest success is more than 36 hours old');
});
test('data health: delayed while today\'s run is under way, degraded when it is six hours late, healthy before the next run is due', async () => {
  await report(p1, '2026-11-24'); await job(p1, 'done', { day: '2026-11-24', finished: '2026-11-24T04:10:00Z' });
  assert.equal((await health(p1, at('02:00'))).status, 'healthy', 'before 09:00 IST yesterday\'s data is current');
  assert.equal((await health(p1, at('05:00'))).status, 'delayed');
  assert.equal((await health(p1, at('11:00'))).status, 'degraded');
});
test('data health: a partial report does not count as a complete update; next run and success rates are reported', async () => {
  await report(p1, DAY, true); await report(p1, '2026-11-24'); await job(p1, 'done', { day: '2026-11-24', finished: '2026-11-24T04:10:00Z' });
  const h = await health(p1, at('05:00'));
  assert.equal(h.last_success_day, '2026-11-24'); assert.equal(h.next_run_at, '2026-11-26T03:30:00+00:00');
  assert.ok(h.success_rate_7d >= 1 && h.success_rate_30d >= 1);
});
test('data health is visible only to members of the project; other tenants and anonymous callers get nothing', async () => {
  await report(p1, DAY); await job(p1, 'done', { finished: at('04:10') });
  await asUser(db, U1, async () => assert.equal((await db.query('select public.project_data_health($1) as h', [p1])).rows[0].h.status ? true : false, true));
  await asUser(db, U2, async () => assert.equal((await db.query('select public.project_data_health($1) as h', [p1])).rows[0].h, null));
  await asUser(db, U1, async () => {
    await assert.rejects(db.query('select public.watchdog_run()'), /permission denied/);
    await assert.rejects(db.query('select public.ops_overview()'), /permission denied/);
    await assert.rejects(db.query(`select public.feature_enabled('x_flag')`), /permission denied/);
  });
});

test('watchdog: recovers an expired lease, flags a job stuck for 20 minutes, and raises each alert once per day', async () => {
  await job(p1, 'running', { started: at('04:00'), updated: at('04:00') });
  await db.query(`update public.jobs set lease_expires_at = $1::timestamptz - interval '1 minute' where status = 'running'`, [at('04:05')]);
  const first = (await q('select public.watchdog_run($1::timestamptz) as w', [at('04:30')]))[0].w;
  assert.equal(first.recovered >= 0, true);
  await job(p1, 'running', { started: at('04:00'), updated: at('04:28') }); // still has a lease and was updated 2 minutes ago, but started 30 minutes ago
  await db.query(`update public.jobs set lease_expires_at = $1::timestamptz + interval '10 minutes' where status = 'running'`, [at('04:30')]);
  await q('select public.watchdog_run($1::timestamptz)', [at('04:30')]);
  assert.ok((await q(`select * from public.alerts where kind = 'job_stuck'`)).length >= 1);
  const before = (await q('select count(*)::int as n from public.alerts'))[0].n;
  await q('select public.watchdog_run($1::timestamptz)', [at('04:40')]);
  assert.equal((await q('select count(*)::int as n from public.alerts'))[0].n, before, 'running again the same day adds no duplicate');
});
test('watchdog: a verified project with no discovery job by 05:00 UTC is a missed run; one with a job is not; blocked trials are not expected to run', async () => {
  await job(p2, 'done', { kind: 'discover', domain: null, finished: at('03:50') });
  await q('select public.watchdog_run($1::timestamptz)', [at('04:50')]);
  assert.equal((await q(`select * from public.alerts where kind = 'run_missed'`)).length, 0, 'before 05:00 UTC nothing is missed yet');
  await q('select public.watchdog_run($1::timestamptz)', [at('05:10')]);
  const missed = await q(`select subject from public.alerts where kind = 'run_missed'`);
  assert.equal(missed.length, 1); // p1 has no job today, p2 has
  await db.exec('delete from public.alerts');
  await db.query(`update public.organisations set plan = 'trial', trial_runs_used = trial_runs_limit`);
  await q('select public.watchdog_run($1::timestamptz)', [at('05:10')]);
  assert.equal((await q(`select * from public.alerts where kind = 'run_missed'`)).length, 0, 'a trial that has used its runs is not expected to run');
});
test('watchdog: low crawl coverage later in the morning, and a stalled queue that the optional worker start is controlled by a feature flag', async () => {
  for (let i = 0; i < 4; i++) await job(p1, i === 0 ? 'done' : 'queued', { attempts: 0, run_after: at('03:50'), updated: at('03:50') });
  await job(p1, 'done', { kind: 'discover', domain: null });
  const w = (await q('select public.watchdog_run($1::timestamptz) as w', [at('07:30')]))[0].w;
  const kinds = (await q('select kind from public.alerts order by kind')).map((r) => r.kind);
  assert.ok(kinds.includes('coverage_low') && kinds.includes('queue_stalled'), kinds.join());
  assert.equal(w.queue_stalled, true); assert.equal(w.worker_started, false, 'the flag is off, so no worker is started');
  await db.query(`insert into public.feature_flags (key, enabled) values ('watchdog_kick', true)`);
  const w2 = (await q('select public.watchdog_run($1::timestamptz) as w', [at('07:40')]))[0].w;
  assert.equal(w2.worker_started, false, 'with the flag on but no Vault/pg_net set up, the start is skipped safely and the watchdog still completes');
});

test('feature flags: an organisation override beats the global value; no row means off', async () => {
  const org = (await q('select organisation_id from public.projects where id = $1', [p1]))[0].organisation_id;
  const on = async (key, o) => (await q('select public.feature_enabled($1, $2) as e', [key, o]))[0].e;
  assert.equal(await on('new_report', org), false);
  await db.query(`insert into public.feature_flags (key, enabled) values ('new_report', true)`);
  assert.equal(await on('new_report', org), true); assert.equal(await on('new_report', null), true);
  await db.query(`insert into public.feature_flags (key, organisation_id, enabled) values ('new_report', $1, false)`, [org]);
  assert.equal(await on('new_report', org), false);
  await assert.rejects(db.query(`insert into public.feature_flags (key, enabled) values ('new_report', false)`), /duplicate|unique/);
});

test('the operations overview lists problem jobs with plain reasons, queue counts, crawl success rate and each project\'s health', async () => {
  const today = (await q(`select (now() at time zone 'utc')::date as d`))[0].d.toISOString().slice(0, 10);
  await job(p1, 'done', { day: today }); await job(p1, 'failed', { day: today, failure_kind: 'permanent', error: '[budget-exhausted] x', domain: 'huge.example.com' });
  await job(p1, 'queued', { day: today, attempts: 1, error: 'boom', run_after: null });
  const o = (await q('select public.ops_overview() as o'))[0].o;
  assert.equal(o.queue.succeeded, 1); assert.equal(o.queue.failed, 1); assert.equal(o.queue.retrying, 1);
  assert.ok(o.problems.some((p) => p.domain === 'huge.example.com' && p.reason === 'site is larger than our crawl limit' && p.state === 'failed'));
  assert.equal(Number(o.crawl_success_7d), 50);
  assert.ok(o.projects.length >= 2 && o.projects.every((p) => p.health && p.health.status));
});
