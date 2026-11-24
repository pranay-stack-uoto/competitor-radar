// Static guard: the three job handlers commit results only through lease.write() (fenced in the database, migration 0012).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../lib/pipeline.js', import.meta.url), 'utf8');
const region = src.slice(src.indexOf('async function runDiscovery'), src.indexOf('// Ranks are assigned once every crawl job'));

test('job handlers have no direct table writes and no unfenced child-job enqueues', () => {
  assert.ok(region.length > 500, 'found the handlers');
  assert.doesNotMatch(region, /\.(upsert|insert|update|delete)\(/, 'use lease.write(<fenced function>) for every write');
  assert.doesNotMatch(region, /\benqueue\(/, 'child jobs go through job_enqueue_crawls');
  assert.doesNotMatch(region, /\.rpc\(/, 'no direct rpc: lease.write adds the job id, worker and token');
});
test('each handler commits through the fenced function for its job kind', () => {
  for (const fn of ['job_write_discovery', 'job_enqueue_crawls', 'job_write_score', 'job_write_audit']) assert.match(region, new RegExp(`lease\\.write\\('${fn}'`), fn);
});
test('handlers pass the abort signal to their network calls', () => {
  assert.match(region, /signal/);
  assert.match(region, /signal: lease\.signal/);
});
