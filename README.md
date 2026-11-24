# Competitor Radar

A competitive-visibility tool for local businesses: it crawls a business's website and its competitors, tracks Google and Maps visibility, reads
Search Console, and turns the gaps into an evidence-backed action report. Live in private beta; built for Indian local-service businesses first.

**This repository is a read-only source snapshot.** It is published for transparency and review. See [LICENSE](LICENSE): all rights reserved, no
permission is granted to copy or reuse the code.

## Stack
Next.js 15 (App Router, JavaScript) on Vercel; Supabase (Postgres with row-level security, email-code sign-in); a custom crawler behind an SSRF
guard; a Postgres-backed job queue with lease tokens and fenced result writes; Serper.dev for Google results and Maps; Anthropic Claude for
extraction and insights; Google Search Console, Places and PageSpeed APIs.

## Layout
```
app/                 pages and API routes
lib/                 crawler, scoring, pipeline, queue, security helpers, reports
supabase/migrations/ the database, as numbered additive migrations
tests/               unit, integration (in-process Postgres) and real-Postgres concurrency tests
docs/                architecture and database notes
```

## Running the tests
```
npm ci
npm test            # unit and integration tests, no services needed
npm run lint
npm run build
```
Configuration is by environment variables (names only in `.env.example`). No secrets are in this repository.

## Security
Found a vulnerability? Please email the contact address shown in the app's Privacy Policy instead of opening a public issue.
