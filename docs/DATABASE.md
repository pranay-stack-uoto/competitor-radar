# Database

Source of truth: `supabase/migrations/`. A fresh database is built by running every file in order. Production already contains
0001 (the baseline). All later files are re-runnable and additive.

| # | File | What it does |
|---|---|---|
| 0001 | baseline_schema | Production schema as of 2026-11-05 (tables, old policies). Never run in production. |
| 0002 | tenancy_and_rls | `owns_project()`, per-command policies, column privileges, constraints, indexes |
| 0003 | rate_limits | `rate_limits` table and `rate_limit_hit()` |
| 0004 | job_queue | lease/retry columns, `enqueue_job`, `claim_job`, `complete_job`, `fail_job`, `recover_expired_jobs`, `job_backoff` |
| 0005 | shared_crawl_cache | `domain_crawls`, `domain_crawl_snapshots`, acquire/finish/fail/get/invalidate functions |
| 0006 | scoring_and_ai_cache | `scores.method_version`, `ai_cache`, `get_ai_cache`, `put_ai_cache` |
| 0007 | performance | `set_ranks()` |
| 0008 | crawl_lease_tokens | `domain_crawls.lease_token`, `acquire_domain_crawl_lease`, `finish_domain_crawl_lease`, `fail_domain_crawl_lease`; legacy functions become harmless |
| 0009 | job_lease_renewal | `renew_job_lease()` |

## Tables
**Customer-owned (all have `project_id → projects(id) on delete cascade`, RLS on, SELECT policy via `owns_project`)**

| Table | Purpose | Key |
|---|---|---|
| `projects` | One tracked website per row. `user_id` owns it. Holds keywords, locations, verification state and token. | `id`; unique `(user_id, domain)` |
| `competitors` | Sites tracked against a project (`source` discovered or manual, `status` active or ignored). | `id`; unique `(project_id, domain)` |
| `serp_results` | Google positions found per day, keyword, location. | `(project_id, day, keyword, location, position)` |
| `scores` | One row per site per day: four area scores, overall, rank, `method_version`, `details` (checks and profile). | `(project_id, day, domain)` |
| `reports` | The published daily report (`summary` JSON). | `(project_id, day)` |
| `action_log` | Fixes the user marked done, with a baseline. | `(project_id, check_name)` |
| `gsc_connections` | Search Console link status per project. | `project_id` |
| `gsc_snapshots` | Daily Search Console data. | `(project_id, day)` |
| `site_audits` | The full-site audit result. | `(project_id, day)` |
| `gsc_tokens` | Encrypted refresh token. **Server only.** | `project_id` |
| `jobs` | The work queue. **Server only.** | `id` |

**Shared or system tables (server only, no project or user columns)**: `domain_crawls`, `domain_crawl_snapshots`, `ai_cache`, `rate_limits`.

## Indexes
Primary and unique keys above, plus: `jobs_queue (status, day)`, `jobs_claim (run_after, id) where status='queued'`,
`jobs_lease (lease_expires_at) where status='running'`, `jobs_active_dedupe unique (dedupe_key) where active`,
`jobs_project_day_kind`, `scores_project_domain_day (project_id, domain, day desc)`, `domain_crawl_snapshots_domain`,
`ai_cache_expiry`, `rate_limits_window`.

## Row-level security
| Role | Can do |
|---|---|
| `anon` | Nothing (all table privileges revoked). |
| `authenticated` | SELECT own rows on the customer tables. INSERT on `projects` columns `(user_id, name, url, domain)` and `verified` must be false. UPDATE `projects (name, keywords, locations, summary)`, `competitors (status, source)`. INSERT/UPDATE/DELETE own `action_log`. DELETE own `projects`. Nothing on `jobs`, `gsc_tokens`, caches, `rate_limits`. |
| `service_role` | Everything (bypasses RLS). Used only in server code. |

All the above is tested in `tests/integration/rls.test.mjs` (act as two customers, anon and service role).
`alter default privileges` in 0002 stops new tables from being granted to `anon`/`authenticated` automatically: grant explicitly in the migration that creates a table.

## Applying migrations to production (manual)
1. Take a backup first (see OPERATIONS.md).
2. In the Supabase SQL editor run every migration not yet applied (0002 to 0018 on a database that has only the baseline) in order, one file at a time. Check each succeeds.
3. Only after all succeed, deploy the matching code. Old code keeps working against the new schema (everything is additive), so rolling the deploy back does not need a database rollback.
4. Optional, after checking: `alter table public.projects validate constraint projects_keywords_limit;` and the same for `projects_locations_limit`, `projects_max_competitors_range`, `projects_text_lengths`, `projects_domain_format`, `competitors_domain_format`.
   Read-only checks run against production on 2026-11-05 found 0 rows violating any of them.
5. Optional: label scores written after the technical-check release as method 2: `update public.scores set method_version = 2 where day >= '2026-11-05';` (not run; decide whether you want it).

