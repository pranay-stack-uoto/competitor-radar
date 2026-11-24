-- 0027 run health: derived job states, per-project data health, a watchdog, an operations overview, and feature flags.
--
-- Why derived states instead of widening jobs.status: the queue, the worker, the progress meter, the alerts and the tests all rely on the four stored
-- states (queued, running, done, failed). job_state() maps them, plus attempts and failure_kind, to the names the product uses
-- (queued, retrying, running, succeeded, failed, dead_letter, cancelled) with no change to how jobs are claimed, so nothing can regress.
--   retrying    = queued again after a failed attempt (attempts > 0)
--   dead_letter = failed after the retry limit (failure_kind 'exhausted')
--   cancelled   = retired because a newer day started ("superseded")
--
-- project_data_health(project) is what the customer-facing "Data health" indicator reads: last complete update, last attempt, next scheduled
-- run, success rate over 7 and 30 days, today's gaps in plain words, and one status: healthy, delayed, degraded or failing. It runs with the
-- caller's identity (members of the project only) and never returns raw error text.
--
-- watchdog_run() is meant to run every 10 minutes (pg_cron, see supabase/ops/schedule_watchdog.sql). It recovers expired leases, raises alerts for
-- stuck jobs, a missed daily run, low crawl coverage and a stalled queue, and can ask the worker to start (watchdog_kick) when the feature flag
-- 'watchdog_kick' is on. All times default to now() and can be passed in, so the rules are testable.
-- Additive; never edit once applied.

-- Feature flags: server only. A row with an organisation overrides the global row for that organisation; no row means off.
create table if not exists public.feature_flags (
  key             text not null check (key ~ '^[a-z][a-z0-9_]{2,60}$'),
  organisation_id uuid references public.organisations (id) on delete cascade,
  enabled         boolean not null,
  note            text,
  updated_at      timestamptz not null default now(),
  unique nulls not distinct (key, organisation_id)
);
alter table public.feature_flags enable row level security;
revoke all on public.feature_flags from public, anon, authenticated;
grant all on public.feature_flags to service_role;

create or replace function public.feature_enabled(p_key text, p_org uuid default null)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(
    (select f.enabled from public.feature_flags f where f.key = p_key and f.organisation_id = p_org),
    (select f.enabled from public.feature_flags f where f.key = p_key and f.organisation_id is null),
    false)
$$;

create or replace function public.job_state(p_status text, p_failure_kind text, p_attempts int, p_error text)
returns text language sql immutable
as $$
  select case
    when p_status = 'queued' and coalesce(p_attempts, 0) > 0 then 'retrying'
    when p_status = 'queued' then 'queued'
    when p_status = 'running' then 'running'
    when p_status = 'done' then 'succeeded'
    when p_status = 'failed' and coalesce(p_error, '') like 'superseded%' then 'cancelled'
    when p_status = 'failed' and p_failure_kind = 'exhausted' then 'dead_letter'
    when p_status = 'failed' then 'failed'
    else p_status end
$$;

-- A plain-words reason for a job that did not succeed. Raw errors are never shown to customers.
create or replace function public.job_reason(p_error text, p_state text)
returns text language sql immutable
as $$
  select case
    when p_state in ('queued', 'running') then 'still waiting'
    when p_state = 'retrying' then 'will be tried again'
    when p_state = 'cancelled' then 'not reached in time'
    when coalesce(p_error, '') ilike '%budget-exhausted%' then 'site is larger than our crawl limit'
    when coalesce(p_error, '') ilike '%daily%limit%' then 'daily usage limit reached'
    when coalesce(p_error, '') ~* 'dns|find that website|unreachable|timeout|timed out|econn|fetch failed|connection|aborted' then 'site did not respond'
    when coalesce(p_error, '') ilike '%lease expired%' then 'interrupted, could not finish'
    else 'could not be read' end
$$;

