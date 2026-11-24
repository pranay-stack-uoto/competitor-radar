import { NextResponse } from 'next/server';
import { authorizedCron, admin, kickWorker } from '@/lib/db';
import { finishProjects } from '@/lib/pipeline';
import { runMonitors } from '@/lib/alerts';

export const maxDuration = 60;

// 10:00 IST (04:30 UTC): rank today's scores and publish each project's daily report.
export async function GET(req) {
  if (!authorizedCron(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // Safety net, 45 minutes into the daily run: if work is still waiting (a worker was cut off), start another one.
  await kickWorker().done;
  // Publish what exists now. A project whose crawls are not all finished gets a report marked partial; the worker replaces it with the full one when it completes.
  const reports = await finishProjects(undefined, { partial: true });
  // The daily monitor: audit anomalies and budget alerts, delivered to the log and the optional webhook (lib/alerts.js).
  const monitor = await runMonitors(admin()).catch(() => ({ error: true }));
  await admin().rpc('benchmark_refresh', { p_days: 14 }).catch(() => {}); // opt-in industry benchmarks (migration 0016); a no-op until organisations opt in
  return NextResponse.json({ reports, monitor: { raised: monitor.raised, sent: monitor.sent, webhook: monitor.webhook, error: monitor.error } });
}
