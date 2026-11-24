import { NextResponse } from 'next/server';
import { admin, today, kickWorker } from '@/lib/db';
import { enqueue } from '@/lib/queue';
import { retireStaleJobs } from '@/lib/pipeline';
import { requireRun } from '@/lib/entitlements';
import { route, requireUser, requireProject, limit, audit } from '@/lib/http';
import { HttpError, readJsonBody } from '@/lib/security/validate';

export const maxDuration = 60;

// A new project should not wait until tomorrow 09:00: queue its first discovery now.
export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  const p = await requireProject(auth, body.projectId, 'id,verified,organisation_id');
  if (!p.verified) throw new HttpError(403, 'Verify ownership first');
  await limit(auth, 'projectStart');
  const db = admin();
  await retireStaleJobs(db, today(), p.id);
  // Each discovery run costs search credits, so a manual refresh is limited to once every 30 minutes.
  const { data: recent } = await db.from('jobs').select('updated_at,status').eq('project_id', p.id).eq('kind', 'discover').order('id', { ascending: false }).limit(1);
  const last = recent?.[0];
  if (last && ['queued', 'running'].includes(last.status)) return NextResponse.json({ queued: false, busy: true, message: 'A search is already running. Results will appear in a few minutes.' });
  if (last && Date.now() - new Date(last.updated_at).getTime() < 30 * 60 * 1000) {
    const mins = Math.ceil((30 * 60 * 1000 - (Date.now() - new Date(last.updated_at).getTime())) / 60000);
    return NextResponse.json({ queued: false, tooSoon: true, message: `You searched recently. You can search again in ${mins} minute${mins === 1 ? '' : 's'}.` });
  }
  const { data: running } = await db.from('jobs').select('id').eq('project_id', p.id).eq('day', today()).in('status', ['queued', 'running']).limit(1);
  if (!running?.length) {
    await requireRun(db, p.organisation_id); // spends one run of the free trial (402 when it is used up)
    await enqueue(db, { projectId: p.id, day: today(), kind: 'discover', domain: body.full === true ? 'full' : body.recrawl === true ? 'recrawl' : null }); // 'full' = search Google again now; 'recrawl' = read every site again (Crawl now); otherwise only sites without a score today
  }
  await kickWorker().done;
  await audit(auth, p, 'project.run_requested');
  return NextResponse.json({ queued: true });
});
