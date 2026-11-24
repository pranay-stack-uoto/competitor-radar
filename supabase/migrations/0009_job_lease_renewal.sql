-- 0009 job lease renewal.
--
-- claim_job() (0004) gives a worker a lease (300 s by default). A job that runs longer must be able to extend it without
-- losing ownership. renew_job_lease() extends the lease only when the caller still owns a running job whose lease has NOT
-- expired. A worker whose lease already ran out, or whose job was recovered and claimed by someone else, gets false and must
-- stop writing results. Server-only. Never edit 0004; it is already applied.

create or replace function public.renew_job_lease(p_id bigint, p_worker text, p_lease_seconds int default 300)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'bad lease length'; end if;
  update public.jobs set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_id and status = 'running' and locked_by = p_worker and lease_expires_at > now();
  return found;
end $$;

revoke all on function public.renew_job_lease(bigint, text, int) from public, anon, authenticated;
grant execute on function public.renew_job_lease(bigint, text, int) to service_role;
