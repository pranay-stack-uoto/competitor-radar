import { createClient } from '@supabase/supabase-js';
import { safeEqual } from './security/validate';

// Service-role client: server-only (cron + workers + trusted API routes). Never import this into client components.
export const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export const today = () => new Date().toISOString().slice(0, 10);

// Cron endpoints must carry CRON_SECRET (Vercel sends it as a Bearer token automatically). Compared in constant time.
export const authorizedCron = (req) => {
  const secret = process.env.CRON_SECRET;
  return !!secret && safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`);
};

// The worker route may also be started by the database watchdog (supabase/ops/schedule_watchdog.sql), which holds a SEPARATE secret that can start
// the worker and nothing else: it is not accepted by the daily start or report routes.
export const authorizedWorker = (req) => {
  if (authorizedCron(req)) return true;
  const secret = process.env.WATCHDOG_SECRET;
  return !!secret && safeEqual(req.headers.get('authorization') || '', `Bearer ${secret}`);
};

// Self-calls (kicking the worker) live in lib/security/selfcall.js: the destination comes only from the configured APP_URL.
export { kickWorker } from './security/selfcall';