create or replace function public.project_data_health(p_project uuid, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  proj public.projects;
  today date := (p_now at time zone 'utc')::date;
  run_start timestamptz := (today::timestamp + interval '3 hours 30 minutes') at time zone 'utc';
  next_run timestamptz; last_day date; last_at timestamptz; last_attempt timestamptz;
  planned int := 0; ok int := 0; failed int := 0; dead int := 0; waiting int := 0;
  age_days int; n7 int; n30 int; status text; gaps jsonb; top_reason text;
begin
  select * into proj from public.projects where id = p_project;
  if not found or (uid is not null and not public.can_view_project(p_project)) then return null; end if;
  next_run := case when run_start > p_now then run_start else run_start + interval '1 day' end;

  select max(r.day) into last_day from public.reports r
   where r.project_id = p_project and not coalesce((r.summary -> 'coverage' ->> 'partial')::boolean, false);
  last_at := coalesce(
    (select max(j.finished_at) from public.jobs j where j.project_id = p_project and j.day = last_day and j.status = 'done'),
    (select r.created_at from public.reports r where r.project_id = p_project and r.day = last_day));
  select max(j.updated_at) into last_attempt from public.jobs j where j.project_id = p_project;

  select count(*), count(*) filter (where j.status = 'done'),
         count(*) filter (where j.status = 'failed' and coalesce(j.error, '') not like 'superseded%' and j.failure_kind is distinct from 'exhausted'),
         count(*) filter (where j.status = 'failed' and j.failure_kind = 'exhausted'),
         count(*) filter (where j.status in ('queued', 'running'))
    into planned, ok, failed, dead, waiting
    from public.jobs j where j.project_id = p_project and j.day = today and j.kind = 'crawl';

  age_days := greatest(1, (today - proj.created_at::date) + 1);
  select count(*) into n7 from public.reports r where r.project_id = p_project and r.day > today - 7 and not coalesce((r.summary -> 'coverage' ->> 'partial')::boolean, false);
  select count(*) into n30 from public.reports r where r.project_id = p_project and r.day > today - 30 and not coalesce((r.summary -> 'coverage' ->> 'partial')::boolean, false);

  if last_at is null or last_at < p_now - interval '36 hours' then status := 'failing';
  elsif last_day = today then status := case when failed + dead > 0 then 'degraded' else 'healthy' end;
  elsif p_now < run_start then status := 'healthy';                          -- yesterday's data is current; the next run is not due yet
  elsif p_now < run_start + interval '6 hours' then status := 'delayed';      -- today's run is under way
  else status := 'degraded'; end if;                                         -- today's run should have finished by now

  select coalesce(jsonb_agg(jsonb_build_object('domain', g.domain, 'state', g.state, 'reason', g.reason) order by g.id), '[]'::jsonb) into gaps from (
    select j.id, j.domain, public.job_state(j.status, j.failure_kind, j.attempts, j.error) as state,
           public.job_reason(j.error, public.job_state(j.status, j.failure_kind, j.attempts, j.error)) as reason
      from public.jobs j where j.project_id = p_project and j.day = today and j.kind = 'crawl' and j.status <> 'done' order by j.id limit 30) g;
  select g.reason into top_reason from (
    select x ->> 'reason' as reason, count(*) as c from jsonb_array_elements(gaps) x where x ->> 'reason' <> 'still waiting' group by 1 order by c desc limit 1) g;

  return jsonb_build_object(
    'status', status, 'last_success_at', last_at, 'last_success_day', last_day, 'last_attempt_at', last_attempt, 'next_run_at', next_run,
    'success_rate_7d', round(100.0 * n7 / least(7, age_days)), 'success_rate_30d', round(100.0 * n30 / least(30, age_days)),
    'today', jsonb_build_object('planned', planned, 'succeeded', ok, 'failed', failed, 'dead_letter', dead, 'waiting', waiting),
    'gaps', gaps, 'main_reason', top_reason);
end $$;

-- Starts a worker over HTTP (Supabase pg_net) using two Vault secrets, 'app_url' and 'watchdog_secret'. Does nothing, and returns false, if they
-- or the extension are not set up (see supabase/ops/schedule_watchdog.sql). The functions it uses are looked up only when it runs.
create or replace function public.watchdog_kick()
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare url text; tok text;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'watchdog_secret';
  select decrypted_secret into url from vault.decrypted_secrets where name = 'app_url';
  if tok is null or url is null then return false; end if;
  perform net.http_get(url := url || '/api/cron/work', headers := jsonb_build_object('authorization', 'Bearer ' || tok));
  return true;
end $$;

create or replace function public.watchdog_run(p_now timestamptz default now())
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  today date := (p_now at time zone 'utc')::date;
  run_start timestamptz := (today::timestamp + interval '3 hours 30 minutes') at time zone 'utc';
  n int := 0; added int; recovered int; stalled boolean; kicked boolean := false;
begin
  recovered := public.recover_expired_jobs();

  insert into public.alerts (kind, severity, organisation_id, subject, detail)
  select 'job_stuck', 'critical', p.organisation_id, p.domain,
         jsonb_build_object('job', j.id, 'kind', j.kind, 'running_minutes', round(extract(epoch from (p_now - j.started_at)) / 60))
    from public.jobs j join public.projects p on p.id = j.project_id
   where j.status = 'running' and j.started_at < p_now - interval '20 minutes'
  on conflict do nothing;
  get diagnostics added = row_count; n := n + added;

  if p_now > run_start + interval '90 minutes' then   -- the cron has up to an hour of slack; 05:00 UTC is "missed"
    insert into public.alerts (kind, severity, organisation_id, subject, detail)
    select 'run_missed', 'critical', p.organisation_id, p.domain, jsonb_build_object('expected_by', run_start + interval '90 minutes')
      from public.projects p join public.organisations o on o.id = p.organisation_id
     where p.verified and o.plan in ('internal', 'active', 'trial')
       and not (o.plan = 'trial' and (o.trial_ends_at < p_now or o.trial_runs_used >= o.trial_runs_limit))
       and not exists (select 1 from public.jobs j where j.project_id = p.id and j.day = today and j.kind = 'discover')
    on conflict do nothing;
    get diagnostics added = row_count; n := n + added;
  end if;

  if p_now > run_start + interval '210 minutes' then
    insert into public.alerts (kind, severity, organisation_id, subject, detail)
    select 'coverage_low', 'warning', p.organisation_id, p.domain, jsonb_build_object('planned', c.planned, 'succeeded', c.ok)
      from public.projects p
      join lateral (select count(*) as planned, count(*) filter (where j.status = 'done') as ok
                      from public.jobs j where j.project_id = p.id and j.day = today and j.kind = 'crawl') c on true
     where p.verified and c.planned >= 3 and c.ok < c.planned * 0.8
    on conflict do nothing;
    get diagnostics added = row_count; n := n + added;
  end if;

  stalled := exists (select 1 from public.jobs j where j.status = 'queued' and j.run_after <= p_now - interval '10 minutes')
         and not exists (select 1 from public.jobs j where j.status = 'running' and j.updated_at > p_now - interval '5 minutes');
  if stalled then
    insert into public.alerts (kind, severity, subject, detail)
    values ('queue_stalled', 'critical', 'queue', jsonb_build_object('waiting', (select count(*) from public.jobs j where j.status = 'queued' and j.run_after <= p_now)))
    on conflict do nothing;
    get diagnostics added = row_count; n := n + added;
    if public.feature_enabled('watchdog_kick') then
      begin kicked := public.watchdog_kick(); exception when others then kicked := false; end;
    end if;
  end if;

  return jsonb_build_object('recovered', recovered, 'alerts_raised', n, 'queue_stalled', stalled, 'worker_started', kicked);
end $$;

-- What the owner-only operations page shows. Server only.
create or replace function public.ops_overview()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'generated_at', now(),
    'queue', coalesce((select jsonb_object_agg(s.state, s.n) from (
        select public.job_state(j.status, j.failure_kind, j.attempts, j.error) as state, count(*) as n from public.jobs j where j.day >= current_date - 1 group by 1) s), '{}'::jsonb),
    'problems', coalesce((select jsonb_agg(x order by x ->> 'updated_at' desc) from (
        select jsonb_build_object('project', p.domain, 'organisation', p.organisation_id, 'kind', j.kind, 'domain', j.domain, 'attempts', j.attempts, 'updated_at', j.updated_at,
               'state', public.job_state(j.status, j.failure_kind, j.attempts, j.error),
               'reason', public.job_reason(j.error, public.job_state(j.status, j.failure_kind, j.attempts, j.error)), 'error', left(coalesce(j.error, ''), 160)) as x
          from public.jobs j join public.projects p on p.id = j.project_id
         where j.updated_at > now() - interval '24 hours'
           and (public.job_state(j.status, j.failure_kind, j.attempts, j.error) in ('failed', 'dead_letter', 'retrying')
                or (j.status = 'running' and j.started_at < now() - interval '15 minutes'))
         order by j.updated_at desc limit 50) q), '[]'::jsonb),
    'crawl_success_7d', (select round(100.0 * count(*) filter (where j.status = 'done') / nullif(count(*) filter (where j.status in ('done', 'failed') and coalesce(j.error, '') not like 'superseded%'), 0))
                           from public.jobs j where j.kind = 'crawl' and j.day > current_date - 7),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('domain', p.domain, 'organisation', p.organisation_id, 'plan', o.plan, 'health', public.project_data_health(p.id)) order by p.domain)
                           from public.projects p left join public.organisations o on o.id = p.organisation_id where p.verified), '[]'::jsonb))
$$;

revoke all on function public.feature_enabled(text, uuid), public.job_state(text, text, int, text), public.job_reason(text, text), public.watchdog_kick(),
  public.watchdog_run(timestamptz), public.ops_overview(), public.project_data_health(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.feature_enabled(text, uuid), public.job_state(text, text, int, text), public.job_reason(text, text), public.watchdog_kick(),
  public.watchdog_run(timestamptz), public.ops_overview(), public.project_data_health(uuid, timestamptz) to service_role;
grant execute on function public.project_data_health(uuid, timestamptz) to authenticated; -- checks can_view_project inside
