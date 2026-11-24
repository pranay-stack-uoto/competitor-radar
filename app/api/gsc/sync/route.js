import { NextResponse } from 'next/server';
import { admin } from '@/lib/db';
import { route, requireUser, requireProject, limit } from '@/lib/http';
import { readJsonBody } from '@/lib/security/validate';
import { syncGsc } from '@/lib/gsc';

export const maxDuration = 60;

export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  const p = await requireProject(auth, body.projectId, 'id');
  await limit(auth, 'gsc');
  const r = await syncGsc(admin(), p.id, { force: true });
  return NextResponse.json(r.error ? { error: 'Search Console could not be read right now. Try again later.' } : { ok: true });
});
