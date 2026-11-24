-- Schedules the run-health watchdog (migration 0027) to run every 10 minutes inside the database. NOT part of the migration chain: it needs the
-- Supabase extensions pg_cron, pg_net and Vault, which the in-process test database does not have. Apply it once, by hand, in the SQL editor,
-- after migration 0027 and after the WATCHDOG_SECRET variable exists in Vercel.
--
-- 1. Extensions (already available on every Supabase plan):
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;
-- 2. Vault secrets used by watchdog_kick(). Replace the two values; WATCHDOG_SECRET must equal the Vercel variable of the same name.
--    select vault.create_secret('https://your-app.vercel.app', 'app_url');
--    select vault.create_secret('<the same value as Vercel WATCHDOG_SECRET>', 'watchdog_secret');
-- 3. The schedule. Detection and recovery always run; starting a worker needs the feature flag:
--    insert into public.feature_flags (key, enabled, note) values ('watchdog_kick', true, 'watchdog may start a worker') on conflict (key, organisation_id) do update set enabled = excluded.enabled;
select cron.schedule('radar-watchdog', '*/10 * * * *', $$select public.watchdog_run()$$);
-- To stop it:   select cron.unschedule('radar-watchdog');
