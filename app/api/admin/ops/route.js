import { NextResponse } from 'next/server';
import { admin } from '@/lib/db';
import { route, requireUser, requireAdmin } from '@/lib/http';
import { readJsonBody } from '@/lib/security/validate';

export const maxDuration = 30;

// The operator's view of the daily run: queue by state, problem jobs, crawl success rate, each project's data health, recent alerts and which
// customers are affected. Server-side only (service role); platform operators only (ADMIN_EMAILS).
export const POST = route(async (req) => {
  const auth = requireAdmin(await requireUser(req));
  await readJsonBody(req);
  const db = admin();
  const [{ data: overview }, { data: alerts }, { data: flags }] = await Promise.all([
    db.rpc('ops_overview'),
    db.from('alerts').select('id,created_at,day,kind,severity,subject,detail').order('id', { ascending: false }).limit(30),
    db.from('feature_flags').select('key,organisation_id,enabled,note'),
  ]);
  const projects = (overview && overview.projects) || [];
  const affected = projects.filter((p) => p.health && ['degraded', 'failing'].includes(p.health.status)).map((p) => ({ domain: p.domain, organisation: p.organisation, plan: p.plan, status: p.health.status, reason: p.health.main_reason || null }));
  return NextResponse.json({ ...overview, alerts: alerts || [], flags: flags || [], affected, operator: auth.user.id ? true : false });
});
