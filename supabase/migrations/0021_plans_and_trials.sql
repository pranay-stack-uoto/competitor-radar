-- 0021 plans and free trials.
--
-- Every organisation has a plan. New ones start on a 'trial': a fixed number of runs (a run = one refresh of a project: the daily update or a
-- "Crawl now") within a fixed number of days, whichever ends first. After that nothing new is crawled, but the data and reports stay readable.
-- Paid customers are 'active' (optionally until a date). Until a payment gateway is connected the owner switches plans by hand with
-- org_set_plan() (scripts/set-plan.mjs). Organisations that exist when this runs become 'internal' (no limits) so nobody already using the
-- product is locked out.
--
-- entitlement_charge_run() is the ONLY thing that spends a run: one atomic call that locks the organisation row, judges, and counts. Server
-- only (service role). The browser may read the plan columns (the organisations table is readable to members) but can still change only
-- name, industry and the benchmark opt-in (column grants from 0011/0016). Additive; never edit once applied.

alter table public.organisations add column if not exists plan text;
update public.organisations set plan = 'internal' where plan is null;
alter table public.organisations alter column plan set default 'trial';
alter table public.organisations alter column plan set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organisations_plan_check') then
    alter table public.organisations add constraint organisations_plan_check check (plan in ('trial', 'active', 'past_due', 'cancelled', 'internal'));
  end if;
end $$;
alter table public.organisations add column if not exists trial_runs_limit int not null default 10 check (trial_runs_limit between 0 and 1000);
alter table public.organisations add column if not exists trial_runs_used  int not null default 0  check (trial_runs_used >= 0);
alter table public.organisations add column if not exists trial_ends_at    timestamptz not null default (now() + interval '14 days');
alter table public.organisations add column if not exists plan_until       timestamptz;

create or replace function public.entitlement_charge_run(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare o public.organisations; reason text;
begin
  if p_org is null then return jsonb_build_object('allowed', true, 'plan', 'none'); end if;
  select * into o from public.organisations where id = p_org for update;
  if not found then return jsonb_build_object('allowed', true, 'plan', 'none'); end if;
  if o.plan = 'internal' then return jsonb_build_object('allowed', true, 'plan', o.plan); end if;
  if o.plan = 'active' then
    if o.plan_until is not null and o.plan_until <= clock_timestamp() then reason := 'plan-expired';
    else return jsonb_build_object('allowed', true, 'plan', o.plan, 'plan_until', o.plan_until); end if;
  elsif o.plan = 'trial' then
    if o.trial_ends_at <= clock_timestamp() then reason := 'trial-ended';
    elsif o.trial_runs_used >= o.trial_runs_limit then reason := 'trial-runs-used';
    else
      update public.organisations set trial_runs_used = trial_runs_used + 1 where id = o.id;
      return jsonb_build_object('allowed', true, 'plan', 'trial', 'used', o.trial_runs_used + 1, 'limit', o.trial_runs_limit, 'runs_left', o.trial_runs_limit - o.trial_runs_used - 1, 'trial_ends_at', o.trial_ends_at);
    end if;
  else reason := 'plan-inactive';
  end if;
  return jsonb_build_object('allowed', false, 'plan', o.plan, 'reason', reason, 'used', o.trial_runs_used, 'limit', o.trial_runs_limit, 'trial_ends_at', o.trial_ends_at, 'plan_until', o.plan_until);
end $$;

-- Moves an organisation to another plan (payment received, plan ended, trial extended). Service role only.
create or replace function public.org_set_plan(p_org uuid, p_plan text, p_until timestamptz default null, p_trial_runs int default null, p_trial_days int default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare o public.organisations;
begin
  if p_plan not in ('trial', 'active', 'past_due', 'cancelled', 'internal') then raise exception 'unknown plan'; end if;
  update public.organisations set plan = p_plan,
         plan_until = case when p_plan = 'active' then p_until else null end,
         trial_runs_limit = coalesce(p_trial_runs, trial_runs_limit),
         trial_ends_at = case when p_trial_days is not null then now() + make_interval(days => p_trial_days) else trial_ends_at end
   where id = p_org returning * into o;
  if not found then raise exception 'unknown organisation'; end if;
  return jsonb_build_object('plan', o.plan, 'plan_until', o.plan_until, 'trial_runs_limit', o.trial_runs_limit, 'trial_runs_used', o.trial_runs_used, 'trial_ends_at', o.trial_ends_at);
end $$;

revoke all on function public.entitlement_charge_run(uuid), public.org_set_plan(uuid, text, timestamptz, int, int) from public, anon, authenticated;
grant execute on function public.entitlement_charge_run(uuid), public.org_set_plan(uuid, text, timestamptz, int, int) to service_role;
