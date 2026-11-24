-- 0022 remember when Google was last searched for a project.
--
-- Google searches are run in full once a week; in between, the last positions are carried forward day by day (stored under each new day so the
-- reports keep working). The carried copies must not look like fresh searches, so the day of the last REAL search is kept on the project.
-- job_mark_search() sets it from inside a discovery job, through the same ownership fence as every other job result (0012). Additive.

alter table public.projects add column if not exists serp_searched_on date;

create or replace function public.job_mark_search(p_id bigint, p_worker text, p_token uuid)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs;
begin
  j := public.job_fence(p_id, p_worker, p_token, 'discover');
  if j.id is null then return false; end if;
  update public.projects set serp_searched_on = j.day where id = j.project_id;
  return true;
end $$;

revoke all on function public.job_mark_search(bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.job_mark_search(bigint, text, uuid) to service_role;
