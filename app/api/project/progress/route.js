import { NextResponse } from 'next/server';
import { admin } from '@/lib/db';
import { route, requireUser, requireProject } from '@/lib/http';
import { readJsonBody } from '@/lib/security/validate';
import { progressOf } from '@/lib/progress';

export const maxDuration = 30;

// How far a "Crawl now" has got: counts the project's jobs created since the click. Read-only and cheap, so the dashboard can poll it.
export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  const p = await requireProject(auth, body.projectId, 'id');
  const t = Date.parse(body.since);
  const since = Number.isFinite(t) && Date.now() - t < 6 * 3600 * 1000 ? new Date(t) : new Date(Date.now() - 30 * 60 * 1000);
  const { data: jobs } = await admin().from('jobs').select('kind,status,started_at,finished_at').eq('project_id', p.id).in('kind', ['discover', 'crawl']).gte('created_at', since.toISOString()).limit(500);
  return NextResponse.json(progressOf(jobs || [], Date.now()));
});
