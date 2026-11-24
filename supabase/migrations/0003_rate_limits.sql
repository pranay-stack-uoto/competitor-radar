-- 0003 persistent rate limiting, using the database we already have (no Redis, no paid service).
--
-- rate_limit_hit() counts hits per key in fixed time windows and says whether the caller is still under the cap.
-- It is atomic (one upsert), so it is correct across any number of serverless instances.
-- Limitation: fixed windows allow up to 2x the cap across a window boundary. Acceptable for cost protection.
-- Only the service role may call it.

create table if not exists public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  hits int not null default 0,
  primary key (key, window_start)
);
create index if not exists rate_limits_window on public.rate_limits (window_start);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;
grant all on public.rate_limits to service_role;

create or replace function public.rate_limit_hit(p_key text, p_window_seconds int, p_max int)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  w timestamptz;
  n int;
begin
  if p_window_seconds < 1 or p_max < 0 or p_key is null or char_length(p_key) > 200 then
    raise exception 'bad rate limit arguments';
  end if;
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, w, 1)
    on conflict (key, window_start) do update set hits = r.hits + 1
    returning r.hits into n;
  -- housekeeping: about 1 call in 100 removes windows older than two days
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '2 days';
  end if;
  return n <= p_max;
end $$;
revoke all on function public.rate_limit_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, int, int) to service_role;
