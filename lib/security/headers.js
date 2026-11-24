// Security response headers for every page and API response (applied in next.config.mjs).
//
// What the app actually loads (checked against app/ and next.config): scripts and styles come from this origin; Next.js inlines small bootstrap
// scripts, and React components use style="" attributes, so script-src/style-src need 'unsafe-inline' until scripts move to nonces (TECHNICAL_DEBT TD-34).
// Fonts are self-hosted at build time by next/font. The browser talks to this origin and to the project's Supabase URL only. Google sign-in
// is a full-page redirect (no popup, no iframe, no external script), so it needs nothing in the policy.
//
// Rollout: the directives that cannot break the app are ENFORCED now (framing, base URI, plugins, form targets). The full policy is sent as
// Content-Security-Policy-Report-Only with a report endpoint, so a real browser session shows what enforcement would block before it is switched on
// (docs/OPERATIONS.md, "Security headers").
const REPORT_PATH = '/api/csp-report';

// The Supabase origin the browser may call, from the build-time public URL; the wildcard is only the fallback when it is not set.
function supabaseSources(env) {
  try { const u = new URL(env.NEXT_PUBLIC_SUPABASE_URL); if (u.protocol === 'https:') return [u.origin, `wss://${u.host}`]; } catch { /* fall through */ }
  return ['https://*.supabase.co', 'wss://*.supabase.co'];
}

function enforcedPolicy() {
  return ["frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'"].join('; ');
}
function fullPolicy(env = process.env) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${supabaseSources(env).join(' ')}`,
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self'",
    `report-uri ${REPORT_PATH}`,
  ].join('; ');
}

function securityHeaders(env = process.env) {
  const h = [
    { key: 'Content-Security-Policy', value: enforcedPolicy() },
    { key: 'Content-Security-Policy-Report-Only', value: fullPolicy(env) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
  // HSTS only where HTTPS is guaranteed: production builds, served by Vercel over HTTPS. Never on local http. No includeSubDomains/preload:
  // we do not control the parent domain, and those cannot be undone quickly.
  if (env.NODE_ENV === 'production') h.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
  return h;
}

module.exports = { securityHeaders, enforcedPolicy, fullPolicy, REPORT_PATH };
