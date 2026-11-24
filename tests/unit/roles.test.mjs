import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { ROLES, rank, atLeast } = createRequire(import.meta.url)('../../lib/security/roles.js');

test('roles are ordered viewer < member < admin < owner', () => {
  assert.deepEqual(ROLES, ['viewer', 'member', 'admin', 'owner']);
  assert.ok(rank('viewer') < rank('member') && rank('member') < rank('admin') && rank('admin') < rank('owner'));
});
test('atLeast compares by level; no role or an unknown role gets nothing', () => {
  assert.equal(atLeast('owner', 'admin'), true); assert.equal(atLeast('admin', 'admin'), true);
  assert.equal(atLeast('member', 'admin'), false); assert.equal(atLeast('viewer', 'member'), false);
  assert.equal(atLeast('viewer', 'viewer'), true);
  for (const bad of [null, undefined, '', 'root', 'OWNER']) assert.equal(atLeast(bad, 'viewer'), false, String(bad));
});
test('asking for a role that does not exist is a programming error, not a free pass', () => {
  assert.throws(() => atLeast('owner', 'superuser'), /Unknown role/);
  assert.throws(() => atLeast('owner', undefined), /Unknown role/);
});
test('the JavaScript role list matches the database constraint in migration 0011', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/0011_organisations.sql', import.meta.url), 'utf8');
  const m = /role\s+text not null check \(role in \(([^)]*)\)\)/.exec(sql);
  assert.deepEqual(m[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort(), [...ROLES].sort());
});
test('routes that administer a project ask for admin, and the callback re-checks the role', () => {
  const read = (f) => readFileSync(new URL('../../' + f, import.meta.url), 'utf8');
  for (const f of ['app/api/verify/route.js', 'app/api/gsc/connect/route.js', 'app/api/gsc/disconnect/route.js']) assert.match(read(f), /requireProject\([^)]*'admin'\)/, f);
  assert.match(read('app/api/gsc/callback/route.js'), /project_role_for/);
});
