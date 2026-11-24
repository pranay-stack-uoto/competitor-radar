// Free trial and plan limits (migration 0021). chargeRun() is called BEFORE a project's refresh is queued; it spends one run of the
// organisation's trial, or is allowed outright on a paid ('active') or 'internal' plan. A refused run never queues anything. If migration 0021 is
// not applied yet, runs are allowed so the app keeps working (same approach as lib/budget.js).
const MESSAGES = {
  'trial-ended': 'Your free trial has ended. Your data and reports stay available. Contact us to continue with daily updates.',
  'trial-runs-used': 'You have used all the runs in your free trial. Your data and reports stay available. Contact us to continue.',
  'plan-expired': 'Your plan has expired. Your data and reports stay available. Renew to continue daily updates.',
  'plan-inactive': 'Your subscription is not active. Your data and reports stay available. Contact us to reactivate it.',
};
const isMissingFunction = (e) => !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|function .* does not exist/i.test(String(e.message || '')));

class EntitlementError extends Error {
  constructor(state) {
    super(MESSAGES[state && state.reason] || 'Your plan does not include this.');
    this.name = 'EntitlementError'; this.code = 'plan-limit'; this.status = 402; this.permanent = true; this.state = state;
  }
}

async function chargeRun(db, organisationId, log = console.error) {
  if (!organisationId) return { allowed: true, skipped: true };
  let res;
  try { res = await db.rpc('entitlement_charge_run', { p_org: organisationId }); }
  catch (e) { res = { data: null, error: { message: String((e && e.message) || e) } }; }
  const { data, error } = res || {};
  if (error) {
    if (isMissingFunction(error)) return { allowed: true, skipped: true };
    log('plan check failed:', String(error.code || 'error'));
    const e = new Error('Plan check unavailable'); e.retryable = true; e.code = 'plan-unavailable'; throw e; // fail closed: do not spend when we cannot count
  }
  return data || { allowed: false, reason: 'plan-inactive' };
}

// Same as chargeRun, but throws EntitlementError when the run is refused.
async function requireRun(db, organisationId) {
  const r = await chargeRun(db, organisationId);
  if (!r.allowed) throw new EntitlementError(r);
  return r;
}

module.exports = { chargeRun, requireRun, EntitlementError, MESSAGES };
