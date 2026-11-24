-- 0018 lock first, then check expiry (renew_job_lease and complete_job).
--
-- 0012 compared lease_expires_at with clock_timestamp() inside the UPDATE's WHERE clause. PostgreSQL evaluates that condition when the
-- statement starts, BEFORE it waits for a row lock; if the wait ends because the other transaction merely released a lock (a fenced result write
-- holds the job row FOR SHARE until it commits), the condition is not re-evaluated. A lease that expired during the wait could therefore be
-- renewed or completed after the fact. The functions now lock the row (FOR UPDATE, same as fail_job already did), then check status, worker,
-- token and the wall-clock expiry on the locked row, then update. Behaviour is otherwise identical. Additive: re-creates two functions.

create or replace function public.renew_job_lease(p_id bigint, p_worker text, p_token uuid, p_lease_seconds int default 300)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare j public.jobs;
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'bad lease length'; end if;
  if p_token is null then return false; end if;
  select * into j from public.jobs where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token for update;
  if not found or j.lease_expires_at is null or j.lease_expires_at <= clock_timestamp() then return false; end if;
  update public.jobs set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = now() where id = p_id;
  return true;
end $$;

create or replace function public.complete_job(p_id bigint, p_worker text, p_token uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare j public.jobs;
begin
  if p_token is null then return false; end if;
  select * into j from public.jobs where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token for update;
  if not found or j.lease_expires_at is null or j.lease_expires_at <= clock_timestamp() then return false; end if;
  update public.jobs set status = 'done', finished_at = now(), error = null, failure_kind = null,
         lease_expires_at = null, locked_by = null, lease_token = null, updated_at = now() where id = p_id;
  return true;
end $$;

revoke all on function public.renew_job_lease(bigint, text, uuid, int), public.complete_job(bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.renew_job_lease(bigint, text, uuid, int), public.complete_job(bigint, text, uuid) to service_role;
