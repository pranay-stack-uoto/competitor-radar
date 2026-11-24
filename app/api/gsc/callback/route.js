import { NextResponse } from 'next/server';
import { admin } from '@/lib/db';
import { atLeast } from '@/lib/security/roles';
import { recordAudit } from '@/lib/auditTrail';
import { finishOAuth } from '@/lib/security/oauthState';
import { APP_URL, exchangeCode, accessToken, listSites, pickSite, encrypt, syncGsc } from '@/lib/gsc';

export const maxDuration = 60;

// Google sends the user back here with a one-time code. Only a state we signed ourselves is accepted, and only once: the state carries a
// random nonce that is consumed atomically (migration 0017), so a copied or replayed link is refused.
export async function GET(req) {
  const u = new URL(req.url);
  let base;
  try { base = APP_URL(); } catch { return NextResponse.json({ error: 'This service is not configured correctly.' }, { status: 503 }); } // fail closed: never redirect to a guessed address
  const go = (r) => NextResponse.redirect(`${base}/dashboard?gsc=${r}`);
  if (u.searchParams.get('error')) return go('denied');
  const code = u.searchParams.get('code');
  const db = admin();
  const consumed = await finishOAuth(db, u.searchParams.get('state'));
  if (!consumed.ok || !code) {
    if (consumed.reason === 'used-or-invalid') await recordAudit(db, { action: 'gsc.oauth_rejected', detail: { reason: consumed.reason } });
    return go('error');
  }
  const st = { projectId: consumed.projectId, userId: consumed.userId };
  const { data: p } = await db.from('projects').select('id,domain,user_id').eq('id', st.projectId).maybeSingle();
  if (!p) return go('error');
  // The person who started the sign-in must still be an admin of the project's organisation when they come back. Before migration
  // 0011 is applied the function does not exist and the old rule (the project's creator) applies.
  const { data: role, error: roleError } = await db.rpc('project_role_for', { pid: p.id, uid: st.userId });
  const missing = roleError && (roleError.code === 'PGRST202' || roleError.code === '42883');
  if (missing ? p.user_id !== st.userId : (roleError || !atLeast(role, 'admin'))) return go('error');
  try {
    const t = await exchangeCode(code);
    if (!t.refresh_token) return go('error');
    const sites = await listSites(t.access_token);
    const site = pickSite(sites, p.domain);
    await db.from('gsc_tokens').upsert({ project_id: p.id, token_enc: encrypt(t.refresh_token, process.env, p.id) });
    await db.from('gsc_connections').upsert({ project_id: p.id, site_url: site, status: site ? 'ok' : 'nosite', error: site ? null : 'No verified Search Console property matches this domain for the Google account you chose.', connected_at: new Date().toISOString(), last_sync: null });
    if (!site) return go('nosite');
    await syncGsc(db, p.id, { force: true });
    return go('ok');
  } catch { return go('error'); }
}
