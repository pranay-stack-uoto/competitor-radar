-- 0002 tenancy and row-level security hardening.
--
-- Fixes SEC-01, SEC-03, SEC-11, DB-02 from docs/BASELINE.md. Changes no rows of customer data.
-- Safe to re-run.
--
-- Principles
--  1. Ownership is decided in ONE function, public.owns_project(). When workspaces or agency accounts
--     arrive, change that function; no policy has to be rewritten.
--  2. The browser may only do what the product needs. Everything else goes through server routes that
--     use the service role. Policies are split per command, and writes are limited by column privileges.
--  3. The anon role has no table access at all.

-- Roles exist on Supabase. They are created here only so the migration also runs on a plain Postgres (tests).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- 1. Ownership helper ------------------------------------------------------------------------------
-- SECURITY DEFINER so the lookup is not itself filtered by RLS (no recursion, and the planner can cache
-- the auth.uid() call). It only answers yes or no.
create or replace function public.owns_project(pid uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.projects p
    where p.id = pid and p.user_id = (select auth.uid())
  );
$$;
revoke all on function public.owns_project(uuid) from public;
grant execute on function public.owns_project(uuid) to authenticated, service_role;

-- 2. Input-shape helpers used by constraints -------------------------------------------------------
create or replace function public.all_short(items text[], max_len int)
returns boolean language sql immutable parallel safe
as $$ select coalesce(bool_and(char_length(x) <= max_len and char_length(x) > 0), true) from unnest(items) as x $$;

-- 3. Constraints on user-editable columns (SEC-03) ---------------------------------------------------
-- NOT VALID: enforced for every new write, existing rows are not re-checked here. Run
-- `alter table ... validate constraint ...` after confirming existing data passes (see docs/DATABASE.md).
alter table public.projects drop constraint if exists projects_keywords_limit;
alter table public.projects add constraint projects_keywords_limit
  check (cardinality(keywords) <= 30 and public.all_short(keywords, 120)) not valid;
alter table public.projects drop constraint if exists projects_locations_limit;
alter table public.projects add constraint projects_locations_limit
  check (cardinality(locations) <= 12 and public.all_short(locations, 80)) not valid;
alter table public.projects drop constraint if exists projects_max_competitors_range;
alter table public.projects add constraint projects_max_competitors_range
  check (max_competitors between 0 and 25) not valid;
alter table public.projects drop constraint if exists projects_text_lengths;
alter table public.projects add constraint projects_text_lengths
  check (char_length(name) <= 200 and char_length(url) <= 2048 and char_length(coalesce(summary, '')) <= 2000) not valid;
-- A registrable-looking lowercase hostname with an alphabetic top-level label. This rejects IP literals,
-- "localhost", ports, paths and credentials. It is a first line of defence; the crawler validates again (SEC-02).
alter table public.projects drop constraint if exists projects_domain_format;
alter table public.projects add constraint projects_domain_format
  check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and char_length(domain) <= 253) not valid;

alter table public.competitors drop constraint if exists competitors_domain_format;
alter table public.competitors add constraint competitors_domain_format
  check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and char_length(domain) <= 253) not valid;

-- 4. Policies: one per command, using owns_project() ---------------------------------------------------
drop policy if exists own_projects on public.projects;
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated using (user_id = (select auth.uid()));
-- verified = false on insert: a project can never be created already verified (SEC-01).
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated
  with check (user_id = (select auth.uid()) and verified = false);
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists own_competitors on public.competitors;
drop policy if exists competitors_select on public.competitors;
create policy competitors_select on public.competitors for select to authenticated using (public.owns_project(project_id));
drop policy if exists competitors_update on public.competitors;
create policy competitors_update on public.competitors for update to authenticated
  using (public.owns_project(project_id)) with check (public.owns_project(project_id));

drop policy if exists own_action_log on public.action_log;
drop policy if exists action_log_select on public.action_log;
create policy action_log_select on public.action_log for select to authenticated using (public.owns_project(project_id));
drop policy if exists action_log_insert on public.action_log;
create policy action_log_insert on public.action_log for insert to authenticated with check (public.owns_project(project_id));
drop policy if exists action_log_update on public.action_log;
create policy action_log_update on public.action_log for update to authenticated
  using (public.owns_project(project_id)) with check (public.owns_project(project_id));
drop policy if exists action_log_delete on public.action_log;
create policy action_log_delete on public.action_log for delete to authenticated using (public.owns_project(project_id));

drop policy if exists own_serp on public.serp_results;
drop policy if exists serp_results_select on public.serp_results;
create policy serp_results_select on public.serp_results for select to authenticated using (public.owns_project(project_id));
drop policy if exists own_scores on public.scores;
drop policy if exists scores_select on public.scores;
create policy scores_select on public.scores for select to authenticated using (public.owns_project(project_id));
drop policy if exists own_reports on public.reports;
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated using (public.owns_project(project_id));
drop policy if exists own_gsc_connections on public.gsc_connections;
drop policy if exists gsc_connections_select on public.gsc_connections;
create policy gsc_connections_select on public.gsc_connections for select to authenticated using (public.owns_project(project_id));
drop policy if exists own_gsc_snapshots on public.gsc_snapshots;
drop policy if exists gsc_snapshots_select on public.gsc_snapshots;
create policy gsc_snapshots_select on public.gsc_snapshots for select to authenticated using (public.owns_project(project_id));
drop policy if exists own_site_audits on public.site_audits;
drop policy if exists site_audits_select on public.site_audits;
create policy site_audits_select on public.site_audits for select to authenticated using (public.owns_project(project_id));

-- 5. Privileges: least privilege on top of RLS (SEC-01, SEC-11) -------------------------------------------
-- RLS decides WHICH rows. Privileges decide WHICH columns and commands. Both must pass.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant select on public.projects, public.competitors, public.serp_results, public.scores, public.reports,
  public.action_log, public.gsc_connections, public.gsc_snapshots, public.site_audits to authenticated;

-- Browser may create a project (never as verified) and edit only what the onboarding and keyword screens edit.
grant insert (user_id, name, url, domain) on public.projects to authenticated;
grant update (name, keywords, locations, summary) on public.projects to authenticated;
-- Browser may only hide or re-enable a competitor.
grant update (status, source) on public.competitors to authenticated;
-- "Mark fix done" and "Undo".
grant insert, update, delete on public.action_log to authenticated;
grant delete on public.projects to authenticated;

-- jobs and gsc_tokens: no browser access of any kind. Service role keeps full access.
grant all on all tables in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- 6. Indexes (DB-02) ----------------------------------------------------------------------------------------
create index if not exists jobs_project_day_kind on public.jobs (project_id, day, kind);
create index if not exists scores_project_domain_day on public.scores (project_id, domain, day desc);
