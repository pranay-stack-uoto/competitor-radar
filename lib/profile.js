// A compact, storable snapshot of what a site actually contains. Powers the technical audit,
// the "what competitors are doing" analysis and the content-gap comparison in the report.
const { parseRobots, aiBotAccess } = require('./robots');
const norm = (u) => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname).replace(/\/$/, '').toLowerCase(); } catch { return u; } };

function buildProfile(crawl) {
  const P = crawl.pages;
  const inl = {};
  for (const p of P) for (const l of new Set(p.internalLinks.map(norm))) inl[l] = (inl[l] || 0) + 1;
  const pages = P.slice(0, 40).map((p) => ({
    url: p.url, status: p.status, ms: p.ms,
    title: p.title, description: p.description.slice(0, 220), descLen: p.description.length,
    h1: p.h1.slice(0, 2), h2: p.h2.slice(0, 6),
    words: p.words, canonical: !!p.canonical, noindex: /noindex/.test(p.robotsMeta || ''),
    images: p.images, alt: p.imagesWithAlt, schema: [...new Set(p.ldTypes)], faq: !!p.hasQuestions,
    inlinks: inl[norm(p.url)] || 0,
  }));
  const n = P.length || 1;
  return {
    pagesCrawled: P.length,
    sitemapUrls: crawl.sitemap?.count || 0,
    llmsTxt: !!crawl.llmsTxt,
    robotsTxt: !!crawl.robotsTxt,
    avgWords: Math.round(P.reduce((s, p) => s + p.words, 0) / n),
    schemaTypes: [...new Set(P.flatMap((p) => p.ldTypes))].slice(0, 25),
    sameAs: [...new Set(P.flatMap((p) => p.sameAs))].slice(0, 15),
    faqPages: P.filter((p) => p.hasQuestions).length,
    brokenLinks: (crawl.brokenLinks || []).slice(0, 20),
    redirects: (crawl.redirects || []).filter((r) => !r.entry).slice(0, 20),
    heavyImages: (crawl.imageSample || []).filter((i) => i.bytes > 300 * 1024).slice(0, 10),
    freshness: buildFreshness(crawl),
    aiBots: aiBotAccess(crawl.robots && crawl.robots.groups ? crawl.robots : parseRobots(crawl.robotsTxt)).map((b) => (b.allowed ? 1 : 0)).join(''), // one digit per bot in AI_BOTS order: 1 allowed, 0 blocked
    homepage: P[0] ? { title: P[0].title, description: P[0].description, h1: P[0].h1.slice(0, 3), h2: P[0].h2.slice(0, 10) } : null,
    pages,
  };
}

// How recently the site's pages were changed. A page's own declared date wins; the sitemap's lastmod fills in the rest. Returns null when too
// few pages carry any date for the numbers to mean something (many small sites declare none).
function buildFreshness(crawl, now = Date.now()) {
  const lm = crawl.sitemapLastmod || {};
  const days = [];
  let newest = '';
  for (const p of crawl.pages) {
    const d = p.modified || lm[norm(p.url)] || lm[String(p.url).replace(/\/$/, '')] || '';
    if (!d) continue;
    days.push(Math.max(0, Math.round((now - Date.parse(d)) / 86400000)));
    if (d > newest) newest = d;
  }
  if (days.length < 3) return null;
  days.sort((a, b) => a - b);
  const m = days.length >> 1;
  return { dated: days.length, of: crawl.pages.length, medianAgeDays: days.length % 2 ? days[m] : Math.round((days[m - 1] + days[m]) / 2), updated180Pct: Math.round((days.filter((x) => x <= 180).length / days.length) * 1000) / 10, newest };
}

module.exports = { buildProfile, buildFreshness };
