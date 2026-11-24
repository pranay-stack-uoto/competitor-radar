// Migration 0026: monitor_run() also reports failed jobs, jobs the worker never reached, and stale reports.
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, seedTwoTenants } from '../helpers/db.mjs';

let db, p1;
before(async () => { db = await createDb(); ({ p1 } = await seedTwoTenants(db)); await db.query('update public.projects set verified = true'); });
beforeEach(async () => { await db.exec('delete from public.jobs; delete from public.alerts; delete from public.reports'); });
const rows = async (sql, p) => (await db.query(sql, p)).rows;
const job = (status, error) => db.query(`insert into public.jobs (project_id, day, kind, domain, status, error) values ($1, current_date, 'crawl', $2, $3, $4)`, [p1, `d${Math.random()}.example.com`.replace('0.', ''), status, error]);
const alerts = async () => rows(`select kind, severity, subject, detail from public.alerts order by kind, subject`);

test('failed jobs are reported once per project and day; retired ("superseded") jobs are reported separately', async () => {
  await job('failed', '[unknown] boom'); await job('failed', '[budget-exhausted] too large'); await job('failed', 'superseded by a newer day'); await job('done', null);
  await db.query(`insert into public.reports (project_id, day, summary) select id, current_date, '{}' from public.projects`);
  await rows('select public.monitor_run()');
  const a = (await alerts()).filter((x) => x.kind.startsWith('jobs_'));
  assert.deepEqual(a.map((x) => [x.kind, x.detail.failed ?? x.detail.dropped]), [['jobs_dropped', 1], ['jobs_failed', 2]]);
  assert.equal(a.find((x) => x.kind === 'jobs_failed').severity, 'warning');
  await rows('select public.monitor_run()'); // running it again the same day adds nothing
  assert.equal((await alerts()).filter((x) => x.kind.startsWith('jobs_')).length, 2);
});
test('five or more failures are critical', async () => {
  for (let i = 0; i < 5; i++) await job('failed', 'x');
  await db.query(`insert into public.reports (project_id, day, summary) select id, current_date, '{}' from public.projects`);
  await rows('select public.monitor_run()');
  assert.equal((await alerts()).find((x) => x.kind === 'jobs_failed').severity, 'critical');
});
test('a verified project with no report, or one older than a day, raises report_stale; a fresh report does not', async () => {
  await rows('select public.monitor_run()');
  assert.ok((await alerts()).some((x) => x.kind === 'report_stale'), 'no report at all');
  await db.exec('delete from public.alerts');
  await db.query(`insert into public.reports (project_id, day, summary) select id, current_date - 3, '{}' from public.projects`);
  await rows('select public.monitor_run()');
  const stale = (await alerts()).filter((x) => x.kind === 'report_stale');
  assert.ok(stale.length >= 1 && stale[0].detail.last_report);
  await db.exec('delete from public.alerts; delete from public.reports');
  await db.query(`insert into public.reports (project_id, day, summary) select id, current_date, '{}' from public.projects`);
  await rows('select public.monitor_run()');
  assert.equal((await alerts()).filter((x) => x.kind === 'report_stale').length, 0);
});
