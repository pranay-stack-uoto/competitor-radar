-- 0008 shared crawl cache: lease ownership (fixes the "stale worker overwrites a newer crawl" finding).
--
-- Problem: finish_domain_crawl() and fail_domain_crawl() (0005) accepted any caller. A worker whose lease had expired could
-- still write over the result of the worker that took the domain over.
--
-- Fix: every acquired crawl gets a unique lease token, stored in domain_crawls.lease_token and returned to the worker that
-- acquired it. Finishing or failing needs that token, and it only works while the token is the CURRENT one and its lease
-- has not expired. Reacquiring a domain replaces the token, so the previous holder is locked out from that moment.
-- A finished or failed crawl consumes its token (it cannot be used twice).
--
-- Compatibility: existing cache rows are untouched (lease_token starts null). The old three functions keep their names and
-- signatures so code that is still running during a rollout does not error; they can no longer store anything (they cannot
-- know a token), so a stale caller is harmless. Drop them in a later migration once no deployed code uses them.
-- Never edit 0005; it is already applied.

alter table public.domain_crawls add column if not exists lease_token uuid;

-- state is 'fresh' | 'busy' | 'acquired'. token is set only when state = 'acquired'.
create or replace function public.acquire_domain_crawl_lease(p_domain text, p_version text, p_max_age_seconds int, p_lease_seconds int default 180)
returns table (state text, token uuid)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare r public.domain_crawls; d text := lower(p_domain); t uuid := gen_random_uuid();
begin
  insert into public.domain_crawls (domain, crawl_version, status, started_at, lease_expires_at, lease_token)
  values (d, p_version, 'running', now(), now() + make_interval(secs => p_lease_seconds), t)
  on conflict (domain, crawl_version) do nothing;
  if found then state := 'acquired'; token := t; return next; return; end if;

  -- The row exists. Lock it so concurrent callers are decided one at a time.
  select * into r from public.domain_crawls where domain = d and crawl_version = p_version for update;
  if r.status = 'ok' and r.crawled_at > now() - make_interval(secs => p_max_age_seconds) and (r.expires_at is null or r.expires_at > now()) then
    state := 'fresh'; token := null; return next; return;
  end if;
  if r.status = 'running' and r.lease_expires_at > now() then
    state := 'busy'; token := null; return next; return;
  end if;
  -- Take over (stale data, failed, or an expired lease). The new token replaces the old one, which stops working immediately.
  update public.domain_crawls set status = 'running', started_at = now(), finished_at = null, error = null,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds), lease_token = t
  where domain = d and crawl_version = p_version;
  state := 'acquired'; token := t; return next; return;
end $$;

-- Stores a finished crawl and appends a history snapshot. Only the current, unexpired lease holder can do this.
create or replace function public.finish_domain_crawl_lease(p_domain text, p_version text, p_token uuid, p_data jsonb, p_pages int, p_profile jsonb, p_hash text, p_ttl_seconds int default 86400)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
declare d text := lower(p_domain);
begin
  if p_token is null then return false; end if;
  update public.domain_crawls set status = 'ok', data = p_data, pages = p_pages, crawled_at = now(), finished_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds), lease_expires_at = null, lease_token = null, error = null
  where domain = d and crawl_version = p_version and status = 'running' and lease_token = p_token and lease_expires_at > now();
  if not found then return false; end if;
  insert into public.domain_crawl_snapshots (domain, crawl_version, crawled_at, pages, profile, data_hash) values (d, p_version, now(), p_pages, p_profile, p_hash);
  return true;
end $$;

-- Releases the domain after a failed crawl. Same ownership rule: a stale worker cannot mark a newer crawl as failed.
create or replace function public.fail_domain_crawl_lease(p_domain text, p_version text, p_token uuid, p_error text)
returns boolean language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_token is null then return false; end if;
  update public.domain_crawls set status = 'failed', error = left(coalesce(p_error, ''), 500), finished_at = now(), lease_expires_at = null, lease_token = null
  where domain = lower(p_domain) and crawl_version = p_version and status = 'running' and lease_token = p_token and lease_expires_at > now();
  return found;
end $$;

-- Legacy entry points from 0005, kept so running code does not break during a rollout. They can no longer write anything.
create or replace function public.acquire_domain_crawl(p_domain text, p_version text, p_max_age_seconds int, p_lease_seconds int default 180)
returns text language sql security definer set search_path = public, pg_temp
as $$ select (public.acquire_domain_crawl_lease(p_domain, p_version, p_max_age_seconds, p_lease_seconds)).state $$;
create or replace function public.finish_domain_crawl(p_domain text, p_version text, p_data jsonb, p_pages int, p_profile jsonb, p_hash text, p_ttl_seconds int default 86400)
returns boolean language sql immutable as $$ select false $$;
create or replace function public.fail_domain_crawl(p_domain text, p_version text, p_error text)
returns boolean language sql immutable as $$ select false $$;

revoke all on function public.acquire_domain_crawl_lease(text, text, int, int), public.finish_domain_crawl_lease(text, text, uuid, jsonb, int, jsonb, text, int),
  public.fail_domain_crawl_lease(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.acquire_domain_crawl_lease(text, text, int, int), public.finish_domain_crawl_lease(text, text, uuid, jsonb, int, jsonb, text, int),
  public.fail_domain_crawl_lease(text, text, uuid, text) to service_role;
