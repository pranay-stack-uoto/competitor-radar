-- 0011 organisations, members and roles (multi-tenant foundation).
--
-- Before: every project belongs to one user (projects.user_id) and public.owns_project() asks "is this my project?".
-- After:  every project belongs to an organisation; people belong to organisations with a role; access is decided from the role.
--
-- Additive and safe to re-run. Nothing is deleted or rewritten except that projects.organisation_id is filled in for rows where it
-- is null. projects.user_id stays exactly as it is (it now means "who created the project"). organisation_id is deliberately left
-- NULLABLE: the NOT NULL step is a later migration, after the backfill has been checked on production (docs/DATABASE.md).
--
-- Roles (lowest to highest):
--   viewer  read everything in the organisation's projects, change nothing
--   member  normal project work: edit keywords and locations, hide competitors, mark fixes done, run the daily workflow
--   admin   member + project administration (verify ownership, connect Search Console, delete projects, manage member/viewer roles)
--   owner   admin + full organisation administration (grant admin/owner, rename the organisation, remove anyone but the last owner)
-- Nobody can change their own role. An organisation always keeps at least one owner while it has other members.

-- 1. Tables ----------------------------------------------------------------------------------------------------------------
create table if not exists public.organisations (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 200),
  type           text not null default 'business' check (type in ('business', 'agency')),
  -- Set only for the workspace created automatically for one person; at most one per person.
  personal_owner uuid unique references auth.users (id) on delete set null,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now()
);
alter table public.organisations enable row level security;

