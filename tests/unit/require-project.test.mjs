// requireProject: visibility comes from row-level security, the level from the project_role() answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { checkProjectAccess } = createRequire(import.meta.url)('../../lib/security/projectAccess.js');
const requireProject = (auth, ...rest) => checkProjectAccess(auth.client, ...rest);

const UUID = '0b1f6f6e-3c3a-4f6e-9d57-6a3c0d9f1a11';
const client = ({ project = { id: UUID }, role = 'member', error = null } = {}) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: project }) }) }) }),
  rpc: async (fn, args) => { assert.equal(fn, 'project_role'); assert.equal(args.pid, UUID); return { data: role, error }; },
});
const status = (p) => p.then(() => null, (e) => e.status ?? e.message);

test('a member may do normal work (the default level)', async () => { assert.deepEqual(await requireProject({ client: client() }, UUID), { id: UUID }); });
test('a viewer is refused with 403 where member is needed', async () => { assert.equal(await status(requireProject({ client: client({ role: 'viewer' }) }, UUID)), 403); });
test('a member is refused with 403 where admin is needed; admin and owner pass', async () => {
  assert.equal(await status(requireProject({ client: client({ role: 'member' }) }, UUID, 'id', 'admin')), 403);
  for (const role of ['admin', 'owner']) assert.deepEqual(await requireProject({ client: client({ role }) }, UUID, 'id', 'admin'), { id: UUID });
});
test('a project the caller cannot see is a 404, never a 403 (so it does not reveal that it exists)', async () => {
  assert.equal(await status(requireProject({ client: client({ project: null }) }, UUID)), 404);
});
test('a bad id is rejected before any lookup', async () => { assert.equal(await status(requireProject({ client: client() }, 'nope')), 400); });
test('no role at all (null) is refused', async () => { assert.equal(await status(requireProject({ client: client({ role: null }) }, UUID)), 403); });
test('before migration 0011 the role function is missing: the old owner-only rule (RLS) applies', async () => {
  for (const code of ['PGRST202', '42883']) assert.deepEqual(await requireProject({ client: client({ role: null, error: { code } }) }, UUID), { id: UUID });
});
test('any other failure of the role lookup refuses the request instead of letting it through', async () => {
  assert.equal(await status(requireProject({ client: client({ role: null, error: { code: '57014' } }) }, UUID)), 'role lookup failed');
});
