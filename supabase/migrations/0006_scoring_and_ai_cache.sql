-- 0006 scoring methodology versioning and an AI answer cache.
--
-- scores.method_version records HOW a score was calculated (see lib/scoring/config.js). Existing rows get 1, the original
-- method. Nothing is rewritten. If rows written after the technical-check release (2026-11-05) should be labelled 2, an
-- optional manual statement is in docs/DATABASE.md.
--
-- ai_cache lets identical AI prompts reuse an earlier answer instead of paying for the same call again. Keys are SHA-256
-- hashes of the full request. Server-only.

alter table public.scores add column if not exists method_version int not null default 1;
alter table public.scores drop constraint if exists scores_method_version_check;
alter table public.scores add constraint scores_method_version_check check (method_version >= 1);

create table if not exists public.ai_cache (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists ai_cache_expiry on public.ai_cache (expires_at);
alter table public.ai_cache enable row level security;
revoke all on public.ai_cache from anon, authenticated;
grant all on public.ai_cache to service_role;

create or replace function public.get_ai_cache(p_key text)
returns text language sql stable security definer set search_path = public, pg_temp
as $$ select value from public.ai_cache where key = p_key and expires_at > now() $$;

create or replace function public.put_ai_cache(p_key text, p_value text, p_ttl_seconds int)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_ttl_seconds < 1 or char_length(p_key) <> 64 or char_length(p_value) > 100000 then raise exception 'bad cache arguments'; end if;
  insert into public.ai_cache (key, value, expires_at) values (p_key, p_value, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update set value = excluded.value, created_at = now(), expires_at = excluded.expires_at;
  if random() < 0.01 then delete from public.ai_cache where expires_at < now() - interval '1 day'; end if;
end $$;

revoke all on function public.get_ai_cache(text), public.put_ai_cache(text, text, int) from public, anon, authenticated;
grant execute on function public.get_ai_cache(text), public.put_ai_cache(text, text, int) to service_role;
