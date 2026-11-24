// Daily spend budgets per organisation (migration 0015). Call chargeBudget() BEFORE doing something that costs money.
// A refused charge throws a BudgetError: permanent for a queued job (it is not retried today; the next daily run tries again), and
// a 429 for a request (see route() in lib/http.js). If migration 0015 is not applied yet, charging is skipped so the app keeps working.
const LABELS = { crawl: 'website crawl', ai: 'AI', search: 'search' };

class BudgetError extends Error {
  constructor(metric, state) {
    super(`The daily ${LABELS[metric] || metric} limit for this account has been reached. It resets tomorrow.`);
    this.name = 'BudgetError'; this.code = 'budget-exceeded'; this.permanent = true; this.metric = metric; this.state = state;
  }
}
const isMissingFunction = (e) => !!e && (e.code === 'PGRST202' || e.code === '42883' || /could not find the function|function .* does not exist/i.test(String(e.message || '')));

async function chargeBudget(db, organisationId, metric, amount = 1, log = console.error) {
  if (!organisationId) return { allowed: true, skipped: true }; // project not yet in an organisation: nothing to charge
  let res;
  try { res = await db.rpc('usage_charge', { p_org: organisationId, p_metric: metric, p_amount: Math.max(1, Math.min(1000, Math.ceil(amount))) }); }
  catch (e) { res = { data: null, error: { message: String((e && e.message) || e) } }; }
  const { data, error } = res || {};
  if (error) {
    if (isMissingFunction(error)) return { allowed: true, skipped: true };
    log('budget check failed:', String(error.code || 'error'));
    const e = new Error('Budget check unavailable'); e.retryable = true; e.code = 'budget-unavailable'; throw e; // fail closed: do not spend when we cannot count
  }
  if (!data || data.allowed !== true) throw new BudgetError(metric, data);
  return data;
}

module.exports = { chargeBudget, BudgetError };
