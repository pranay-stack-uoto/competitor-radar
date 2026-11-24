import { NextResponse } from 'next/server';
import { promises as dns } from 'node:dns';
import { admin } from '@/lib/db';
import { route, requireUser, requireProject, limit } from '@/lib/http';
import { HttpError, readJsonBody } from '@/lib/security/validate';
import { safeFetch, isValidHostname } from '@/lib/security/netguard';

export const maxDuration = 30;

// Fetches through the SSRF guard: validated host, validated address at connect time, validated redirects, size and time caps.
async function fetchText(url) {
  try {
    const r = await safeFetch(url, { timeoutMs: 8000, maxBytes: 512 * 1024, headers: { 'user-agent': 'CompetitorRadarBot/1.0 (ownership check)' }, allowTypes: /^(text\/|application\/xhtml)/i });
    return r.ok ? r.body : '';
  } catch { return ''; }
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Proves the signed-in user controls the site by finding their token via DNS, a meta tag, or a file.
export const POST = route(async (req) => {
  const auth = await requireUser(req);
  const body = await readJsonBody(req);
  await limit(auth, 'verify');
  const p = await requireProject(auth, body.projectId, 'id,domain,verify_token,verified', 'admin');
  if (p.verified) return NextResponse.json({ verified: true, method: 'already' });
  if (!isValidHostname(p.domain)) throw new HttpError(400, 'That website name is not valid.');

  const token = p.verify_token;
  let method = null;

  try {
    const records = await dns.resolveTxt(`_radar-verify.${p.domain}`);
    if (records.some((r) => r.join('').trim() === token)) method = 'dns';
  } catch {}

  if (!method) {
    for (const host of [p.domain, 'www.' + p.domain]) {
      const html = await fetchText(`https://${host}/`);
      if (html && new RegExp(`<meta[^>]+name=["']radar-verify["'][^>]+content=["']${escapeRe(token)}["']`, 'i').test(html)) { method = 'meta'; break; }
      const file = await fetchText(`https://${host}/radar-verify-${encodeURIComponent(token)}.txt`);
      if (file.trim() === token) { method = 'file'; break; }
    }
  }

  if (!method) return NextResponse.json({ verified: false, error: 'We could not find the token yet. DNS changes can take a few minutes. Check it and try again.' });
  const { data: saved, error } = await admin().from('projects').update({ verified: true, verified_at: new Date().toISOString() }).eq('id', p.id).select('verified').single();
  if (error || !saved?.verified) {
    console.error('verify: could not save result', error?.code || 'no row updated'); // details stay in the server log, never in the response
    return NextResponse.json({ verified: false, error: 'We found your token but could not save the result. Please try again in a minute.' }, { status: 500 });
  }
  return NextResponse.json({ verified: true, method });
});
