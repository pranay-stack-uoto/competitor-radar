-- 0005 shared, domain-level crawl cache.
--
-- Several customers can track the same competitor. The raw crawl of a public website is the same for everyone, so it is
-- stored once per domain and reused until it expires. Customer-specific scores, ranks and recommendations stay in
-- public.scores and are computed per project from this shared raw data.
--
-- What is shared: only what a crawler can read from a public website (pages, robots.txt, sitemap, link checks).
-- What is never stored here: Search Console data, project keywords or locations, scores, user ids, project ids.
--
-- Storage (the free database is 500 MB): domain_crawls holds ONLY the latest raw crawl per domain and crawler version.
-- domain_crawl_snapshots keeps history as small profile summaries, not raw pages.
--
-- Both tables are server-only (no browser access).

create table if not exists public.domain_crawls (
  domain text not null,
  crawl_version text not null,
  status text not null check (status in ('running', 'ok', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  crawled_at timestamptz,            -- when the data was fetched (set when status becomes ok)
  expires_at timestamptz,            -- the data is not served after this, whatever its age
  lease_expires_at timestamptz,      -- a crawl in progress holds the domain until this time
  pages int,
  data jsonb,
  error text,
  primary key (domain, crawl_version),
  constraint domain_crawls_domain_format check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);

create table if not exists public.domain_crawl_snapshots (
  id bigint generated always as identity primary key,
  domain text not null,
  crawl_version text not null,
  crawled_at timestamptz not null,
  pages int not null,
  profile jsonb,
  data_hash text
);
create index if not exists domain_crawl_snapshots_domain on public.domain_crawl_snapshots (domain, crawled_at desc);

alter table public.domain_crawls enable row level security;
alter table public.domain_crawl_snapshots enable row level security;
revoke all on public.domain_crawls, public.domain_crawl_snapshots from anon, authenticated;
grant all on public.domain_crawls, public.domain_crawl_snapshots to service_role;

-- Decide what the caller should do for this domain. Exactly one caller at a time can get 'acquired':
--   'fresh'     a good crawl exists and is young enough: read it with get_domain_crawl()
--   'acquired'  you must crawl the domain now, then call finish_domain_crawl() or fail_domain_crawl()
--   'busy'      someone else is crawling it right now: wait and ask again
create or replace function public.acquire_domain_crawl(p_domain text, p_version text, p_max_age_seconds int, p_lease_seconds int default 180)
returns text language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.domain_crawls; d text := lower(p_domain);
begin
  insert into public.domain_crawls (domain, crawl_version, status, started_at, lease_expires_at)
  values (d, p_version, 'running', now(), now() + make_interval(secs => p_lease_seconds))
  on conflict (domain, crawl_version) do nothing;
  if found then return 'acquired'; end if;

  -- The row exists. Lock it so concurrent callers are decided one at a time.
  select * into r from public.domain_crawls where domain = d and crawl_version = p_version for update;
  if r.status = 'ok' and r.crawled_at > now() - make_interval(secs => p_max_age_seconds) and (r.expires_at is null or r.expires_at > now()) then
    return 'fresh';
  end if;
  if r.status = 'running' and r.lease_expires_at > now() then
    return 'busy';
  end if;
  update public.domain_crawls set status = 'running', started_at = now(), finished_at = null, error = null,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where domain = d and crawl_version = p_version;
  return 'acquired';
end $$;

create or replace function public.get_domain_crawl(p_domain text, p_version text)
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$ select data from public.domain_crawls where domain = lower(p_domain) and crawl_version = p_version and status = 'ok' $$;

-- Stores a finished crawl and appends a history snapshot. Only the holder of a running crawl can finish it.
create or replace function public.finish_domain_crawl(p_domain text, p_version text, p_data jsonb, p_pages int, p_profile jsonb, p_hash text, p_ttl_seconds int default 86400)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare d text := lower(p_domain);
begin
  update public.domain_crawls set status = 'ok', data = p_data, pages = p_pages, crawled_at = now(), finished_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds), lease_expires_at = null, error = null
  where domain = d and crawl_version = p_version and status = 'running';
  if not found then return false; end if;
  insert into public.domain_crawl_snapshots (domain, crawl_version, crawled_at, pages, profile, data_hash) values (d, p_version, now(), p_pages, p_profile, p_hash);
  return true;
end $$;

-- Releases the domain after a failed crawl. Any older good data stays in place but is not served as fresh.
create or replace function public.fail_domain_crawl(p_domain text, p_version text, p_error text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.domain_crawls set status = 'failed', error = left(coalesce(p_error, ''), 500), finished_at = now(), lease_expires_at = null
  where domain = lower(p_domain) and crawl_version = p_version and status = 'running';
  return found;
end $$;

-- Forces the next request for this domain to crawl again (for example after the owner says they changed their site).
create or replace function public.invalidate_domain_crawl(p_domain text)
returns int language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  update public.domain_crawls set expires_at = now() where domain = lower(p_domain) and status = 'ok';
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.acquire_domain_crawl(text, text, int, int), public.get_domain_crawl(text, text),
  public.finish_domain_crawl(text, text, jsonb, int, jsonb, text, int), public.fail_domain_crawl(text, text, text), public.invalidate_domain_crawl(text)
  from public, anon, authenticated;
grant execute on function public.acquire_domain_crawl(text, text, int, int), public.get_domain_crawl(text, text),
  public.finish_domain_crawl(text, text, jsonb, int, jsonb, text, int), public.fail_domain_crawl(text, text, text), public.invalidate_domain_crawl(text)
  to service_role;
