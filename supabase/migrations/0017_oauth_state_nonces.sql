-- 0017 single-use OAuth state.
--
-- The Google sign-in "state" was signed and expired after 15 minutes, but could be replayed any number of times inside that window.
-- Now every state carries a random nonce that the server remembers: only its SHA-256 hash is stored, bound to the user and project that
-- started the flow, valid for 10 minutes, and consumed atomically by the callback. A replay, a second concurrent use, an expired nonce, or a
-- different user/project all fail. The nonce is burned the first time it is PRESENTED, even if the user or project then does not match.
-- The signature, the 15 minute expiry and the admin-role recheck in the callback stay as they were.
--
-- Least privilege: the table has RLS enabled, no policies and no grants (no browser access of any kind); both functions are
-- SECURITY DEFINER with a fixed search_path and executable by the service role only. Additive; never edit once applied.

create table if not exists public.oauth_states (
  nonce_hash  text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  user_id     uuid not null references auth.users (id) on delete cascade,
  project_id  uuid not null references public.projects (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);
alter table public.oauth_states enable row level security;
create index if not exists oauth_states_user on public.oauth_states (user_id, created_at desc);
create index if not exists oauth_states_expiry on public.oauth_states (expires_at);

-- Records a new nonce. The user must be an admin of the project right now (defence in depth: the route checks it too). At most 20 unused
-- nonces per user, so the table cannot be filled by one account. Expired rows are removed as a side effect, a day after they expire.
create or replace function public.oauth_state_create(p_hash text, p_user uuid, p_project uuid, p_ttl_seconds int default 600)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'bad nonce'; end if;
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 900 then raise exception 'bad lifetime'; end if;
  if public.role_rank(public.project_role_for(p_project, p_user)) < 3 then return false; end if;
  delete from public.oauth_states where expires_at < now() - interval '1 day';
  if (select count(*) from public.oauth_states where user_id = p_user and consumed_at is null and expires_at > clock_timestamp()) >= 20 then return false; end if;
  insert into public.oauth_states (nonce_hash, user_id, project_id, expires_at) values (p_hash, p_user, p_project, clock_timestamp() + make_interval(secs => p_ttl_seconds));
  return true;
end $$;

-- Uses a nonce once. Lock first, then judge: the row is locked FOR UPDATE (concurrent callers queue behind it and, when it is their turn, see
-- its latest state), and only then are "already used" and the wall-clock expiry checked, so time spent waiting counts and exactly one of any
-- number of concurrent callers can succeed. (A plain UPDATE ... WHERE expires_at > clock_timestamp() would test the expiry BEFORE waiting.)
create or replace function public.oauth_state_consume(p_hash text, p_user uuid, p_project uuid)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare r public.oauth_states;
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  select * into r from public.oauth_states where nonce_hash = p_hash for update;
  if not found or r.consumed_at is not null or r.expires_at <= clock_timestamp() then return false; end if;
  update public.oauth_states set consumed_at = clock_timestamp() where nonce_hash = p_hash;
  return r.user_id = p_user and r.project_id = p_project;
end $$;

revoke all on public.oauth_states from public, anon, authenticated;
grant select, insert, update, delete on public.oauth_states to service_role;
revoke all on function public.oauth_state_create(text, uuid, uuid, int), public.oauth_state_consume(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.oauth_state_create(text, uuid, uuid, int), public.oauth_state_consume(text, uuid, uuid) to service_role;
