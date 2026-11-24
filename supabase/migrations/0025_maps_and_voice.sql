-- 0025 Google Maps listings (Business Profile tracking) and share of voice.
--
-- maps_results: what Google Maps listed for your keywords in your cities, plus a direct look-up of you and your main competitors, with each
-- business's rating, review count, category and phone. Written weekly by the Google search (the same job that stores web results), read by the
-- report to show rating, review growth and Maps visibility over time. Per project, so the role helper from 0011 decides who may read it.
-- industry_snapshots.voice: for each site, in how many tracked searches it was in Google's top 3 and top 10 that day.
-- job_write_maps() is a fenced job result write (0012): a worker that lost its job cannot store rows. Additive; never edit once applied.

create table if not exists public.maps_results (
  project_id   uuid not null references public.projects (id) on delete cascade,
  day          date not null,
  keyword      text not null,                       -- '__brand__' for a direct look-up by business name
  location     text not null default '',            -- for '__brand__' rows: the name that was looked up
  position     int not null check (position between 1 and 100),
  domain       text not null default '',
  name         text not null default '',
  rating       numeric(3,2) check (rating is null or rating between 0 and 5),
  rating_count int check (rating_count is null or rating_count >= 0),
  category     text,
  phone        text,
  primary key (project_id, day, keyword, location, position)
);
alter table public.maps_results enable row level security;
create index if not exists maps_results_day on public.maps_results (project_id, day desc);

drop policy if exists own_maps on public.maps_results;
create policy own_maps on public.maps_results for select to authenticated using (public.can_view_project(project_id));
revoke all on public.maps_results from public, anon, authenticated;
grant select on public.maps_results to authenticated;
grant all on public.maps_results to service_role;

alter table public.industry_snapshots add column if not exists voice jsonb not null default '{}'::jsonb;

create or replace function public.job_write_maps(p_id bigint, p_worker text, p_token uuid, p_rows jsonb)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare j public.jobs;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'bad payload'; end if;
  if jsonb_array_length(p_rows) > 3000 then raise exception 'payload too large'; end if;
  j := public.job_fence(p_id, p_worker, p_token, 'discover');
  if j.id is null then return false; end if;
  delete from public.maps_results where project_id = j.project_id and day = j.day;
  insert into public.maps_results (project_id, day, keyword, location, position, domain, name, rating, rating_count, category, phone)
  select j.project_id, j.day, left(r->>'keyword', 200), left(coalesce(r->>'location', ''), 200), (r->>'position')::int, left(coalesce(lower(r->>'domain'), ''), 253),
         left(coalesce(r->>'name', ''), 120), nullif(r->>'rating', '')::numeric, nullif(r->>'rating_count', '')::int, left(r->>'category', 80), left(r->>'phone', 30)
  from jsonb_array_elements(p_rows) r
  where (r->>'position') ~ '^[0-9]+$' and (r->>'position')::int between 1 and 100
  on conflict do nothing;
  return true;
end $$;

revoke all on function public.job_write_maps(bigint, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.job_write_maps(bigint, text, uuid, jsonb) to service_role;
