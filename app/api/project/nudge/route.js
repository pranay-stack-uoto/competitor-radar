import { NextResponse } from 'next/server';
import { admin, today } from '@/lib/db';
import { route, requireUser, requireProject, limit } from '@/lib/http';
import { readJsonBody } from '@/lib/security/validate';
import { enqueue, invalidateCrawl } from '@/lib/queue';
import { runQueue, queueAudit } from '@/lib/pipeline';

export const maxDuration = 120;

// The dashboard calls this while a search or an added competitor is still being scored. It works the queue and
// publishes the leaderboard, so results appear without depending on a separate background trigger.
export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  const rescan = body.rescan === true, recheck = body.recheck === true, audit = body.audit === true;
  const p = await requireProject(auth, body.projectId, 'id,domain'); // RLS: owner only
  await limit(auth, 'nudge');
  const db = admin();
  const day = today();
  if (rescan) {
    // Re-read your own site and the top three competitors if their stored scores predate detailed profiles.
    const { data: rows } = await db.from('scores').select('domain,is_me,overall,profile:details->profile').eq('project_id', p.id).eq('day', day).order('overall', { ascending: false });
    const want = [...(rows || []).filter((r) => r.is_me), ...(rows || []).filter((r) => !r.is_me).slice(0, 3)].filter((r) => !r.profile).map((r) => r.domain);
    if (want.length) {
      await Promise.all(want.map((domain) => enqueue(db, { projectId: p.id, day, kind: 'crawl', domain })));
    }
  }
  if (recheck) {
    // Re-read your own site now (after you made changes) instead of waiting for tomorrow.
    await invalidateCrawl(db, p.domain); // the owner changed their site: do not serve today's cached crawl
    await enqueue(db, { projectId: p.id, day, kind: 'crawl', domain: p.domain });
  }
  if (audit) await queueAudit(db, p, day, 0); // "Run full-site audit now"
  const [{ count: pending }, { data: report }, { data: scores }, { data: comps }] = await Promise.all([
    db.from('jobs').select('id', { count: 'exact', head: true }).eq('project_id', p.id).eq('day', day).in('status', ['queued', 'running']),
    db.from('reports').select('summary').eq('project_id', p.id).eq('day', day).maybeSingle(),
    db.from('scores').select('domain,is_me').eq('project_id', p.id).eq('day', day),
    db.from('competitors').select('domain,status').eq('project_id', p.id),
  ]);
  const ignored = new Set((comps || []).filter((c) => c.status === 'ignored').map((c) => c.domain));
  const onBoard = new Set((report?.summary?.board || []).map((b) => b.domain));
  const unpublished = (scores || []).some((s) => (s.is_me || !ignored.has(s.domain)) && !onBoard.has(s.domain));
  if (!pending && !unpublished) return NextResponse.json({ pending: 0, published: true });
  // A crawl can take ~70 s and an audit ~80 s, so only start new jobs early in the call to stay inside the 120 s limit.
  const { count: auditWaiting } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('kind', 'audit').eq('status', 'queued');
  const r = await runQueue(auditWaiting ? 30 * 1000 : 40 * 1000, p.id);
  const { count: left } = await db.from('jobs').select('id', { count: 'exact', head: true }).eq('project_id', p.id).eq('day', day).in('status', ['queued', 'running']);
  return NextResponse.json({ pending: left || 0, worked: r.done, published: !left });
});
