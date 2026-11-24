// Glue shared by every API route: error handling, authentication, ownership checks and rate limits.
import { NextResponse } from 'next/server';
import { admin } from './db';
import { userFromRequest } from './auth';
import { HttpError } from './security/validate';
import { LIMITS, IP_LIMIT, ipKey, checkLimit } from './security/ratelimit';
import { checkProjectAccess } from './security/projectAccess';
import { recordAudit } from './auditTrail';
import { chargeBudget } from './budget';

// Per-user limits live in lib/security/ratelimit.js (fixed windows, Postgres-backed, fail closed).
export { LIMITS };

// Never log anything that looks like a credential.
const scrub = (s) => String(s || '').replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]').slice(0, 300);

// Wrap a route handler. Known problems become clean JSON errors; unexpected ones are logged (scrubbed) and shown generically.
export const route = (handler) => async (req, ctx) => {
  try { return await handler(req, ctx); }
  catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e && e.code === 'budget-exceeded') return NextResponse.json({ error: e.message }, { status: 429 }); // daily spend budget (lib/budget.js)
    if (e && e.code === 'plan-limit') return NextResponse.json({ error: e.message, code: 'plan-limit' }, { status: 402 }); // free trial or plan limit (lib/entitlements.js)
    console.error('route error', req.method, new URL(req.url).pathname, e?.name || 'Error', scrub(e?.message));
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
};

export async function requireUser(req) {
  // Per client address first: it also covers floods of requests that would fail authentication.
  const ip = ipKey(req.headers);
  if (ip) await checkLimit({ rpc: (args) => admin().rpc('rate_limit_hit', args), key: ip, windowSec: IP_LIMIT.windowSec, max: IP_LIMIT.max });
  const auth = await userFromRequest(req);
  if (!auth) throw new HttpError(401, 'Sign in again');
  return auth;
}

// Platform operator only (the owner of the product, not a customer): the signed-in email must be listed in ADMIN_EMAILS. Anyone else gets a plain
// 404 so the page does not even reveal that it exists. With ADMIN_EMAILS unset nobody is an operator.
export function requireAdmin(auth, env = process.env) {
  const list = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const email = String((auth && auth.user && auth.user.email) || '').toLowerCase();
  if (!email || !list.includes(email)) throw new HttpError(404, 'Not found');
  return auth;
}

// The caller must belong to the project's organisation with a role of at least `need` (see lib/security/projectAccess.js):
//   viewer  read only (no route asks for this yet: reads go straight to the database under row-level security)
//   member  normal project work; the default, because every route here spends money or changes data
//   admin   project administration: verifying ownership, connecting Search Console
export async function requireProject(auth, projectId, columns = 'id', need = 'member') {
  try { return await checkProjectAccess(auth.client, projectId, columns, need); }
  catch (e) {
    // Refusals feed the audit trail so repeated probing for other people's projects raises an alert (audit_anomalies, migration 0014).
    // At most 50 refusals per person per hour are written, so this cannot be turned into a way to fill the table.
    if (e instanceof HttpError && (e.status === 403 || e.status === 404)) await noteDenied(auth, projectId, e.status);
    throw e;
  }
}
async function noteDenied(auth, projectId, status) {
  try {
    const db = admin();
    const { data: ok } = await db.rpc('rate_limit_hit', { p_key: `deny:${auth.user.id}`, p_window_seconds: 3600, p_max: 50 });
    if (ok === true) await recordAudit(db, { actor: auth.user.id, action: 'access.denied', targetType: 'project', targetId: String(projectId).slice(0, 64), detail: { status } });
  } catch { /* never let auditing change the response */ }
}

// Records an event for the audit trail on behalf of the signed-in person.
export const audit = (auth, project, action, detail = {}) => recordAudit(admin(), { org: project && project.organisation_id, actor: auth.user.id, action, targetType: 'project', targetId: project && project.id, detail });
// Spends from the organisation's daily budget, or throws (429 for a request).
export const charge = (project, metric, amount = 1) => chargeBudget(admin(), project && project.organisation_id, metric, amount);

// Refuses the request (429 over the limit, 503 if the limiter itself is unavailable) or returns. In production a missing
// rate_limit_hit() function is a 503, never a silent pass; see lib/security/ratelimit.js.
export async function limit(auth, name) {
  const { max, windowSec } = LIMITS[name];
  await checkLimit({ rpc: (args) => admin().rpc('rate_limit_hit', args), key: `${name}:${auth.user.id}`, windowSec, max });
}
