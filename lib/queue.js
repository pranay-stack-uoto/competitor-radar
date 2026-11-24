// Thin, testable wrapper around the Postgres job functions (supabase/migrations/0004_job_queue.sql).
// The database does the atomic work; this file decides what kind of failure an error is, and keeps secrets out of stored errors.
const crypto = require('node:crypto');

// One id per server instance. It "fences" a job to the worker that claimed it.
const WORKER_ID = `${process.env.VERCEL_REGION || 'local'}-${crypto.randomBytes(4).toString('hex')}`;
const LEASE_SECONDS = 300;

const scrub = (s) => String(s == null ? '' : s).replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]').replace(/\s+/g, ' ').slice(0, 400);

// Guard codes that will never succeed on retry, versus ones that may be temporary.
const PERMANENT_GUARD = new Set(['bad-url', 'bad-protocol', 'credentials', 'bad-port', 'ip-literal', 'bad-host', 'blocked-host', 'blocked-address', 'too-large', 'budget-exhausted']);
const TRANSIENT_NET = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR|fetch failed|socket hang up|network/i;

// Decide whether retrying can help. Unknown errors are treated as retryable and are still bounded by max_attempts.
function classifyError(e) {
  const message = scrub(e && (e.message || e));
  if (e && e.permanent === true) return { permanent: true, code: e.code || 'permanent', message };
  if (e && e.retryable === true) return { permanent: false, code: e.code || 'retryable', message };
  if (e && e.name === 'GuardError') return { permanent: PERMANENT_GUARD.has(e.code), code: e.code, message };
  const status = Number(e && (e.status || e.statusCode));
  if (status) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return { permanent: false, code: 'http-' + status, message };
    if (status >= 400) return { permanent: true, code: 'http-' + status, message };
  }
  const pg = String((e && e.code) || '');
  if (/^(22|23|42)/.test(pg)) return { permanent: true, code: 'db-' + pg, message }; // data or programming errors will not fix themselves
  if (TRANSIENT_NET.test(String((e && (e.code || e.message)) || ''))) return { permanent: false, code: 'network', message };
  return { permanent: false, code: 'unknown', message };
}

async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) { const e = new Error(`${fn}: ${error.message}`); e.code = error.code; throw e; }
  return data;
}

// Creates a job unless an identical active one exists. Returns the new id, or null if it already existed.
const enqueue = (db, { projectId, day, kind, domain = null, runAfter, maxAttempts = 3 }) =>
  rpc(db, 'enqueue_job', { p_project: projectId, p_day: day, p_kind: kind, p_domain: domain, p_run_after: runAfter || new Date().toISOString(), p_max_attempts: maxAttempts });

// Every claim returns the job with a fresh lease_token. Everything that later acts on the job (renew, complete, fail) must present it:
// ownership is the token, not the worker name, so two executions that share a name cannot interfere (migration 0010).
async function claim(db, worker = WORKER_ID, leaseSeconds = LEASE_SECONDS) {
  const rows = await rpc(db, 'claim_job', { p_worker: worker, p_lease_seconds: leaseSeconds });
  const job = Array.isArray(rows) ? rows[0] || null : rows || null;
  if (job && !job.lease_token) throw new Error('claim_job returned no lease token: apply migration 0010_job_lease_tokens.sql');
  return job;
}
function tokenOf(job) {
  if (!job || !job.lease_token) throw new Error('This job has no lease token: it was not obtained from claim()');
  return job.lease_token;
}
const complete = async (db, job, worker = WORKER_ID) => rpc(db, 'complete_job', { p_id: job.id, p_worker: worker, p_token: tokenOf(job) });
async function fail(db, job, err, worker = WORKER_ID) {
  const c = classifyError(err);
  return rpc(db, 'fail_job', { p_id: job.id, p_worker: worker, p_token: tokenOf(job), p_error: `[${c.code}] ${c.message}`, p_permanent: c.permanent });
}
const recoverExpired = (db) => rpc(db, 'recover_expired_jobs', {});
// Makes the next crawl of this domain bypass the shared cache (used when an owner says they changed their site).
// ---- lease renewal ------------------------------------------------------------------------------------------------------
// A job holds a lease. While it runs, runWithLease renews it on a timer, one renewal at a time (the next is scheduled only after the
// previous one finished, so renewals can never pile up). If the lease is lost, or cannot be confirmed before it would have expired,
// lease.assertHeld() throws LeaseLostError, which job handlers call before every write so a worker that no longer owns the job stops.
class LeaseLostError extends Error {
  constructor(jobId) { super('This worker no longer holds the job lease.'); this.name = 'LeaseLostError'; this.jobId = jobId; }
}
const renewLease = async (db, job, worker = WORKER_ID, seconds = LEASE_SECONDS) => rpc(db, 'renew_job_lease', { p_id: job.id, p_worker: worker, p_token: tokenOf(job), p_lease_seconds: seconds });

const CLOCK_MARGIN_MS = 5000; // treat the lease as ending a little early: clocks and network delay are not exact

