// Core Web Vitals from Google PageSpeed Insights (free API): the real-user ("field") figures when Google has enough visits to report them,
// and the lab test of the home page on a mid-range phone otherwise. Display and benchmark data only; it never feeds a score.
// Needs PAGESPEED_API_KEY (a Google Cloud API key with the PageSpeed Insights API enabled); without it nothing is requested.
// The host is fixed; the only thing put in the query is the site's own validated domain name, and Google, not this server, loads it.
const { get } = require('./crawl');

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REFRESH_DAYS = 7;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Google's own thresholds for a "good" and a "needs improvement" experience.
const LIMITS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], tbt: [200, 600] };
const rate = (metric, v) => (v === null || v === undefined ? null : v <= LIMITS[metric][0] ? 'good' : v <= LIMITS[metric][1] ? 'needs-improvement' : 'poor');

function parseVitals(body, now = Date.now()) {
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  const a = (j.lighthouseResult && j.lighthouseResult.audits) || {};
  const f = (j.loadingExperience && j.loadingExperience.metrics) || {};
  const lab = { lcp: num(a['largest-contentful-paint'] && a['largest-contentful-paint'].numericValue), cls: num(a['cumulative-layout-shift'] && a['cumulative-layout-shift'].numericValue), tbt: num(a['total-blocking-time'] && a['total-blocking-time'].numericValue), perf: num(j.lighthouseResult && j.lighthouseResult.categories && j.lighthouseResult.categories.performance && j.lighthouseResult.categories.performance.score) };
  const p75 = (k) => num(f[k] && f[k].percentile);
  const fieldRaw = { lcp: p75('LARGEST_CONTENTFUL_PAINT_MS'), inp: p75('INTERACTION_TO_NEXT_PAINT'), cls: p75('CUMULATIVE_LAYOUT_SHIFT_SCORE') };
  const field = fieldRaw.lcp === null && fieldRaw.inp === null && fieldRaw.cls === null ? null : { lcp: fieldRaw.lcp, inp: fieldRaw.inp, cls: fieldRaw.cls === null ? null : fieldRaw.cls / 100 }; // CrUX reports CLS x 100
  if (lab.lcp === null && !field) return null;
  const out = { lab, field, at: new Date(now).toISOString() };
  // The headline numbers: real users' figures when present, the lab test otherwise.
  out.lcp = field && field.lcp !== null ? field.lcp : lab.lcp;
  out.cls = field && field.cls !== null ? field.cls : lab.cls;
  out.inp = field ? field.inp : null;
  out.tbt = lab.tbt;
  out.source = field ? 'real users (Chrome UX Report)' : 'lab test';
  out.rating = { lcp: rate('lcp', out.lcp), cls: rate('cls', out.cls), inp: rate('inp', out.inp), tbt: rate('tbt', out.tbt) };
  return out;
}

async function collectVitals({ domain, key, getFn = get, signal, timeoutMs = 45000 }) {
  if (!key || !DOMAIN.test(String(domain || '').toLowerCase())) return null;
  try {
    const url = `${API}?url=${encodeURIComponent('https://' + domain)}&strategy=mobile&category=performance&key=${encodeURIComponent(key)}`;
    const r = await getFn(url, 'CompetitorRadarBot/1.0', timeoutMs, undefined, signal);
    return r && r.ok ? parseVitals(r.body) : null;
  } catch { return null; }
}

// Re-test a site at most weekly: reuse the figures stored with an earlier score while they are fresh.
const isFresh = (v, now = Date.now()) => !!v && !!v.at && now - Date.parse(v.at) < REFRESH_DAYS * 86400000;

module.exports = { collectVitals, parseVitals, rate, isFresh, LIMITS, REFRESH_DAYS };
