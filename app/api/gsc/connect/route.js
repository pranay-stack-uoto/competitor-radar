import { NextResponse } from 'next/server';
import { route, requireUser, requireProject, limit, audit } from '@/lib/http';
import { HttpError, readJsonBody } from '@/lib/security/validate';
import { authUrl, gscConfigured } from '@/lib/gsc';
import { admin } from '@/lib/db';
import { startOAuth } from '@/lib/security/oauthState';

// GET tells the page whether Search Console is set up on this server; POST starts the Google sign-in for one project.
export const dynamic = 'force-dynamic';
export async function GET() { return NextResponse.json({ configured: gscConfigured() }); }

export const POST = route(async (req) => {
  const auth = await requireUser(req);
  if (!gscConfigured()) throw new HttpError(501, 'Search Console is not set up yet.');
  const body = await readJsonBody(req);
  const p = await requireProject(auth, body.projectId, 'id,organisation_id', 'admin');
  await limit(auth, 'gsc');
  await audit(auth, p, 'gsc.connect_started');
  // A random single-use nonce is stored server-side and carried inside the signed state (migration 0017).
  const state = await startOAuth(admin(), { userId: auth.user.id, projectId: p.id });
  return NextResponse.json({ url: authUrl(state) });
});
