-- 0016 opt-in industry benchmarks.
--
-- An organisation OWNER can opt in to contribute its own sites' scores to an industry benchmark, and only organisations that opt in can read it.
-- Rules enforced here, in the database:
--   * opt-in is off by default and only an owner can change it (the audit trail records every change, migration 0014)
--   * only the organisation's OWN sites' scores are used (scores.is_me), never competitor rows; one value per organisation per day and metric
--     (the average over its projects), so a large organisation cannot outweigh a small one
--   * an aggregate is stored only when at least 5 different organisations contribute (k-anonymity); fewer and nothing is published
--   * aggregates hold no organisation, project, user or domain identifiers: just industry, day, metric, how many organisations, mean and quartiles
--   * withdrawing is immediate: opting out recomputes the aggregates without that organisation, in the same transaction
--   * the aggregate table cannot be read directly; customers read through benchmark_for_project(), which checks membership, opt-in and industry
--   * only scores from the newest scoring method are mixed, because scores from different methods are not comparable (lib/scoring/config.js)
-- Additive. Never edit once applied.

alter table public.organisations add column if not exists industry text check (industry is null or industry ~ '^[a-z0-9][a-z0-9 &/-]{0,59}$');
alter table public.organisations add column if not exists benchmark_opt_in boolean not null default false;
alter table public.organisations add column if not exists benchmark_opted_at timestamptz;

create table if not exists public.benchmark_aggregates (
  industry text not null,
  day      date not null,
  metric   text not null check (metric in ('overall', 'seo', 'geo', 'local', 'keywords')),
  orgs     int  not null check (orgs >= 5),
  mean     numeric not null,
  p25      numeric not null,
  p50      numeric not null,
  p75      numeric not null,
  primary key (industry, day, metric)
);
alter table public.benchmark_aggregates enable row level security;   -- no policies and no grants: read only through benchmark_for_project()

-- Recomputes the last p_days days from the organisations that are opted in right now.
create or replace function public.benchmark_refresh(p_days int default 30)
returns int language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare n int; mv int;
begin
  if p_days < 1 or p_days > 400 then raise exception 'bad window'; end if;
  perform pg_advisory_xact_lock(7446016);
  select max(method_version) into mv from public.scores where day >= current_date - p_days;
  delete from public.benchmark_aggregates where day >= current_date - p_days;
  with per_org as (
    select o.industry, s.day, o.id as org, avg(s.overall) as overall, avg(s.seo) as seo, avg(s.geo) as geo, avg(s.local) as local, avg(s.keywords) as keywords
    from public.organisations o
    join public.projects p on p.organisation_id = o.id
    join public.scores s on s.project_id = p.id and s.is_me and s.method_version = mv and s.day >= current_date - p_days
    where o.benchmark_opt_in and o.industry is not null
    group by o.industry, s.day, o.id),
  long as (
    select industry, day, org, m.metric, m.v from per_org,
      lateral (values ('overall', overall), ('seo', seo), ('geo', geo), ('local', local), ('keywords', keywords)) as m(metric, v)
    where m.v is not null)
  insert into public.benchmark_aggregates (industry, day, metric, orgs, mean, p25, p50, p75)
  select industry, day, metric, count(*)::int, round(avg(v), 1), round(percentile_cont(0.25) within group (order by v)::numeric, 1),
         round(percentile_cont(0.5) within group (order by v)::numeric, 1), round(percentile_cont(0.75) within group (order by v)::numeric, 1)
  from long group by industry, day, metric having count(distinct org) >= 5;
  get diagnostics n = row_count;
  return n;
end $$;

-- Opting in, opting out or changing industry: stamp the time and refresh at once, so a withdrawal takes effect immediately.
create or replace function public.organisations_benchmark_change() returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (new.benchmark_opt_in is distinct from old.benchmark_opt_in) then new.benchmark_opted_at := now(); end if;
  return new;
end $$;
drop trigger if exists organisations_benchmark_stamp on public.organisations;
create trigger organisations_benchmark_stamp before update on public.organisations for each row execute function public.organisations_benchmark_change();

create or replace function public.organisations_benchmark_refresh() returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.benchmark_opt_in is distinct from old.benchmark_opt_in or (new.benchmark_opt_in and new.industry is distinct from old.industry) then perform public.benchmark_refresh(400); end if;
  return null;
end $$;
drop trigger if exists organisations_benchmark_refresh on public.organisations;
create trigger organisations_benchmark_refresh after update on public.organisations for each row execute function public.organisations_benchmark_refresh();

-- What a customer sees: their industry's aggregates for the last p_days, next to their own organisation's value for the same day and metric.
-- Empty unless the caller can see the project, the organisation has opted in and has an industry set.
create or replace function public.benchmark_for_project(p_project uuid, p_days int default 30)
returns table (day date, metric text, orgs int, mean numeric, p25 numeric, p50 numeric, p75 numeric, mine numeric)
language sql stable security definer set search_path = public, pg_temp
as $$
  with me as (
    select o.id as org, o.industry from public.projects p join public.organisations o on o.id = p.organisation_id
    where p.id = p_project and public.can_view_project(p_project) and o.benchmark_opt_in and o.industry is not null),
  mine as (
    select s.day, m.metric, avg(m.v) as v
    from me join public.projects p on p.organisation_id = me.org join public.scores s on s.project_id = p.id and s.is_me and s.day >= current_date - least(greatest(p_days, 1), 400),
      lateral (values ('overall', s.overall), ('seo', s.seo), ('geo', s.geo), ('local', s.local), ('keywords', s.keywords)) as m(metric, v)
    group by s.day, m.metric)
  select a.day, a.metric, a.orgs, a.mean, a.p25, a.p50, a.p75, round(mine.v, 1)
  from me join public.benchmark_aggregates a on a.industry = me.industry and a.day >= current_date - least(greatest(p_days, 1), 400)
  left join mine on mine.day = a.day and mine.metric = a.metric
  order by a.day, a.metric
$$;

-- Owners control participation; the policy from 0011 already limits organisation updates to owners.
grant update (name, industry, benchmark_opt_in) on public.organisations to authenticated;
revoke all on public.benchmark_aggregates from public, anon, authenticated;
grant select, insert, update, delete on public.benchmark_aggregates to service_role;
revoke all on function public.benchmark_refresh(int), public.organisations_benchmark_change(), public.organisations_benchmark_refresh(), public.benchmark_for_project(uuid, int) from public, anon, authenticated;
grant execute on function public.benchmark_refresh(int) to service_role;
grant execute on function public.benchmark_for_project(uuid, int) to authenticated, service_role;
