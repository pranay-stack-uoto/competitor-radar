-- 0007 performance: write all ranks for a project-day in one statement instead of one UPDATE per site.

create or replace function public.set_ranks(p_project uuid, p_day date, p_domains text[])
returns int language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  update public.scores s set rank = t.ord::int
  from unnest(p_domains) with ordinality as t(domain, ord)
  where s.project_id = p_project and s.day = p_day and s.domain = t.domain;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.set_ranks(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.set_ranks(uuid, date, text[]) to service_role;