create table if not exists public.organisation_members (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at      timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
alter table public.organisation_members enable row level security;
create index if not exists organisation_members_user on public.organisation_members (user_id);

-- ON DELETE RESTRICT: deleting an organisation must never silently delete its customers' data.
alter table public.projects add column if not exists organisation_id uuid references public.organisations (id) on delete restrict;
create index if not exists projects_organisation on public.projects (organisation_id);

-- 2. Role helpers ---------------------------------------------------------------------------------------------------------------
-- SECURITY DEFINER so the lookups are not themselves filtered by RLS (no recursion). They only answer a role name or a yes/no.
create or replace function public.role_rank(r text)
returns int language sql immutable parallel safe
as $$ select case r when 'viewer' then 1 when 'member' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end $$;

-- The role of a given user in an organisation (null = not a member). Server-side only: the browser uses org_role() below.
create or replace function public.org_role_for(oid uuid, uid uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$ select m.role from public.organisation_members m where m.organisation_id = oid and m.user_id = uid $$;

-- The role of a user on a project. A project not yet moved into an organisation (organisation_id null) still belongs to its creator.
create or replace function public.project_role_for(pid uuid, uid uuid)
returns text language sql stable security definer set search_path = public, pg_temp
as $$
  select case when p.organisation_id is not null
              then (select m.role from public.organisation_members m where m.organisation_id = p.organisation_id and m.user_id = uid)
              when p.user_id = uid then 'owner' end
  from public.projects p where p.id = pid
$$;

-- The same decision from a project row's own columns (used by the projects policies, which must not look the row up again: during
-- INSERT ... RETURNING a lookup cannot see the row being inserted). VOLATILE on purpose: a STABLE function reads the snapshot of the
-- calling statement, which cannot see the personal organisation and membership that the BEFORE INSERT trigger creates in that same
-- statement, so a person's very first project insert would fail its RETURNING check.
create or replace function public.row_project_role(oid uuid, creator uuid)
returns text language sql volatile security definer set search_path = public, pg_temp
as $$
  select case when oid is not null then (select m.role from public.organisation_members m where m.organisation_id = oid and m.user_id = (select auth.uid()))
              when creator = (select auth.uid()) then 'owner' end
$$;

-- Browser-facing wrappers: "me" is auth.uid().
create or replace function public.org_role(oid uuid) returns text language sql stable security definer set search_path = public, pg_temp
as $$ select public.org_role_for(oid, (select auth.uid())) $$;
create or replace function public.project_role(pid uuid) returns text language sql stable security definer set search_path = public, pg_temp
as $$ select public.project_role_for(pid, (select auth.uid())) $$;

create or replace function public.can_view_project(pid uuid) returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select public.project_role(pid) is not null $$;
-- owns_project keeps its name and its callers (every customer-data policy): it now means "may do normal project work" (member or above).
create or replace function public.owns_project(pid uuid) returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select public.role_rank(public.project_role(pid)) >= 2 $$;
create or replace function public.can_admin_project(pid uuid) returns boolean language sql stable security definer set search_path = public, pg_temp
as $$ select public.role_rank(public.project_role(pid)) >= 3 $$;

revoke all on function public.role_rank(text), public.org_role_for(uuid, uuid), public.project_role_for(uuid, uuid), public.row_project_role(uuid, uuid),
  public.org_role(uuid), public.project_role(uuid), public.can_view_project(uuid), public.owns_project(uuid), public.can_admin_project(uuid) from public;
grant execute on function public.role_rank(text), public.row_project_role(uuid, uuid), public.org_role(uuid), public.project_role(uuid),
  public.can_view_project(uuid), public.owns_project(uuid), public.can_admin_project(uuid) to authenticated, service_role;
-- Asking about someone else's role is a server decision, never a browser one.
grant execute on function public.org_role_for(uuid, uuid), public.project_role_for(uuid, uuid) to service_role;

-- 3. Triggers ---------------------------------------------------------------------------------------------------------------------
-- A project created without an organisation (the browser's onboarding insert) goes into its creator's personal organisation, which
-- is created on first use. The browser cannot choose an organisation: organisation_id is not a column it may write.
create or replace function public.projects_assign_organisation()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare oid uuid;
begin
  if new.organisation_id is not null or new.user_id is null then return new; end if;
  select o.id into oid from public.organisations o where o.personal_owner = new.user_id;
  if oid is null then
    insert into public.organisations (name, type, personal_owner, created_by) values ('Personal workspace', 'business', new.user_id, new.user_id)
      on conflict (personal_owner) do nothing returning id into oid;
    if oid is null then select o.id into oid from public.organisations o where o.personal_owner = new.user_id; end if;
  end if;
  insert into public.organisation_members (organisation_id, user_id, role) values (oid, new.user_id, 'owner') on conflict do nothing;
  new.organisation_id := oid;
  return new;
end $$;
revoke all on function public.projects_assign_organisation() from public;
drop trigger if exists projects_assign_organisation on public.projects;
create trigger projects_assign_organisation before insert on public.projects for each row execute function public.projects_assign_organisation();

-- An organisation that still has other people in it must keep an owner. (A person leaving an organisation they alone belong to is
-- fine, and so is removing the organisation itself.)
create or replace function public.guard_last_owner()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.role = 'owner' and (tg_op = 'DELETE' or new.role <> 'owner')
     and exists (select 1 from public.organisations o where o.id = old.organisation_id)
     and exists (select 1 from public.organisation_members m where m.organisation_id = old.organisation_id and m.user_id <> old.user_id)
     and not exists (select 1 from public.organisation_members m where m.organisation_id = old.organisation_id and m.user_id <> old.user_id and m.role = 'owner')
  then
    raise exception 'An organisation must keep at least one owner' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.guard_last_owner() from public;
drop trigger if exists guard_last_owner on public.organisation_members;
create trigger guard_last_owner before update or delete on public.organisation_members for each row execute function public.guard_last_owner();

-- 4. Backfill: every existing project goes into its creator's personal organisation, as owner. Re-running changes nothing. ---------------
insert into public.organisations (name, type, personal_owner, created_by)
select 'Personal workspace', 'business', x.user_id, x.user_id
from (select distinct p.user_id from public.projects p where p.organisation_id is null and p.user_id is not null) x
on conflict (personal_owner) do nothing;

insert into public.organisation_members (organisation_id, user_id, role)
select o.id, o.personal_owner, 'owner' from public.organisations o
where o.personal_owner is not null
on conflict do nothing;

update public.projects p set organisation_id = o.id
from public.organisations o
where p.organisation_id is null and o.personal_owner = p.user_id;

-- 5. Policies ---------------------------------------------------------------------------------------------------------------------
-- projects: decided from the row's own organisation (see row_project_role).
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using (public.row_project_role(organisation_id, user_id) is not null);
drop policy if exists projects_insert on public.projects;
-- A browser insert always lands in the creator's own personal organisation (the trigger decides; the column is not writable).
create policy projects_insert on public.projects for insert to authenticated
  with check (user_id = (select auth.uid()) and verified = false and organisation_id is not null);
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (public.role_rank(public.row_project_role(organisation_id, user_id)) >= 2)
  with check (public.role_rank(public.row_project_role(organisation_id, user_id)) >= 2);
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated
  using (public.role_rank(public.row_project_role(organisation_id, user_id)) >= 3);

-- Reading customer data is allowed to every role, including viewers. Their write policies (0002) keep calling owns_project(), which
-- now means member or above.
drop policy if exists competitors_select on public.competitors;
create policy competitors_select on public.competitors for select to authenticated using (public.can_view_project(project_id));
drop policy if exists action_log_select on public.action_log;
create policy action_log_select on public.action_log for select to authenticated using (public.can_view_project(project_id));
drop policy if exists serp_results_select on public.serp_results;
create policy serp_results_select on public.serp_results for select to authenticated using (public.can_view_project(project_id));
drop policy if exists scores_select on public.scores;
create policy scores_select on public.scores for select to authenticated using (public.can_view_project(project_id));
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated using (public.can_view_project(project_id));
drop policy if exists gsc_connections_select on public.gsc_connections;
create policy gsc_connections_select on public.gsc_connections for select to authenticated using (public.can_view_project(project_id));
drop policy if exists gsc_snapshots_select on public.gsc_snapshots;
create policy gsc_snapshots_select on public.gsc_snapshots for select to authenticated using (public.can_view_project(project_id));
drop policy if exists site_audits_select on public.site_audits;
create policy site_audits_select on public.site_audits for select to authenticated using (public.can_view_project(project_id));

-- organisations: members can see their organisation; only an owner can rename it. Creating or deleting one is a server action.
drop policy if exists organisations_select on public.organisations;
create policy organisations_select on public.organisations for select to authenticated using (public.org_role(id) is not null);
drop policy if exists organisations_update on public.organisations;
create policy organisations_update on public.organisations for update to authenticated
  using (public.org_role(id) = 'owner') with check (public.org_role(id) = 'owner');

-- organisation_members. Rules, all enforced here and not in application code:
--   * nobody adds, changes or (for others) removes their own membership: user_id <> me, so no self-assignment of any role
--   * an owner may set any role; an admin may only add/change/remove members and viewers, and may only make people members or viewers
--   * anyone may leave (delete their own row); the last-owner trigger above protects the organisation
drop policy if exists organisation_members_select on public.organisation_members;
create policy organisation_members_select on public.organisation_members for select to authenticated using (public.org_role(organisation_id) is not null);
drop policy if exists organisation_members_insert on public.organisation_members;
create policy organisation_members_insert on public.organisation_members for insert to authenticated
  with check (user_id <> (select auth.uid()) and (public.org_role(organisation_id) = 'owner'
    or (public.org_role(organisation_id) = 'admin' and role in ('member', 'viewer'))));
drop policy if exists organisation_members_update on public.organisation_members;
create policy organisation_members_update on public.organisation_members for update to authenticated
  using (user_id <> (select auth.uid()) and (public.org_role(organisation_id) = 'owner'
    or (public.org_role(organisation_id) = 'admin' and role in ('member', 'viewer'))))
  with check (user_id <> (select auth.uid()) and (public.org_role(organisation_id) = 'owner'
    or (public.org_role(organisation_id) = 'admin' and role in ('member', 'viewer'))));
drop policy if exists organisation_members_delete on public.organisation_members;
create policy organisation_members_delete on public.organisation_members for delete to authenticated
  using (user_id = (select auth.uid()) or public.org_role(organisation_id) = 'owner'
    or (public.org_role(organisation_id) = 'admin' and role in ('member', 'viewer')));

-- 6. Privileges ---------------------------------------------------------------------------------------------------------------------
-- New tables get no default grants (0002). The browser can read both tables, rename an organisation (policy: owner), and change
-- membership rows only through the policies above. It still cannot write projects.organisation_id.
grant select on public.organisations, public.organisation_members to authenticated;
grant update (name) on public.organisations to authenticated;
grant insert (organisation_id, user_id, role) on public.organisation_members to authenticated;
grant update (role) on public.organisation_members to authenticated;
grant delete on public.organisation_members to authenticated;
grant all on public.organisations, public.organisation_members to service_role;
