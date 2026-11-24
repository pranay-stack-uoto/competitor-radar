-- 0023 record who accepted which version of the Terms of Service and Privacy Policy, and when.
--
-- A person ticks the box at sign-in; the app then adds one row per document and version. The time comes from the database (the browser cannot
-- choose it), the user id from the session, and a row can never be changed or removed by the person (no update or delete grant), so the table
-- is a reliable record. When the documents change, the version changes and people are asked again. Additive; never edit once applied.

create table if not exists public.legal_consents (
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  doc         text not null check (doc in ('terms', 'privacy')),
  version     text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  accepted_at timestamptz not null default now(),
  primary key (user_id, doc, version)
);
alter table public.legal_consents enable row level security;

drop policy if exists own_consents_read on public.legal_consents;
create policy own_consents_read on public.legal_consents for select to authenticated using (user_id = auth.uid());
drop policy if exists own_consents_add on public.legal_consents;
create policy own_consents_add on public.legal_consents for insert to authenticated with check (user_id = auth.uid());

revoke all on public.legal_consents from public, anon, authenticated;
grant select on public.legal_consents to authenticated;
grant insert (doc, version) on public.legal_consents to authenticated; -- user_id and accepted_at are filled in by the database
grant all on public.legal_consents to service_role;
