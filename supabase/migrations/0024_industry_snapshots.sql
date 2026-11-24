-- 0024 one industry snapshot per project and day.
--
-- Every report run compares your site with the competitors in your market on measurable things (content depth, structured data, headings,
-- internal links, response time and so on; see lib/industry.js) and stores the result here. Over time this is the history of how your market
-- moves: where the top performers are heading, and whether your gaps are closing, so each new report can say what changed since the last crawl
-- instead of starting from nothing. Only numbers are stored (no page text). The server writes it; members of the project can read it
-- (role helper from 0011), like every other per-project table. Additive; never edit once applied.

create table if not exists public.industry_snapshots (
  project_id  uuid not null references public.projects (id) on delete cascade,
  day         date not null,
  sites       int not null check (sites >= 0),     -- competitors compared
  top_sites   text[] not null default '{}',        -- the top performers that day
  metrics     jsonb not null,                      -- per metric: yours, top performers' median, market median, sample sizes
  adoption    jsonb not null default '{}'::jsonb,  -- per feature: do you have it, % of top performers, % of the market
  created_at  timestamptz not null default now(),
  primary key (project_id, day)
);
alter table public.industry_snapshots enable row level security;

drop policy if exists own_industry on public.industry_snapshots;
create policy own_industry on public.industry_snapshots for select to authenticated using (public.can_view_project(project_id));

revoke all on public.industry_snapshots from public, anon, authenticated;
grant select on public.industry_snapshots to authenticated;
grant all on public.industry_snapshots to service_role;