// What a handler gets as `lease`:
//   lease.signal        an AbortSignal that fires the moment ownership is lost (or the lease ran out without a renewal). Pass it to
//                       every fetch/API call that supports it, and stop scheduling work when it is aborted.
//   lease.assertHeld()  throws LeaseLostError if ownership is lost; call before any local step that must not run for a stale job
//   lease.write(fn, args)  commits a RESULT through one of the fenced database functions (migration 0012). The database checks the job id,
//                       worker, token, running status and an unexpired lease in the same transaction as the write, so a stale execution
//                       cannot commit even if it passed assertHeld() a moment earlier. Throws LeaseLostError (and aborts the signal) when
//                       the database says ownership is not held; the write did not happen.
// Limits: aborting stops supported HTTP/API calls (the SSRF-guarded crawler, Serper, Anthropic, Places). It cannot recall a request the
// remote side already received, cannot interrupt the shared-crawl wait loop (lib/crawlCache.js sleeps up to 45 s), and cannot stop CPU
// work already running (parsing, scoring). Those finish harmlessly: the result is thrown away because the fenced write is refused.
async function runWithLease(db, job, handler, { worker = WORKER_ID, leaseSeconds = LEASE_SECONDS, everyMs = Math.floor((leaseSeconds * 1000) / 3), maxFailures = 2, renew = renewLease, now = Date.now, marginMs = CLOCK_MARGIN_MS } = {}) {
  let stopped = false, timer = null, expiryTimer = null, inflight = null, failures = 0;
  const controller = new AbortController();
  const lease = {
    lost: false,
    signal: controller.signal,
    expiresAt: now() + leaseSeconds * 1000 - marginMs,
    assertHeld() {
      if (!lease.lost && now() >= lease.expiresAt) markLost();
      if (lease.lost) throw new LeaseLostError(job.id);
    },
    async write(fn, args = {}) {
      lease.assertHeld();
      const result = await rpc(db, fn, { p_id: job.id, p_worker: worker, p_token: tokenOf(job), ...args });
      if (result === false || result === null || result === undefined) { markLost(); throw new LeaseLostError(job.id); }
      return result;
    },
  };
  function markLost() {
    if (lease.lost) return;
    lease.lost = true;
    if (!controller.signal.aborted) controller.abort(new LeaseLostError(job.id));
  }
  // If a renewal does not arrive before the lease would end, treat it as lost at that moment, not only at the next assertHeld().
  const armExpiry = () => {
    if (expiryTimer) clearTimeout(expiryTimer);
    if (stopped || lease.lost) return;
    expiryTimer = setTimeout(() => { if (!stopped) markLost(); }, Math.max(0, lease.expiresAt - now()));
    if (expiryTimer.unref) expiryTimer.unref();
  };
  const schedule = () => { if (!stopped && !lease.lost) timer = setTimeout(tick, everyMs); };
  function tick() {
    timer = null;
    if (stopped) return;
    const startedAt = now();
    inflight = (async () => {
      try {
        if (await renew(db, job, worker, leaseSeconds)) { failures = 0; lease.expiresAt = startedAt + leaseSeconds * 1000 - marginMs; armExpiry(); }
        else markLost(); // the database says we no longer own it
      } catch { if (++failures >= maxFailures) markLost(); } // one hiccup is tolerated; the lease is long enough for another try
    })().then(() => { inflight = null; schedule(); });
  }
  schedule();
  armExpiry();
  try {
    let result;
    try { result = await handler(lease); }
    catch (e) {
      // An error caused by the abort (or thrown after ownership was lost) is not this job's failure: never fail a job with a stale token.
      if (!(e instanceof LeaseLostError)) { try { lease.assertHeld(); } catch (lost) { throw lost; } }
      throw e;
    }
    lease.assertHeld(); // a handler that finished after losing the lease must not be reported as completed
    return result;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
    if (!controller.signal.aborted) controller.abort(new Error('job finished')); // stop anything the handler left running
    if (inflight) await inflight; // let an in-flight renewal settle so nothing runs after we return
  }
}

// Runs one claimed job to its end and records the outcome. Returns one of:
//   'done'                 handler finished and the database accepted the completion
//   'lost'                 ownership was lost while running; nothing was completed or failed (the new owner decides the job's fate)
//   'completion-rejected'  the handler finished but complete_job() returned false: ownership was lost at the last moment
//   'completion-unknown'   the completion call itself errored; the job is left to lease expiry and a retry (handlers are idempotent)
//   'failed'               the handler threw; fail_job() recorded it (or could not, which is logged)
async function runClaimedJob(db, job, handler, opts = {}, log = console.error) {
  const worker = opts.worker || WORKER_ID;
  try {
    await runWithLease(db, job, handler, opts);
  } catch (e) {
    if (e instanceof LeaseLostError) { log('job lease lost; leaving the job to its new owner', job.id); return 'lost'; }
    await fail(db, job, e, worker).catch((x) => log('could not record job failure', job.id, scrub(x && x.message).slice(0, 200)));
    return 'failed';
  }
  let ok;
  try { ok = await complete(db, job, worker); }
  catch (x) { log('could not record job completion; it will be retried after its lease expires', job.id, scrub(x && x.message).slice(0, 200)); return 'completion-unknown'; }
  if (ok !== true) { log('job completion rejected: ownership was lost before completion', job.id); return 'completion-rejected'; }
  return 'done';
}

const invalidateCrawl = (db, domain) => rpc(db, 'invalidate_domain_crawl', { p_domain: domain });

// How much work is waiting and how many jobs are being worked right now. Used to decide whether another worker should be started.
async function workload(db) {
  const now = new Date().toISOString();
  const [{ count: claimable }, { count: running }] = await Promise.all([
    db.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'queued').lte('run_after', now),
    db.from('jobs').select('id', { count: 'exact', head: true }).eq('status', 'running').gt('lease_expires_at', now),
  ]);
  return { claimable: claimable || 0, running: running || 0 };
}
// Start another worker only while there is claimable work and fewer than `max` jobs are running. Several workers are safe (a job is claimed by one
// worker only) and make the daily run finish sooner and survive one worker being cut off by the platform's time limit.
const shouldSpawnWorker = ({ claimable, running }, max = 2) => claimable > 0 && running < max;

module.exports = { workload, shouldSpawnWorker, WORKER_ID, LEASE_SECONDS, classifyError, scrub, enqueue, claim, complete, fail, recoverExpired, invalidateCrawl, renewLease, runWithLease, runClaimedJob, LeaseLostError };
