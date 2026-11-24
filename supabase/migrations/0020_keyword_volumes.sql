-- 0020 keyword volume cache.
--
-- Monthly search volume, CPC and competition (Keywords Everywhere, Google Keyword Planner data) are the same for every customer who
-- tracks the same keyword in the same country, so they are cached once per keyword and country and refreshed every two weeks. Each
-- lookup costs paid API credits, so the cache is also the spend control. Server only: RLS on, no policies, no browser grants.
-- Additive; the report copies the values it needs into its own summary when it is built.

create table if not exists public.keyword_volumes (
  keyword      text not null check (keyword = lower(keyword) and length(keyword) between 1 and 120),
  country      text not null check (country ~ '^[a-z]{2}$'),
  volume       bigint,
  cpc          numeric(10,2),
  competition  numeric(4,3),
  trend        jsonb,
  fetched_at   timestamptz not null default now(),
  primary key (keyword, country)
);
alter table public.keyword_volumes enable row level security;
revoke all on public.keyword_volumes from public, anon, authenticated;
grant select, insert, update, delete on public.keyword_volumes to service_role;
