// Static guard: a missed day must not leave a backlog that holds up today's report (see retireStaleJobs in lib/pipeline.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
const pipeline = read('lib/pipeline.js');
const fn = pipeline.slice(pipeline.indexOf('export async function retireStaleJobs'), pipeline.indexOf('export async function startDay'));

test('retireStaleJobs only touches queued, older-day, non-audit jobs', () => {
  assert.match(fn, /\.eq\('status', 'queued'\)/);
  assert.match(fn, /\.lt\('day', day\)/);
  assert.match(fn, /\.neq\('kind', 'audit'\)/);
  assert.doesNotMatch(fn, /\.delete\(/);
});
test('the daily start and the Crawl now route both retire stale jobs first', () => {
  assert.match(pipeline.slice(pipeline.indexOf('export async function startDay')), /await retireStaleJobs\(db, day\)/);
  assert.match(read('app/api/project/start/route.js'), /retireStaleJobs\(db, today\(\), p\.id\)/);
});
