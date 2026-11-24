// The project access check behind requireProject (lib/http.js), kept free of Next.js imports so it can be unit tested.
const { HttpError, needUuid } = require('./validate');
const { atLeast } = require('./roles');

// The project must exist, the caller must belong to its organisation, and their role must be at least `need`.
// The lookup runs as the user, so row-level security decides visibility: a project in someone else's organisation is
// indistinguishable from one that does not exist (404). A visible project with too low a role is a 403.
async function checkProjectAccess(client, projectId, columns = 'id', need = 'member') {
  const id = needUuid(projectId, 'project');
  const { data } = await client.from('projects').select(columns).eq('id', id).maybeSingle();
  if (!data) throw new HttpError(404, 'Not found');
  const { data: role, error } = await client.rpc('project_role', { pid: id });
  // Before migration 0011 is applied the function does not exist and row-level security still means "your own project", which is
  // the old owner-only rule. Only that exact case falls back; any other failure refuses the request.
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return data;
    throw new Error('role lookup failed');
  }
  if (!atLeast(role, need)) throw new HttpError(403, 'You do not have permission to do that.');
  return data;
}

module.exports = { checkProjectAccess };
