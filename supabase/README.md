# Database migrations

`supabase/migrations/*.sql` is the single source of truth for the database. `schema.sql` was removed because it
duplicated the migrations and had drifted from production (see `docs/BASELINE.md`).

- `0001_baseline_schema.sql` is the production schema as of 2026-11-05. **Production already has it.** Never run it there.
- `0002` and later change the schema. They are written to be re-runnable.
- Never edit a migration after it has been applied anywhere. Add a new file.
- Applying migrations to production is a manual step. See `docs/DATABASE.md` and `docs/OPERATIONS.md`.

The test suite builds a fresh in-process Postgres (PGlite) from these files, so every migration is exercised on
every `npm test`.
