-- 0001 baseline: the schema as it exists in production on 2026-11-05.
--
-- Production already has everything in this file. Do NOT run it there. Record it as applied
-- (see supabase/README.md). It exists so that an empty database can be rebuilt from the repository:
-- run 0001, then every later migration in order.
--
-- This file deliberately reproduces the old, too-permissive policies. 0002 replaces them.
-- Keeping history faithful lets reviewers see exactly what changed and why.


create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  url text not null,
  domain text not null,
  keywords text[] not null default '{}',
  locations text[] not null default '{}',
  country text not null default 'in',
  max_competitors int not null default 10,
  created_at timestamptz not null default now(),
  verified boolean not null default false,
  verified_at timestamptz,
  verify_token text not null default replace(gen_random_uuid()::text, '-', ''),
  summary text
);
create unique index if not exists projects_user_domain on public.projects (user_id, domain);

create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  domain text not null,
  name text,
  source text not null default 'discovered' check (source in ('discovered','manual')),
  status text not null default 'active' check (status in ('active','ignored')),
  serp_score numeric not null default 0,
  appearances int not null default 0,
  first_seen date not null default current_date,
  last_seen date not null default current_date,
  unique (project_id, domain)
);

create table if not exists public.serp_results (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  keyword text not null,
  location text not null default '',
  position int not null,
  domain text not null,
  title text,
  url text,
  primary key (project_id, day, keyword, location, position)
);

create table if not exists public.scores (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  domain text not null,
  is_me boolean not null default false,
  seo numeric, geo numeric, local numeric, keywords numeric, overall numeric,
  rank int,
  details jsonb,
  primary key (project_id, day, domain)
);

create table if not exists public.jobs (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('discover','crawl','audit')),
  domain text,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  attempts int not null default 0,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists jobs_queue on public.jobs (status, day);

create table if not exists public.reports (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  summary jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, day)
);

create table if not exists public.action_log (
  project_id uuid not null references public.projects(id) on delete cascade,
  check_name text not null,
  area text not null,
  title text not null,
  done_at timestamptz not null default now(),
  baseline jsonb not null,
  primary key (project_id, check_name)
);

create table if not exists public.gsc_connections (
  project_id uuid primary key references public.projects(id) on delete cascade,
  site_url text,
  status text not null default 'ok',
  error text,
  connected_at timestamptz not null default now(),
  last_sync date
);

create table if not exists public.gsc_tokens (
  project_id uuid primary key references public.projects(id) on delete cascade,
  token_enc text not null
);

create table if not exists public.gsc_snapshots (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  data jsonb not null,
  primary key (project_id, day)
);

create table if not exists public.site_audits (
  project_id uuid not null references public.projects(id) on delete cascade,
  day date not null,
  domain text not null,
  pages int not null default 0,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, day)
);

alter table public.projects enable row level security;
alter table public.competitors enable row level security;
alter table public.serp_results enable row level security;
alter table public.scores enable row level security;
alter table public.jobs enable row level security;
alter table public.reports enable row level security;
alter table public.action_log enable row level security;
alter table public.gsc_connections enable row level security;
alter table public.gsc_tokens enable row level security;
alter table public.gsc_snapshots enable row level security;
alter table public.site_audits enable row level security;

drop policy if exists own_projects on public.projects;
create policy own_projects on public.projects for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_competitors on public.competitors;
create policy own_competitors on public.competitors for all
  using (exists (select 1 from public.projects p where p.id = competitors.project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = competitors.project_id and p.user_id = auth.uid()));

drop policy if exists own_action_log on public.action_log;
create policy own_action_log on public.action_log for all
  using (exists (select 1 from public.projects p where p.id = action_log.project_id and p.user_id = auth.uid()))
  with check (exists (select 1 from public.projects p where p.id = action_log.project_id and p.user_id = auth.uid()));

drop policy if exists own_serp on public.serp_results;
create policy own_serp on public.serp_results for select
  using (exists (select 1 from public.projects p where p.id = serp_results.project_id and p.user_id = auth.uid()));
drop policy if exists own_scores on public.scores;
create policy own_scores on public.scores for select
  using (exists (select 1 from public.projects p where p.id = scores.project_id and p.user_id = auth.uid()));
drop policy if exists own_reports on public.reports;
create policy own_reports on public.reports for select
  using (exists (select 1 from public.projects p where p.id = reports.project_id and p.user_id = auth.uid()));
drop policy if exists own_gsc_connections on public.gsc_connections;
create policy own_gsc_connections on public.gsc_connections for select
  using (exists (select 1 from public.projects p where p.id = gsc_connections.project_id and p.user_id = auth.uid()));
drop policy if exists own_gsc_snapshots on public.gsc_snapshots;
create policy own_gsc_snapshots on public.gsc_snapshots for select
  using (exists (select 1 from public.projects p where p.id = gsc_snapshots.project_id and p.user_id = auth.uid()));
drop policy if exists own_site_audits on public.site_audits;
create policy own_site_audits on public.site_audits for select
  using (exists (select 1 from public.projects p where p.id = site_audits.project_id and p.user_id = auth.uid()));
-- jobs and gsc_tokens: RLS on, no policy. Only the service role touches them.
