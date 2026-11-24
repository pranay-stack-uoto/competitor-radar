# Architecture

## Shape of the system
```
Browser (Next.js client pages)
   │  reads its own rows directly with the user's JWT (row-level security decides what it may see)
   │  everything else goes through server routes
   ▼
Next.js server routes  app/api/*  ──►  Supabase Postgres (RLS, jobs queue, caches)
   │  route(): errors   requireUser(): JWT checked by Supabase Auth   requireProject(): ownership via RLS   limit(): DB rate limit
   ▼
Worker  (cron + dashboard "nudge")  ──►  claim_job → crawl (shared cache) → collect → score → rank → report
   │
   ├─ Serper.dev     Google results and Maps
   ├─ Anthropic      extraction, competitor filtering, insights (lib/ai.js)
   ├─ Google OAuth   Search Console (read-only)
   └─ Customer websites  (only through lib/security/netguard)
```

## Frontend
Client components in `app/`. `lib/data.js` loads everything for the dashboard and report using the browser Supabase client, so RLS is
the access control for reads. The browser may write only what column privileges allow: create a project (never verified), edit
keywords/locations/summary, hide or re-enable a competitor, mark and undo fixes. Everything else is a server route. The dashboard
polls only while something is in progress and re-renders only when the data changed. History sent to the browser is limited to 120 days.

## Backend: request path
Each route is `export const POST = route(async (req) => { ... })` using `lib/http.js`:
`requireUser` (strict Bearer parsing, token verified by Supabase) → `readJsonBody` (size cap, object only) → validate ids
(`needUuid`) → `requireProject` (runs as the user, so a project owned by someone else looks like "not found") → `limit` (per-user
fixed-window counter in Postgres) → work. Errors become clean JSON; unexpected ones are logged with credentials scrubbed.

## Authentication and tenancy
Supabase Auth (email code). Tenant = **organisation** (migration 0011); people belong to organisations with a role (viewer, member, admin, owner) and
every project belongs to one organisation (each existing person got a personal one). All customer tables carry `project_id` with a cascading foreign key;
SELECT policies call `public.can_view_project(project_id)` and write policies `public.owns_project(project_id)` (member or above). Those helpers, built on
`project_role()`, are the only place access is defined. `requireProject` in `lib/http.js` (logic in `lib/security/projectAccess.js`) asks for a minimum role per route.
See DATABASE.md and SECURITY.md.

## Crawler
`lib/crawl.js`. Each crawl has one **download budget** (100 MB scoring, 300 MB audit by default) that covers every fetch; when it is spent the crawl stops and returns a partial result marked `stopped`.
Reads robots.txt (and obeys it), llms.txt, sitemaps (including indexes), then pages: the homepage, a spread of
sitemap pages across page types, then links found on every page. It records redirects (hop by hop), broken links, noindex, duplicate
text hashes, and a sample of image sizes. Every request goes through `lib/security/netguard`. Caps: pages per site, time per site,
bytes per response. `crawlSite` accepts injected fetchers so tests run it against a fake website.

## Shared crawl cache
`lib/crawlCache.js` + migration 0005. The raw crawl of a public domain is stored once per domain and crawler version and reused for
20 hours. One caller at a time is told to crawl and receives a **lease token**; others wait and reuse the result. Finishing or failing needs that token and works only while it is the
current, unexpired one (migration 0008), so a stale worker cannot overwrite a newer crawl. History is kept as small profile snapshots (the
free database is 500 MB). Nothing customer-specific is stored there (checked by a test). Scoring runs per project afterwards.

## Competitor discovery
`lib/discover.js`. Serper searches per keyword × location (4 at a time, results processed in order), Google Maps places, and
well-known names suggested by Claude and located through search. Candidates are filtered by Claude (it may only return domains it
was shown). Manual competitors are never removed by the bot. AI answers for identical prompts are cached (`ai_cache`).

## Scoring engine
Three stages with no shared state:
1. **Collect** (`lib/scoring/collect.js`): the only scoring-time network calls (Google Places, AI probe, PageSpeed). Each returns a
   validated object with a status (`disabled`, `none`, `ok`).
2. **Score** (`lib/scoring/engine.js` + `lib/modules/*`): pure functions of (crawl, keywords, locations, serp ranks, collected
   facts). Four independent modules, each returning `{score, checks[]}`. Overall = weighted mean using the weights in
   `lib/scoring/config.js`. Every check is labelled with how it was obtained (`measured`, `sampled`, `heuristic`, `external`, `ai-sampled`).
