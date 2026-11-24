import { admin } from '@/lib/db';
import { readJsonBody } from '@/lib/security/validate';
import { ipKey, checkLimit } from '@/lib/security/ratelimit';

// Receives Content-Security-Policy violation reports from browsers (report-only rollout, lib/security/headers.js).
// Public on purpose (browsers send it without credentials), so it is small and defensive: 8 KB cap, per-address limit, nothing is stored,
// one scrubbed log line (directive and the origin of what was blocked; never full URLs, which can carry tokens), and always 204.
export const dynamic = 'force-dynamic';
const origin = (u) => { try { const x = new URL(u); return x.protocol + '//' + x.host; } catch { return String(u || '').slice(0, 20); } };
const pathOf = (u) => { try { return new URL(u).pathname.slice(0, 80); } catch { return ''; } };

export async function POST(req) {
  try {
    const ip = ipKey(req.headers);
    if (ip) await checkLimit({ rpc: (args) => admin().rpc('rate_limit_hit', args), key: 'csp:' + ip, windowSec: 600, max: 60 });
    const body = await readJsonBody(req, { maxBytes: 8 * 1024 });
    const r = body['csp-report'] && typeof body['csp-report'] === 'object' ? body['csp-report'] : {};
    console.warn('csp violation', JSON.stringify({ directive: String(r['effective-directive'] || r['violated-directive'] || '').slice(0, 40), blocked: origin(r['blocked-uri']), page: pathOf(r['document-uri']), disposition: String(r.disposition || '').slice(0, 10) }));
  } catch { /* a bad or excessive report is simply dropped */ }
  return new Response(null, { status: 204 });
}
