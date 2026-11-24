-- 0012 fenced job writes: a job's results are committed only while the job still owns its lease, checked inside the same transaction.
--
-- 0010 made renew/complete/fail require the lease token. The handlers in lib/pipeline.js still wrote their RESULTS (search results,
-- competitors, scores, audits, child jobs) with ordinary table writes guarded only by a local lease.assertHeld() timer check. That check
-- cannot be atomic with the write: a worker can pass it, stall, lose its lease, and still commit afterwards.
--
-- Now each result write is one narrow function that takes the job id, worker and token, locks the job row, requires status running,
-- the same worker, the CURRENT token and an unexpired lease (compared with clock_timestamp(), so time spent waiting for locks counts),
-- and performs the write in the same transaction. The lock is held to the end of that transaction, so the lease cannot be recovered,
-- completed or reclaimed between the check and the write. The project, day and domain are taken from the job row, never from the
-- caller, and each function accepts only the job kind it belongs to. Nothing here executes caller-supplied SQL or names a table.
-- Every function returns false (or null) when ownership is not held, and writes nothing.
--
-- Also re-creates the 0010 queue functions with clock_timestamp() in their expiry comparisons: now() is the START of the transaction,
-- so a call that waited for a lock could judge an already-ended lease to be live.
-- Server-only (service role). Additive; never edit 0004, 0009 or 0010.

-- 1. The ownership check --------------------------------------------------------------------------------------------------------
-- Returns the locked job row when the caller owns it right now, or a row with a null id when not. FOR SHARE conflicts with every
-- UPDATE of the row (renew, complete, fail, recovery) until our transaction ends, and the expiry is re-read after the lock is granted.
create or replace function public.job_fence(p_id bigint, p_worker text, p_token uuid, p_kind text)
returns public.jobs language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs;
begin
  if p_token is null or p_worker is null then return null; end if;
  select * into j from public.jobs
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token and kind = p_kind
  for share;
  if not found then return null; end if;
  if j.lease_expires_at is null or j.lease_expires_at <= clock_timestamp() then return null; end if;
  return j;
end $$;

-- 2. Discovery: search results and competitor updates, one transaction -------------------------------------------------------------
-- p_serp:        [{keyword, location, position, domain, title, url}]  (replaces this day's results for the job's project)
-- p_competitors: [{domain, name, serp_score, appearances, status, manual}]
--                manual = true  -> only refresh serp_score/appearances/last_seen of a hand-added competitor
--                manual = false -> insert (source 'discovered') or update name/score/appearances/last_seen/status; source is never changed
create or replace function public.job_write_discovery(p_id bigint, p_worker text, p_token uuid, p_serp jsonb, p_competitors jsonb)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs; e jsonb;
begin
  if jsonb_typeof(p_serp) is distinct from 'array' or jsonb_typeof(p_competitors) is distinct from 'array' then raise exception 'bad payload'; end if;
  if jsonb_array_length(p_serp) > 20000 or jsonb_array_length(p_competitors) > 100 then raise exception 'payload too large'; end if;
  j := public.job_fence(p_id, p_worker, p_token, 'discover');
  if j.id is null then return false; end if;

  if jsonb_array_length(p_serp) > 0 then
    delete from public.serp_results where project_id = j.project_id and day = j.day;
    insert into public.serp_results (project_id, day, keyword, location, position, domain, title, url)
    select j.project_id, j.day, s->>'keyword', coalesce(s->>'location', ''), (s->>'position')::int, s->>'domain', s->>'title', s->>'url'
    from jsonb_array_elements(p_serp) s
    on conflict do nothing;
  end if;

  for e in select * from jsonb_array_elements(p_competitors) loop
    if coalesce((e->>'manual')::boolean, false) then
      update public.competitors set serp_score = (e->>'serp_score')::numeric, appearances = (e->>'appearances')::int, last_seen = j.day
      where project_id = j.project_id and domain = e->>'domain';
    else
      insert into public.competitors (project_id, domain, name, serp_score, appearances, last_seen, status, source)
      values (j.project_id, e->>'domain', e->>'name', (e->>'serp_score')::numeric, (e->>'appearances')::int, j.day, coalesce(e->>'status', 'active'), 'discovered')
      on conflict (project_id, domain) do update set
        name = excluded.name, serp_score = excluded.serp_score, appearances = excluded.appearances, last_seen = excluded.last_seen, status = excluded.status;
    end if;
  end loop;
  return true;
end $$;

-- 3. Discovery: queue the crawl jobs for the sites to score today ---------------------------------------------------------------------
-- p_domains: a JSON array of host names. Returns how many jobs were created (0 when all were already queued), or null when ownership is not held.
create or replace function public.job_enqueue_crawls(p_id bigint, p_worker text, p_token uuid, p_domains jsonb)
returns int language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs; d text; n int := 0;
begin
  if jsonb_typeof(p_domains) is distinct from 'array' or jsonb_array_length(p_domains) > 60 then raise exception 'bad payload'; end if;
  j := public.job_fence(p_id, p_worker, p_token, 'discover');
  if j.id is null then return null; end if;
  for d in select distinct x from jsonb_array_elements_text(p_domains) x where x ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' loop
    if public.enqueue_job(j.project_id, j.day, 'crawl', d) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- 4. Crawl: the score of the job's own domain -------------------------------------------------------------------------------------------
