// Roles inside an organisation, lowest to highest. The database (migration 0011) is the authority: row-level security enforces
// these for the browser, project_role()/project_role_for() answer for the server. This file only names the levels and compares them,
// so a route can say what it needs ("admin") in one word.
const ROLES = ['viewer', 'member', 'admin', 'owner'];
const rank = (role) => ROLES.indexOf(role) + 1; // unknown or null = 0 = no access

function atLeast(role, need) {
  if (!ROLES.includes(need)) throw new Error(`Unknown role: ${need}`); // a typo in a route must not silently allow everyone
  return rank(role) >= rank(need);
}

module.exports = { ROLES, rank, atLeast };
