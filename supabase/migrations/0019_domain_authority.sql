-- 0019 domain authority cache.
--
-- A site's link-based authority (Open PageRank: 0 to 10, plus its global rank) is the same for every customer, so it is cached once per domain
-- and refreshed weekly instead of being asked for again for every project. Server only: RLS on, no policies, no grants for the browser.
-- Additive; the report reads these values through the service role when it is built.

create table if not exists public.domain_authority (
  domain       text primary key check (domain = lower(domain)),
  page_rank    numeric(4,2),          -- 0 to 10; null when the provider has no data for the domain
  global_rank  bigint,
  fetched_at   timestamptz not null default now()
);
alter table public.domain_authority enable row level security;
revoke all on public.domain_authority from public, anon, authenticated;
grant select, insert, update, delete on public.domain_authority to service_role;
