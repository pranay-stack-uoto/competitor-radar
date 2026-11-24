-- 0010 job lease tokens: ownership of a running job is a unique token, not a worker name.
--
-- Until now complete_job/fail_job/renew_job_lease (0004, 0009) checked jobs.locked_by. That is the worker's name, and two
-- overlapping executions can share a name (every invocation inside one server process has the same one). A slow execution
-- whose lease expired could therefore still complete, fail or renew a job that a newer execution of the "same" worker had
-- since claimed.
--
-- Now every successful claim writes a fresh random lease_token on the job and returns it to the claimer. Renewing, completing
-- and failing all require that token, and only work while it is the CURRENT token and its lease has NOT expired. Recovering,
-- releasing, completing or failing a job clears the token, so an old token can never match again. Retry counting, backoff and
-- de-duplication are unchanged. All functions are server-only (service role).
--
-- The three old signatures (without a token) are kept as inert stubs so code still running during a rollout fails safely (it
-- cannot complete anything, the job's lease simply expires and it is retried) instead of erroring. Drop them in a later migration.
-- Never edit 0004 or 0009; they are already applied.

alter table public.jobs add column if not exists lease_token uuid;

-- Recovery also clears the token, so the previous holder is locked out from this moment.
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
      lease_expires_at = null, locked_by = null, lease_token = null, updated_at = now()
    where j.status = 'running' and coalesce(j.lease_expires_at, j.updated_at + interval '5 minutes') < now()
    returning 1)
  select count(*) into n from expired;
  return n;
end $$;

-- A fresh token on every claim. The returned row includes it.
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
    status = 'running', attempts = j.attempts + 1, locked_by = p_worker, lease_token = gen_random_uuid(),
    started_at = now(), finished_at = null,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  from next where j.id = next.id
  returning j.*;
end $$;

-- Extends the lease. Only the current, unexpired token holder can.
create or replace function public.renew_job_lease(p_id bigint, p_worker text, p_token uuid, p_lease_seconds int default 300)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'bad lease length'; end if;
  if p_token is null then return false; end if;
  update public.jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token and lease_expires_at > now();
  return found;
end $$;

-- Marks the job completed and clears the token. False when the token is stale, expired or wrong.
create or replace function public.complete_job(p_id bigint, p_worker text, p_token uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_token is null then return false; end if;
  update public.jobs set status = 'done', finished_at = now(), error = null, failure_kind = null,
         lease_expires_at = null, locked_by = null, lease_token = null, updated_at = now()
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token and lease_expires_at > now();
  return found;
end $$;

-- Records a failure: retried with backoff until max_attempts, or failed at once when permanent. Clears the token either way.
-- Returns the new status, or null when the token is stale, expired or wrong.
create or replace function public.fail_job(p_id bigint, p_worker text, p_token uuid, p_error text, p_permanent boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare j public.jobs; new_status text;
begin
  if p_token is null then return null; end if;
  select * into j from public.jobs
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token and lease_expires_at > now() for update;
  if not found then return null; end if;
  if p_permanent or j.attempts >= j.max_attempts then
    new_status := 'failed';
    update public.jobs set status = 'failed', failure_kind = case when p_permanent then 'permanent' else 'exhausted' end,
           error = left(coalesce(p_error, ''), 500), finished_at = now(), lease_expires_at = null, locked_by = null, lease_token = null, updated_at = now()
    where id = p_id;
  else
    new_status := 'queued';
    update public.jobs set status = 'queued', failure_kind = 'retryable', error = left(coalesce(p_error, ''), 500),
           run_after = now() + public.job_backoff(j.attempts), lease_expires_at = null, locked_by = null, lease_token = null, updated_at = now()
    where id = p_id;
  end if;
  return new_status;
end $$;

-- Legacy signatures from 0004 and 0009: inert. They can no longer act on any job.
create or replace function public.complete_job(p_id bigint, p_worker text)
returns boolean language sql immutable as $$ select false $$;
create or replace function public.fail_job(p_id bigint, p_worker text, p_error text, p_permanent boolean default false)
returns text language sql immutable as $$ select null::text $$;
create or replace function public.renew_job_lease(p_id bigint, p_worker text, p_lease_seconds int default 300)
returns boolean language sql immutable as $$ select false $$;

revoke all on function public.recover_expired_jobs(), public.claim_job(text, int),
  public.renew_job_lease(bigint, text, uuid, int), public.complete_job(bigint, text, uuid), public.fail_job(bigint, text, uuid, text, boolean),
  public.complete_job(bigint, text), public.fail_job(bigint, text, text, boolean), public.renew_job_lease(bigint, text, int)
  from public, anon, authenticated;
grant execute on function public.recover_expired_jobs(), public.claim_job(text, int),
  public.renew_job_lease(bigint, text, uuid, int), public.complete_job(bigint, text, uuid), public.fail_job(bigint, text, uuid, text, boolean),
  public.complete_job(bigint, text), public.fail_job(bigint, text, text, boolean), public.renew_job_lease(bigint, text, int)
  to service_role;
