-- 0026 daily-run health alerts.
--
-- monitor_run() (0014) already turns audit anomalies and a broken audit chain into alert rows. It now also watches the daily run itself, so a stalled or
-- failing pipeline is reported instead of silently producing stale data:
--   jobs_failed    crawls, searches or audits that failed in the last 24 hours (not counting ones retired because a newer day started)
--   jobs_dropped   jobs retired unfinished because the next day's run began (the worker did not get to them)
--   report_stale   a verified project whose newest report is more than one day old
-- One alert per project, kind and day (the existing unique index), delivered to the log and the optional webhook by lib/alerts.js. Additive;
-- replaces the function body only; never edit once applied.

create or replace function public.monitor_run()
returns int language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare n int := 0; added int; bad bigint;
begin
  insert into public.alerts (kind, severity, organisation_id, subject, detail)
  select a.kind, a.severity, a.organisation_id, a.subject, a.detail || jsonb_build_object('count', a.n) from public.audit_anomalies(interval '24 hours') a
  on conflict do nothing;
  get diagnostics added = row_count; n := n + added;
  select v.first_bad_id into bad from public.audit_verify() v;
  if bad is not null then
    insert into public.alerts (kind, severity, subject, detail) values ('audit_chain_broken', 'critical', bad::text, jsonb_build_object('first_bad_id', bad)) on conflict do nothing;
    get diagnostics added = row_count; n := n + added;
  end if;

  -- Failed jobs per project (a daily "site too large" failure counts, so it stays visible until someone decides what to do about it).
  insert into public.alerts (kind, severity, organisation_id, subject, detail)
  select 'jobs_failed', case when count(*) >= 5 then 'critical' else 'warning' end, p.organisation_id, p.domain,
         jsonb_build_object('failed', count(*), 'example', left(max(j.error), 120))
  from public.jobs j join public.projects p on p.id = j.project_id
  where j.status = 'failed' and j.updated_at > now() - interval '24 hours' and coalesce(j.error, '') not like 'superseded%'
  group by p.id, p.organisation_id, p.domain
  on conflict do nothing;
  get diagnostics added = row_count; n := n + added;

  -- Jobs the worker never reached.
  insert into public.alerts (kind, severity, organisation_id, subject, detail)
  select 'jobs_dropped', case when count(*) >= 5 then 'critical' else 'warning' end, p.organisation_id, p.domain, jsonb_build_object('dropped', count(*))
  from public.jobs j join public.projects p on p.id = j.project_id
  where j.status = 'failed' and j.error like 'superseded%' and j.updated_at > now() - interval '24 hours'
  group by p.id, p.organisation_id, p.domain
  on conflict do nothing;
  get diagnostics added = row_count; n := n + added;

  -- Stale reports.
  insert into public.alerts (kind, severity, organisation_id, subject, detail)
  select 'report_stale', 'critical', p.organisation_id, p.domain, jsonb_build_object('last_report', r.last_day)
  from public.projects p
  left join lateral (select max(day) as last_day from public.reports where project_id = p.id) r on true
  where p.verified and (r.last_day is null or r.last_day < current_date - 1)
  on conflict do nothing;
  get diagnostics added = row_count; n := n + added;
  return n;
end $$;

revoke all on function public.monitor_run() from public, anon, authenticated;
grant execute on function public.monitor_run() to service_role;
