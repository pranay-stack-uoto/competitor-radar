import { NextResponse } from 'next/server';
import { admin, today, kickWorker } from '@/lib/db';
import { enqueue } from '@/lib/queue';
import { route, requireUser, requireProject, limit, audit } from '@/lib/http';
import { HttpError, readJsonBody, needString } from '@/lib/security/validate';
import { isValidHostname } from '@/lib/security/netguard';
import { hostOf, isExcluded } from '@/lib/discover';

export const maxDuration = 30;

// Adds a competitor by hand and scores it right away, instead of waiting for the next daily run.
export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  const raw = needString(body.site, { max: 300, what: 'website' });
  const domain = hostOf(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!domain || !isValidHostname(domain)) throw new HttpError(400, 'Enter a website like example.com');
  const p = await requireProject(auth, body.projectId, 'id,domain,verified,organisation_id');
  if (!p.verified) throw new HttpError(404, 'Project not found');
  if (domain === p.domain) throw new HttpError(400, 'That is your own website.');
  if (isExcluded(domain)) throw new HttpError(400, 'That looks like a directory or social site, not a competitor.');
  await limit(auth, 'competitorAdd');

  const db = admin();
  const { count } = await db.from('competitors').select('id', { count: 'exact', head: true }).eq('project_id', p.id).eq('source', 'manual').eq('status', 'active');
  if ((count || 0) >= 15) throw new HttpError(400, 'You can add up to 15 competitors by hand. Remove one first.');

  await db.from('competitors').upsert({ project_id: p.id, domain, name: domain, source: 'manual', status: 'active', last_seen: today() }, { onConflict: 'project_id,domain' });
  const day = today();
  await enqueue(db, { projectId: p.id, day, kind: 'crawl', domain }); // no-op if the same crawl is already queued or running
  // Kick the worker; it scores the site and refreshes the report when the queue is empty.
  await kickWorker().done;
  await audit(auth, p, 'competitor.added', { domain });
  return NextResponse.json({ queued: true, domain });
});