## Audit trail, alerts, budgets, benchmarks (migrations 0014 to 0016)
`audit_log` (append-only, hash chain; `audit_record`, `audit_verify`, `audit_head`; triggers on members, projects, `gsc_tokens`, organisations), `alerts` (one row per kind, organisation, subject and day; `monitor_run()` raises them from `audit_anomalies()`),
`org_budgets` and `usage_daily` (`usage_charge()` charges atomically; defaults in `usage_default_limit()`), `benchmark_aggregates` (`benchmark_refresh()`, read through `benchmark_for_project()`; `organisations.industry`, `benchmark_opt_in`, `benchmark_opted_at`).
All writes are server-only. Tests: `tests/integration/audit.test.mjs`, `usage_budgets.test.mjs`, `benchmarks.test.mjs`; real-server tests: `tests/postgres/backup-restore.test.mjs`.

## OAuth nonces (0017) and lock-then-check (0018)
`oauth_states` holds the SHA-256 of each pending Google sign-in nonce with its user, project and expiry. `oauth_state_create` (admin of the project, max 20 unused per user) and `oauth_state_consume` (row locked, then used/expiry judged on the wall clock; burned on first presentation) are service-role only, SECURITY DEFINER with a fixed search path; the table has RLS on and no grants.
0018 re-creates `renew_job_lease` and `complete_job` so the lease expiry is checked after the job row is locked: an `UPDATE ... WHERE expires_at > clock_timestamp()` tests the condition before waiting for a lock, which could let a lease that expired during the wait be renewed or completed (found by `tests/postgres/fencing-concurrency.test.mjs`).
Tests: `tests/integration/oauth_state.test.mjs`, `tests/postgres/oauth-nonce-concurrency.test.mjs`.

## Fenced job writes (migration 0012)
`job_fence`, `job_write_discovery`, `job_enqueue_crawls`, `job_write_score`, `job_write_audit` commit a job's results only while it owns its lease (see ARCHITECTURE.md, Background jobs). All are server-only (`service_role`). 0012 also re-creates
`recover_expired_jobs`, `renew_job_lease`, `complete_job` and `fail_job` with `clock_timestamp()` in expiry comparisons (`now()` is the transaction start and can be stale after waiting for a lock).
Tested in `tests/integration/fenced_writes.test.mjs` (PGlite) and `tests/postgres/fencing-concurrency.test.mjs` (real server: row locks, recovery waiting for an open write, lease ending while a write waits).

## Organisations and roles (migration 0011)
Every project belongs to an **organisation** (`projects.organisation_id`); people belong to organisations through `organisation_members` with a role.
`projects.user_id` is kept and now means "who created it". Types: `business` or `agency` (an agency is the same structure; nothing differs yet).

| Role | Can do |
|---|---|
| `viewer` | Read the organisation's projects and their data. Change nothing. |
| `member` | Normal project work: edit keywords/locations, hide competitors, mark fixes done, run the daily workflow. |
| `admin` | Member + project administration (verify ownership, connect Search Console, delete projects) + add/remove members and viewers (cannot grant admin or owner, cannot touch owners or other admins). |
| `owner` | Admin + grant any role, rename the organisation, remove anyone. |

Rules enforced in the database: nobody can change their own role or add themselves; an organisation that still has other people keeps at least one owner
(trigger `guard_last_owner`); an organisation that still has projects cannot be deleted (`ON DELETE RESTRICT`); the browser cannot set `projects.organisation_id` and
cannot create or delete organisations (server actions, not built yet).

How access is decided: `project_role_for(project, user)` (server, service role) and `project_role(project)` (browser, uses `auth.uid()`) return the role. `owns_project()` keeps its
name and means "member or above", so every write policy from 0002 changed meaning without being rewritten. `can_view_project()` (any role) is used by every SELECT policy, `can_admin_project()` for administration.
The `projects` policies use `row_project_role(organisation_id, user_id)` from the row's own columns, because a lookup cannot see the row being inserted (this function is VOLATILE on purpose, see the comment in the migration).
A project with `organisation_id` null still belongs to its creator, so the old rule keeps working until the backfill is verified.

**Personal organisations**: a `BEFORE INSERT` trigger on `projects` puts a project created without an organisation (the onboarding screen) into its creator's personal organisation, creating it (and the owner membership) on first use.
0011 backfills every existing project the same way. `organisation_id` is still **nullable** on purpose: make it NOT NULL in a later migration only after
`select count(*) from public.projects where organisation_id is null;` returns 0 on production.

The last-owner guard serialises owner removals and demotions per organisation by locking the organisation row (`FOR NO KEY UPDATE`, migration 0013), so two owners cannot remove each other concurrently; it does not block creating projects or members. Proved on a real server in `tests/postgres/owner-concurrency.test.mjs`.

Tested in `tests/integration/organisations.test.mjs` (role matrix, isolation, self-elevation, last owner), `org_backfill.test.mjs` (an existing customer's database migrated, data fingerprints unchanged, re-run is a no-op).

