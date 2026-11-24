// Google Search Console: real queries, clicks and positions for the user's own site (read-only access).
import { today } from './db';

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
// The public origin of this deployment, validated (lib/security/selfcall.js). In production a missing or malformed APP_URL is an error, not a guess.
export const APP_URL = () => appOrigin();
export const redirectUri = () => `${APP_URL()}/api/gsc/callback`;
// Search Console is offered only when Google is configured AND this process may store tokens safely (independent keys in production).
export const gscConfigured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) && cryptoReady();

// Tokens are encrypted at rest with a versioned key ring that is separate from the database service key, and the OAuth state is
// signed with its own key. All of that lives in lib/security/crypto.js (see docs/SECURITY.md for rotation).
import { encrypt, decrypt, needsReencrypt, signState, readState, cryptoReady } from './security/crypto';
import { appOrigin } from './security/selfcall';
export { encrypt, decrypt, signState, readState };

export function authUrl(state) {
  const q = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

async function tokenCall(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }) });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error_description || j.error || 'Google rejected the request'); e.code = j.error; throw e; }
  return j;
}
export const exchangeCode = (code) => tokenCall({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
export const accessToken = async (refresh) => (await tokenCall({ refresh_token: refresh, grant_type: 'refresh_token' })).access_token;
export async function revoke(refresh) { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(refresh), { method: 'POST' }).catch(() => {}); }

export async function listSites(access) {
  const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { authorization: `Bearer ${access}` } });
  if (!r.ok) throw new Error('Could not list Search Console sites');
  return (await r.json()).siteEntry || [];
}
// Prefer a domain property, then any URL-prefix property for this host. Unverified entries cannot return data.
export function pickSite(sites, domain) {
  const ok = sites.filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  const bare = domain.replace(/^www\./, '');
  const host = (s) => { try { return new URL(s.siteUrl).hostname.replace(/^www\./, ''); } catch { return ''; } };
  return (ok.find((s) => s.siteUrl === `sc-domain:${bare}`) || ok.find((s) => host(s) === bare))?.siteUrl || null;
}

async function query(access, site, body) {
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: 'POST', headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Search Console returned ${r.status}`);
  return (await r.json()).rows || [];
}
const iso = (d) => d.toISOString().slice(0, 10);
const add = (d, n) => new Date(d.getTime() + n * 86400000);
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;
const shape = (r, k) => ({ [k]: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: round(r.ctr, 4), position: round(r.position) });

// Search Console data lags by about three days, so the latest 28 complete days end three days ago.
export async function fetchSnapshot(access, site) {
  const end = add(new Date(), -3), start = add(end, -27), pEnd = add(start, -1), pStart = add(pEnd, -27);
  const win = (s, e) => ({ startDate: iso(s), endDate: iso(e) });
  const [tot, ptot, queries, pages] = await Promise.all([
    query(access, site, { ...win(start, end) }),
    query(access, site, { ...win(pStart, pEnd) }),
    query(access, site, { ...win(start, end), dimensions: ['query'], rowLimit: 250 }),
    query(access, site, { ...win(start, end), dimensions: ['page'], rowLimit: 60 }),
  ]);
  const t = (rows) => rows[0] ? { clicks: rows[0].clicks, impressions: rows[0].impressions, ctr: round(rows[0].ctr, 4), position: round(rows[0].position) } : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { site, range: { start: iso(start), end: iso(end) }, totals: t(tot), prevTotals: t(ptot), queries: queries.map((r) => shape(r, 'query')), pages: pages.map((r) => shape(r, 'page')) };
}

// Pull a fresh snapshot for a connected project (once a day unless forced). Marks the connection expired if access was revoked.
export async function syncGsc(db, projectId, { force } = {}) {
  const { data: conn } = await db.from('gsc_connections').select('*').eq('project_id', projectId).maybeSingle();
  if (!conn || !conn.site_url || conn.status === 'expired') return { skipped: true };
  if (!force && conn.last_sync === today()) return { skipped: true };
  const { data: tok } = await db.from('gsc_tokens').select('token_enc').eq('project_id', projectId).maybeSingle();
  if (!tok) return { skipped: true };
  try {
    const refresh = decrypt(tok.token_enc, process.env, projectId);
    // Once a new key is configured, tokens still stored under an older key are rewritten with the active one.
    if (needsReencrypt(tok.token_enc)) await db.from('gsc_tokens').update({ token_enc: encrypt(refresh, process.env, projectId) }).eq('project_id', projectId);
    const access = await accessToken(refresh);
    const data = await fetchSnapshot(access, conn.site_url);
    await db.from('gsc_snapshots').upsert({ project_id: projectId, day: today(), data });
    await db.from('gsc_connections').update({ last_sync: today(), status: 'ok', error: null }).eq('project_id', projectId);
    return { ok: true };
  } catch (e) {
    const expired = e.code === 'invalid_grant';
    await db.from('gsc_connections').update({ status: expired ? 'expired' : 'ok', error: String(e.message).slice(0, 300) }).eq('project_id', projectId);
    return { error: e.message };
  }
}
