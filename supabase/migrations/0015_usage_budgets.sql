-- 0015 per-organisation daily usage budgets for the things that cost money: crawls, AI calls and search-provider queries.
--
-- usage_charge() is called by the server BEFORE it spends. It adds the amount to today's counter only if the total stays within the
-- organisation's limit (one atomic statement, so concurrent jobs cannot overshoot), and says whether the spend is allowed. Crossing 80% of a
-- limit raises a 'budget_warning' alert and hitting the limit raises 'budget_exhausted' (at most one of each per metric per day, see alerts in 0014).
-- A refused charge changes nothing. Limits default to the values below and can be raised or lowered per organisation with a row in org_budgets
-- (server-side only; there is no customer-facing billing yet). Nothing here talks to a paid service.
-- Additive. Server-only writes.

create table if not exists public.org_budgets (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  metric          text not null check (metric in ('crawl', 'ai', 'search')),
  daily_limit     int  not null check (daily_limit >= 0),
  updated_at      timestamptz not null default now(),
  primary key (organisation_id, metric)
);
alter table public.org_budgets enable row level security;

create table if not exists public.usage_daily (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  day             date not null,
  metric          text not null check (metric in ('crawl', 'ai', 'search')),
  amount          int  not null default 0 check (amount >= 0),
  primary key (organisation_id, day, metric)
);
alter table public.usage_daily enable row level security;

-- Defaults per organisation per day. Generous for today's customers; they exist to stop a runaway loop or a hostile account, not to meter normal use.
--   crawl  = site crawls started (a full-site audit counts 5)      ai = AI model calls      search = search-provider queries
create or replace function public.usage_default_limit(p_metric text)
returns int language sql immutable
as $$ select case p_metric when 'crawl' then 300 when 'ai' then 200 when 'search' then 2000 end $$;

create or replace function public.usage_charge(p_org uuid, p_metric text, p_amount int default 1)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare lim int; used int; prev int; ok boolean := true;
begin
  if p_metric not in ('crawl', 'ai', 'search') then raise exception 'unknown metric'; end if;
  if p_amount is null or p_amount < 1 or p_amount > 1000 then raise exception 'bad amount'; end if;
  if p_org is null then raise exception 'organisation required'; end if;
  select coalesce((select b.daily_limit from public.org_budgets b where b.organisation_id = p_org and b.metric = p_metric), public.usage_default_limit(p_metric)) into lim;

  select u.amount into prev from public.usage_daily u where u.organisation_id = p_org and u.day = current_date and u.metric = p_metric;
  prev := coalesce(prev, 0);
  if p_amount > lim then
    ok := false; used := prev;
  else
    insert into public.usage_daily (organisation_id, day, metric, amount) values (p_org, current_date, p_metric, p_amount)
    on conflict (organisation_id, day, metric) do update set amount = public.usage_daily.amount + excluded.amount
      where public.usage_daily.amount + excluded.amount <= lim
    returning amount into used;
    if used is null then
      ok := false;
      select u.amount into used from public.usage_daily u where u.organisation_id = p_org and u.day = current_date and u.metric = p_metric;
    else
      prev := used - p_amount;   -- the exact total before this charge, even when concurrent jobs charged in between
    end if;
  end if;

  if not ok then
    insert into public.alerts (kind, severity, organisation_id, subject, detail)
    values ('budget_exhausted', 'warning', p_org, p_metric, jsonb_build_object('metric', p_metric, 'limit', lim, 'used', used)) on conflict do nothing;
  elsif prev < lim * 0.8 and used >= lim * 0.8 then
    insert into public.alerts (kind, severity, organisation_id, subject, detail)
    values ('budget_warning', 'info', p_org, p_metric, jsonb_build_object('metric', p_metric, 'limit', lim, 'used', used)) on conflict do nothing;
  end if;
  return jsonb_build_object('allowed', ok, 'used', used, 'limit', lim, 'metric', p_metric);
end $$;

-- Owners and admins can read their organisation's usage and limits; nothing is writable through the API.
drop policy if exists usage_daily_select on public.usage_daily;
create policy usage_daily_select on public.usage_daily for select to authenticated using (public.org_role(organisation_id) in ('owner', 'admin'));
drop policy if exists org_budgets_select on public.org_budgets;
create policy org_budgets_select on public.org_budgets for select to authenticated using (public.org_role(organisation_id) in ('owner', 'admin'));
revoke all on public.org_budgets, public.usage_daily from public, anon, authenticated;
grant select on public.org_budgets, public.usage_daily to authenticated;
grant select, insert, update, delete on public.org_budgets, public.usage_daily to service_role;
revoke all on function public.usage_charge(uuid, text, int), public.usage_default_limit(text) from public, anon, authenticated;
grant execute on function public.usage_charge(uuid, text, int), public.usage_default_limit(text) to service_role;
