-- 0004 reliable job queue on Postgres (no Redis, no paid service).
--
-- Lifecycle
--   queued --claim--> running --complete--> done
--   running --fail (retryable)--> queued   (run_after pushed out by exponential backoff, attempts kept)
--   running --fail (permanent, or retries used up)--> failed
--   running --lease expires (worker died)--> queued, or failed when retries are used up
-- "done" is the completed state (the name existing code and data already use).
--
-- Guarantees
--   * Claiming is one atomic statement using FOR UPDATE SKIP LOCKED: two workers can never get the same job.
--   * A running job has a lease. If a worker dies, the lease expires and the job is recovered automatically.
--   * complete_job/fail_job only act for the worker that holds the job ("fencing"): a slow worker whose lease already
--     expired cannot overwrite a newer attempt.
--   * enqueue_job refuses to create a second active job for the same (kind, project, day, domain).
-- All functions are server-only (service role).

alter table public.jobs
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists run_after timestamptz not null default now(),
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists max_attempts int not null default 3,
  add column if not exists failure_kind text,
  add column if not exists dedupe_key text;

alter table public.jobs drop constraint if exists jobs_failure_kind_check;
alter table public.jobs add constraint jobs_failure_kind_check
  check (failure_kind is null or failure_kind in ('retryable', 'permanent', 'exhausted'));
alter table public.jobs drop constraint if exists jobs_attempts_check;
alter table public.jobs add constraint jobs_attempts_check check (attempts >= 0 and max_attempts between 1 and 10) not valid;

create index if not exists jobs_claim on public.jobs (run_after, id) where status = 'queued';
create index if not exists jobs_lease on public.jobs (lease_expires_at) where status = 'running';
create unique index if not exists jobs_active_dedupe on public.jobs (dedupe_key)
  where status in ('queued', 'running') and dedupe_key is not null;

-- Exponential backoff with a little jitter: 30s, 60s, 120s, ... capped at one hour.
create or replace function public.job_backoff(p_attempts int, p_base_seconds int default 30)
returns interval language sql immutable
as $$ select make_interval(secs => least(3600, p_base_seconds * power(2, greatest(p_attempts, 1) - 1) * (1 + random() * 0.2))) $$;

-- Creates a job unless an identical one is already queued or running. Returns its id, or null when it already exists.
create or replace function public.enqueue_job(
  p_project uuid, p_day date, p_kind text, p_domain text default null,
  p_run_after timestamptz default now(), p_max_attempts int default 3)
returns bigint language plpgsql security definer set search_path = public, pg_temp
as $$
declare jid bigint;
begin
  insert into public.jobs (project_id, day, kind, domain, run_after, max_attempts, dedupe_key)
  values (p_project, p_day, p_kind, lower(p_domain), p_run_after, p_max_attempts,
          p_kind || ':' || p_project::text || ':' || p_day::text || ':' || coalesce(lower(p_domain), ''))
  on conflict (dedupe_key) where status in ('queued', 'running') and dedupe_key is not null do nothing
  returning id into jid;
  return jid;
end $$;

-- Puts back (or fails) running jobs whose lease has run out. Rows left running by the old queue have no lease; they
-- are treated as expired five minutes after their last update, which matches the old behaviour.
create or replace function public.recover_expired_jobs()
returns int language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  with expired as (
    update public.jobs j set
      status = case when j.attempts >= j.max_attempts then 'failed' else 'queued' end,
      failure_kind = case when j.attempts >= j.max_attempts then 'exhausted' else 'retryable' end,
      error = 'worker lease expired',
      run_after = case when j.attempts >= j.max_attempts then j.run_after else now() + public.job_backoff(j.attempts) end,
      finished_at = case when j.attempts >= j.max_attempts then now() else null end,
      lease_expires_at = null, locked_by = null, updated_at = now()
    where j.status = 'running' and coalesce(j.lease_expires_at, j.updated_at + interval '5 minutes') < now()
    returning 1)
  select count(*) into n from expired;
  return n;
end $$;

-- Atomically takes the next due job. Returns zero rows when there is nothing to do.
create or replace function public.claim_job(p_worker text, p_lease_seconds int default 300)
returns setof public.jobs language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform public.recover_expired_jobs();
  return query
  with next as (
    select id from public.jobs
    where status = 'queued' and run_after <= now()
    order by run_after, id
    for update skip locked
    limit 1)
  update public.jobs j set
    status = 'running', attempts = j.attempts + 1, locked_by = p_worker,
    started_at = now(), finished_at = null,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  from next where j.id = next.id
  returning j.*;
end $$;

-- Marks the job completed. Returns false if this worker no longer holds it.
create or replace function public.complete_job(p_id bigint, p_worker text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.jobs set status = 'done', finished_at = now(), error = null, failure_kind = null,
         lease_expires_at = null, locked_by = null, updated_at = now()
  where id = p_id and status = 'running' and locked_by = p_worker;
  return found;
end $$;

-- Records a failure. Retryable failures go back to the queue with backoff until max_attempts is reached.
-- Returns the job's new status, or null if this worker no longer holds it.
create or replace function public.fail_job(p_id bigint, p_worker text, p_error text, p_permanent boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare j public.jobs; new_status text;
begin
  select * into j from public.jobs where id = p_id and status = 'running' and locked_by = p_worker for update;
  if not found then return null; end if;
  if p_permanent or j.attempts >= j.max_attempts then
    new_status := 'failed';
    update public.jobs set status = 'failed', failure_kind = case when p_permanent then 'permanent' else 'exhausted' end,
           error = left(coalesce(p_error, ''), 500), finished_at = now(), lease_expires_at = null, locked_by = null, updated_at = now()
    where id = p_id;
  else
    new_status := 'queued';
    update public.jobs set status = 'queued', failure_kind = 'retryable', error = left(coalesce(p_error, ''), 500),
           run_after = now() + public.job_backoff(j.attempts), lease_expires_at = null, locked_by = null, updated_at = now()
    where id = p_id;
  end if;
  return new_status;
end $$;

revoke all on function public.job_backoff(int, int), public.enqueue_job(uuid, date, text, text, timestamptz, int),
  public.recover_expired_jobs(), public.claim_job(text, int), public.complete_job(bigint, text), public.fail_job(bigint, text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.job_backoff(int, int), public.enqueue_job(uuid, date, text, text, timestamptz, int),
  public.recover_expired_jobs(), public.claim_job(text, int), public.complete_job(bigint, text), public.fail_job(bigint, text, text, boolean)
  to service_role;