3. **Recommend** (`lib/recommendations.js`): reads stored score rows only, ranks actions by points gained per effort.

Each stored score records `method_version`; change detection and the trend chart do not compare across versions.
Golden fixtures (`tests/fixtures/scoring-golden.json`) lock scoring behaviour.

## Operations layer
`lib/auditTrail.js` (record events), `lib/budget.js` (charge before spending), `lib/alerts.js` (daily monitor, called after the 10:00 IST report), `lib/ops/backup.js` with `scripts/backup.mjs`, `scripts/restore-drill.mjs`, `scripts/rotate-token-keys.mjs`, `scripts/incident-revoke-gsc.mjs`, `scripts/make-archive.sh`.
No new service: everything runs inside the existing Next.js app, Postgres and free GitHub Actions. See OPERATIONS.md, INCIDENT_RESPONSE.md, ENVIRONMENTS.md and DEFENSIBILITY.md.

## Background jobs
Postgres is the queue (migrations 0004, 0009, 0010 and 0012). `enqueue_job` refuses duplicates of an active job; `claim_job` takes one due job with
`FOR UPDATE SKIP LOCKED` and a 5-minute lease; every claim stamps a fresh `lease_token` (migration 0010) and `renew_job_lease`/`complete_job`/`fail_job` need that token as well as the worker name and an unexpired lease, so a stale execution cannot act even if it shares the worker name with the current one; expired leases are
recovered automatically; a running job **renews its lease** every third of the lease length, one renewal at a time, and handlers call `lease.assertHeld()` before every write so a worker that lost the job stops; retryable failures back off 30 s, 60 s, 120 s… (max 3 attempts, 1 h cap); permanent failures stop at once.
Lifecycle: `queued → running → done`; `failed` is terminal (`failure_kind`: permanent or exhausted). `lib/queue.js` classifies errors.
Handlers are idempotent (upserts, delete-then-insert for a day, de-duplicated enqueues).

**Results are fenced in the database (0012).** A handler never writes results with plain table writes. It calls `lease.write(fn, args)` (lib/queue.js), which runs one of five narrow functions:
`job_write_discovery` (search results + competitor changes, one transaction), `job_enqueue_crawls` (child crawl jobs), `job_write_score`, `job_write_audit`.
Each one locks the job row (`FOR SHARE`), requires status running, the same worker, the current token and an unexpired lease judged with `clock_timestamp()`, and writes in that same transaction.
Project, day and domain come from the job row, not from the caller; each function accepts only its own job kind; refused calls write nothing and return false/null (the handler then throws `LeaseLostError`).
The lock stops recovery, completion and reclaiming until the write commits, so a stale worker can never commit and a committed write is never lost to a reclaim.

**Cancellation.** `runWithLease` gives handlers `lease.signal` (an AbortSignal that fires when ownership is lost, a renewal is refused or the lease runs out unrenewed). It is passed to the SSRF-guarded crawler (through the crawl byte budget), Serper, Anthropic and Places calls, and the crawl loop stops scheduling pages when it fires.
It cannot recall a request the remote side already received, interrupt the shared-crawl wait loop (up to 45 s of sleeping in `lib/crawlCache.js`) or stop CPU work already running; those finish harmlessly because the fenced write is then refused.
`runClaimedJob` (used by `workOne`) never completes or fails a job it lost: `complete_job` returning false is reported as `completion-rejected`, an aborted handler is `lost`, and a completion call that errors leaves the job to lease expiry and a retry.

Daily flow: cron `/api/cron/start` (09:00 IST) queues discovery (and the full-site audit) per project → discovery queues crawl jobs
→ `/api/cron/work` drains the queue and re-invokes itself → `/api/cron/report` (10:00 IST) or the end of the drain ranks results
(`set_ranks`) and publishes the report. The dashboard "nudge" also works the queue while a user is waiting.

## External integrations
Serper.dev, Anthropic, Google OAuth and Search Console, Google Places (optional), customer websites. All vendor responses are
validated before use. Vendor hosts are fixed; customer hosts go through the SSRF guard.

## Data flows worth knowing
- **Search Console**: OAuth state is signed and expires in 15 minutes; refresh tokens are encrypted with a versioned key ring and
  never returned to the browser; the snapshot is per project and never enters the shared cache.
- **Recheck**: invalidates the shared crawl for the owner's own domain only, then queues a crawl.
- **Full-site audit**: a deeper crawl of the owner's own site (up to 150 pages), stored separately and never used in scoring.