create or replace function public.job_write_score(p_id bigint, p_worker text, p_token uuid, p_is_me boolean,
  p_seo numeric, p_geo numeric, p_local numeric, p_keywords numeric, p_overall numeric, p_method_version int, p_details jsonb)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs;
begin
  j := public.job_fence(p_id, p_worker, p_token, 'crawl');
  if j.id is null then return false; end if;
  if j.domain is null then raise exception 'crawl job without a domain'; end if;
  insert into public.scores (project_id, day, domain, is_me, seo, geo, local, keywords, overall, method_version, details)
  values (j.project_id, j.day, j.domain, coalesce(p_is_me, false), p_seo, p_geo, p_local, p_keywords, p_overall, p_method_version, p_details)
  on conflict (project_id, day, domain) do update set
    is_me = excluded.is_me, seo = excluded.seo, geo = excluded.geo, local = excluded.local, keywords = excluded.keywords,
    overall = excluded.overall, method_version = excluded.method_version, details = excluded.details;
  return true;
end $$;

-- 5. Audit: the full-site audit of the project's own domain ------------------------------------------------------------------------------
create or replace function public.job_write_audit(p_id bigint, p_worker text, p_token uuid, p_pages int, p_data jsonb)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs; own_domain text;
begin
  j := public.job_fence(p_id, p_worker, p_token, 'audit');
  if j.id is null then return false; end if;
  select domain into own_domain from public.projects where id = j.project_id;
  if own_domain is null then return false; end if;
  insert into public.site_audits (project_id, day, domain, pages, data) values (j.project_id, j.day, own_domain, p_pages, p_data)
  on conflict (project_id, day) do update set domain = excluded.domain, pages = excluded.pages, data = excluded.data;
  return true;
end $$;

-- 6. The 0010 queue functions, with wall-clock expiry ---------------------------------------------------------------------------------------
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
    where j.status = 'running' and coalesce(j.lease_expires_at, j.updated_at + interval '5 minutes') < clock_timestamp()
    returning 1)
  select count(*) into n from expired;
  return n;
end $$;

create or replace function public.renew_job_lease(p_id bigint, p_worker text, p_token uuid, p_lease_seconds int default 300)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_lease_seconds < 1 or p_lease_seconds > 3600 then raise exception 'bad lease length'; end if;
  if p_token is null then return false; end if;
  update public.jobs set lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token and lease_expires_at > clock_timestamp();
  return found;
end $$;

create or replace function public.complete_job(p_id bigint, p_worker text, p_token uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_token is null then return false; end if;
  update public.jobs set status = 'done', finished_at = now(), error = null, failure_kind = null,
         lease_expires_at = null, locked_by = null, lease_token = null, updated_at = now()
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token and lease_expires_at > clock_timestamp();
  return found;
end $$;

create or replace function public.fail_job(p_id bigint, p_worker text, p_token uuid, p_error text, p_permanent boolean default false)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare j public.jobs; new_status text;
begin
  if p_token is null then return null; end if;
  select * into j from public.jobs
  where id = p_id and status = 'running' and locked_by = p_worker and lease_token = p_token for update;
  if not found or j.lease_expires_at <= clock_timestamp() then return null; end if;
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

-- 7. Privileges: server only -----------------------------------------------------------------------------------------------------------------------
revoke all on function public.job_fence(bigint, text, uuid, text), public.job_write_discovery(bigint, text, uuid, jsonb, jsonb),
  public.job_enqueue_crawls(bigint, text, uuid, jsonb),
  public.job_write_score(bigint, text, uuid, boolean, numeric, numeric, numeric, numeric, numeric, int, jsonb),
  public.job_write_audit(bigint, text, uuid, int, jsonb),
  public.recover_expired_jobs(), public.renew_job_lease(bigint, text, uuid, int), public.complete_job(bigint, text, uuid),
  public.fail_job(bigint, text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.job_fence(bigint, text, uuid, text), public.job_write_discovery(bigint, text, uuid, jsonb, jsonb),
  public.job_enqueue_crawls(bigint, text, uuid, jsonb),
  public.job_write_score(bigint, text, uuid, boolean, numeric, numeric, numeric, numeric, numeric, int, jsonb),
  public.job_write_audit(bigint, text, uuid, int, jsonb),
  public.recover_expired_jobs(), public.renew_job_lease(bigint, text, uuid, int), public.complete_job(bigint, text, uuid),
  public.fail_job(bigint, text, uuid, text, boolean) to service_role;
