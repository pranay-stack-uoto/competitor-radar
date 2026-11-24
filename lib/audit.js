// Turns a deep crawl of your own site into a list of things to fix, each with the pages that point at it.
// This is separate from the daily score on purpose: it reads far more pages than the competitor comparison does,
// so mixing the two would make your site look worse than competitors only because we looked harder at it.
const { aiBotAccess, parseRobots } = require('./robots');
const norm = (u) => String(u).replace(/\/$/, '');
const path = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return String(u); } };
const cap = (list, n = 100) => list.slice(0, n);

// Pages that link to a target: how many, and a few examples.
function linkers(pages, target, max = 5) {
  const t = norm(target);
  const from = [];
  let count = 0;
  for (const p of pages) {
    if (!p.internalLinks.some((l) => norm(l) === t)) continue;
    count++;
    if (from.length < max) from.push(path(p.url));
  }
  return { count, from };
}

function groups(pages, keyOf) {
  const m = new Map();
  for (const p of pages) { const k = keyOf(p); if (k) m.set(k, [...(m.get(k) || []), path(p.url)]); }
  return [...m].filter(([, urls]) => urls.length > 1).map(([text, urls]) => ({ text: text.slice(0, 140), urls: cap(urls, 12), count: urls.length }));
}


const median = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

// What kind of page this is, from its address and its own markup. Used to ask whether it carries the structured data that kind of page needs.
function pageType(p, isHome) {
  let pth = '/';
  try { pth = new URL(p.url).pathname.replace(/\/$/, '') || '/'; } catch {}
  const t = (p.ldTypes || []).flat().map(String);
  if (isHome || pth === '/') return 'home';
  if (t.includes('FAQPage') || /\/faqs?(\/|$)/i.test(pth)) return 'faq';
  if (t.some((x) => /Article|BlogPosting|NewsArticle/.test(x)) || p.ogType === 'article' || /^\/(blog|posts?|news|articles?|insights)\/[^/]+/i.test(pth)) return 'article';
  if (t.some((x) => /CollectionPage|ItemList/.test(x)) || /^\/(blog|posts?|news|category|categories|tag|products|services|projects|portfolio)$/i.test(pth)) return 'category';
  return 'other';
}
const EXPECT = {
  home: { label: 'Home page', schema: 'Organization or LocalBusiness', re: /Organization|LocalBusiness|Contractor|ProfessionalService|Corporation|Store|Restaurant/ },
  article: { label: 'Article and blog pages', schema: 'Article or BlogPosting', re: /Article|BlogPosting|NewsArticle/ },
  category: { label: 'Listing pages', schema: 'ItemList or CollectionPage', re: /ItemList|CollectionPage/ },
  faq: { label: 'FAQ pages', schema: 'FAQPage', re: /FAQPage/ },
};
function schemaCoverage(P) {
  const by = {};
  P.forEach((p, i) => { const k = pageType(p, i === 0); if (EXPECT[k]) (by[k] = by[k] || []).push(p); });
  return Object.entries(by).map(([k, list]) => {
    const missing = list.filter((p) => !(p.ldTypes || []).flat().some((t) => EXPECT[k].re.test(String(t))));
    return { type: k, label: EXPECT[k].label, expect: EXPECT[k].schema, pages: list.length, covered: list.length - missing.length, missing: cap(missing.map((p) => path(p.url)), 20) };
  });
}
// Is the organisation markup on the home page complete enough for search engines and AI tools to describe the business?
function orgSchema(home) {
  if (!home) return null;
  const node = (home.ld || []).find((n) => [].concat(n && n['@type']).some((t) => EXPECT.home.re.test(String(t))));
  if (!node) return { found: false, missing: ['name', 'url', 'logo', 'address', 'telephone', 'sameAs'] };
  const has = (v) => (Array.isArray(v) ? v.length > 0 : !!v);
  const missing = [];
  if (!has(node.name)) missing.push('name'); if (!has(node.url)) missing.push('url'); if (!has(node.logo) && !has(node.image)) missing.push('logo');
  if (!has(node.address)) missing.push('address'); if (!has(node.telephone) && !has(node.contactPoint)) missing.push('telephone'); if (!has(node.sameAs)) missing.push('sameAs');
  return { found: true, missing };
}
function performanceSample(timing) {
  if (!timing || !timing.length) return null;
  const compressed = timing.filter((t) => /gzip|br|zstd|deflate/i.test(t.enc || ''));
  return {
    sampled: timing.length, medianTtfb: median(timing.map((t) => t.ttfb)), medianTotal: median(timing.map((t) => t.total)), medianKB: Math.round((median(timing.map((t) => t.bytes)) || 0) / 1024),
    compressedPct: Math.round((compressed.length / timing.length) * 100),
    ttfb: { fast: timing.filter((t) => t.ttfb < 200).length, ok: timing.filter((t) => t.ttfb >= 200 && t.ttfb <= 500).length, slow: timing.filter((t) => t.ttfb > 500).length },
    slowest: cap([...timing].sort((a, b) => b.ttfb - a.ttfb), 5).map((t) => ({ url: path(t.url), ttfb: t.ttfb, total: t.total, kb: Math.round(t.bytes / 1024) })),
    uncompressed: cap(timing.filter((t) => !/gzip|br|zstd|deflate/i.test(t.enc || '')).map((t) => path(t.url)), 8),
  };
}

// The issue list: one row per kind of problem, with how many things it affects and which (capped). Severity follows Ahrefs' split so the two tools read alike:
// errors break pages or links, warnings cost visitors or rankings, notices are worth knowing. `urls` are the stable keys used to compare one crawl with the next.
function issueList(a) {
  const rows = [];
  const add = (id, severity, label, urls) => { const u = [...new Set(urls)]; if (u.length) rows.push({ id, severity, label, count: u.length, urls: u.slice(0, 100) }); };
  add('broken-pages', 'error', 'Pages that return 404 or another client error', (a.clientErrors || []).map((x) => x.url));
  add('server-errors', 'error', 'Pages that return a server error (5xx)', (a.serverErrors || []).map((x) => x.url));
  add('unreachable', 'error', 'Pages that did not answer', (a.unreachable || []).map((x) => x.url));
  add('links-to-broken', 'error', 'Pages that link to a broken page', (a.broken || []).flatMap((b) => b.from));
  add('redirect-loops', 'error', 'Redirect loops', (a.redirects || []).filter((r) => r.loop).map((r) => r.url));
  const hostPages = a.hostIssues ? a.hostIssues.targets.flatMap((t) => t.pagesSample || []) : [];
  add('links-to-redirect', 'warning', 'Pages that link to a URL that redirects', [...(a.redirects || []).flatMap((r) => r.from), ...hostPages]);
  add('host-variant-links', 'warning', 'Links that use the wrong host or http (www, non-www, http)', a.hostIssues ? a.hostIssues.targets.map((t) => t.url) : []);
  add('redirect-chains', 'warning', 'Redirect chains (more than one hop)', (a.redirectChains || []).map((r) => r.url));
  add('orphans', 'warning', 'Pages nothing links to', a.orphans || []);
  add('org-schema', 'warning', 'Organization structured data missing or incomplete', a.orgSchema && (!a.orgSchema.found || a.orgSchema.missing.length) ? ['/'] : []);
  add('schema-coverage', 'warning', 'Pages missing the structured data their type needs', (a.schemaCoverage || []).flatMap((c) => c.missing));
  add('h1-missing', 'warning', 'Pages without a main heading', a.h1Missing || []);
  add('dup-titles', 'warning', 'Pages that share a title', (a.dupTitles || []).flatMap((g) => g.urls));
  add('slow-server', 'warning', 'Pages the server was slow to answer (over 500 ms)', a.performance ? a.performance.slowest.filter((s) => s.ttfb > 500).map((s) => s.url) : []);
  add('no-compression', 'warning', 'Pages sent without compression', a.performance ? a.performance.uncompressed : []);
  add('heavy-images', 'warning', 'Images over 300 KB', (a.heavyImages || []).map((i) => i.url));
  add('noindex', 'notice', 'Pages marked noindex', a.noindex || []);
  add('canonical-elsewhere', 'notice', 'Pages whose canonical is another page', (a.canonicalElsewhere || []).map((c) => c.url));
  add('og-incomplete', 'notice', 'Pages with incomplete Open Graph tags', a.ogIncomplete || []);
  add('h1-multiple', 'notice', 'Pages with more than one H1', (a.h1Multiple || []).map((h) => h.url));
  add('dup-descriptions', 'notice', 'Pages that share a meta description', (a.dupDescriptions || []).flatMap((g) => g.urls));
  add('one-inlink', 'notice', 'Pages with only one internal link pointing to them', a.oneInlink || []);
  return rows;
}
// Share of URLs that were fine: not broken, not unreachable, and not linking to a broken page. (Ahrefs calls this the Health Score.)
function healthScore(a) {
  const bad = new Set([...(a.clientErrors || []), ...(a.serverErrors || []), ...(a.unreachable || [])].map((x) => x.url));
  for (const b of a.broken || []) for (const f of b.from) bad.add(f);
  const total = a.statusOverview ? a.statusOverview.requested : 0;
  return total ? Math.max(0, Math.round(((total - bad.size) / total) * 100)) : null;
}
// What changed since the previous crawl, per kind of issue: which affected things are new and which are gone.
function diffIssues(prev, now) {
  if (!Array.isArray(prev) || !Array.isArray(now)) return null;
  const was = new Map(prev.map((r) => [r.id, r]));
  const out = [];
  for (const r of now) {
    const p = was.get(r.id), before = new Set(p ? p.urls : []);
    const added = r.urls.filter((u) => !before.has(u)), resolved = p ? p.urls.filter((u) => !r.urls.includes(u)) : [];
    out.push({ id: r.id, label: r.label, severity: r.severity, now: r.count, was: p ? p.count : 0, added: added.slice(0, 20), resolved: resolved.slice(0, 20), addedCount: added.length, resolvedCount: resolved.length });
  }
  for (const p of prev) if (!now.some((r) => r.id === p.id)) out.push({ id: p.id, label: p.label, severity: p.severity, now: 0, was: p.count, added: [], resolved: p.urls.slice(0, 20), addedCount: 0, resolvedCount: p.urls.length });
  return out.filter((r) => r.addedCount || r.resolvedCount || r.now !== r.was);
}

function buildAudit(crawl) {
  const P = crawl.pages;
  const smTotal = crawl.sitemap?.sampled || 0;
  const stopped = crawl.stopped ? crawl.stopped.reason : null; // e.g. 'byte-budget': the crawl was cut short on purpose
  const complete = !stopped && (!smTotal || P.length >= smTotal * 0.9);

  const brokenTo = new Map();
  for (const b of crawl.brokenLinks || []) if (!brokenTo.has(b.to)) brokenTo.set(b.to, b.status);
  const broken = [...brokenTo].map(([to, status]) => ({ url: path(to), status, ...linkers(P, to) })).sort((a, b) => b.count - a.count);

  const seen = new Set();
  const redirects = [];
  for (const r of crawl.redirects || []) {
    if (r.entry || seen.has(r.from)) continue;
    seen.add(r.from);
    redirects.push({ url: path(r.from), to: path(r.to), hops: r.hops, loop: !!r.loop, ...linkers(P, r.from) });
  }
  redirects.sort((a, b) => b.count - a.count);

  const inl = {};
  for (const p of P) for (const l of new Set(p.internalLinks.map(norm))) if (l !== norm(p.url)) inl[l] = (inl[l] || 0) + 1;
  const orphans = complete && smTotal >= 3
    ? P.filter((p, i) => i > 0 && p.fromSitemap && !inl[norm(p.url)] && !inl[norm(p.requested || p.url)]).map((p) => path(p.url))
    : null;

  // Status overview: every URL the crawl requested, by what the server answered. Redirects are counted by their first hop.
  const redirectedFrom = new Set((crawl.redirects || []).filter((r) => !r.entry).map((r) => r.from));
  const errs = crawl.errors || [];
  const statusClass = (e) => (typeof e.status === 'number' ? Math.floor(e.status / 100) : 0);
  const clientErrors = errs.filter((e) => statusClass(e) === 4 && !redirectedFrom.has(e.url));
  const serverErrors = errs.filter((e) => statusClass(e) === 5);
  const unreachable = errs.filter((e) => statusClass(e) === 0 && !e.nonHtml);
  const canonicalElsewhere = P.filter((p) => p.canonical && norm(p.canonical.startsWith('http') ? p.canonical : new URL(p.canonical, p.url).href) !== norm(p.url)).map((p) => ({ url: path(p.url), canonical: path(p.canonical) }));
  const notIndexable = new Set([...P.filter((p) => p.noindex).map((p) => path(p.url)), ...canonicalElsewhere.map((c) => c.url)]);
  const statusOverview = {
    requested: P.length + errs.length,
    loaded: P.length, // pages that ended on a readable HTML page (some after a redirect)
    redirected3xx: redirectedFrom.size,
    clientError4xx: clientErrors.length,
    serverError5xx: serverErrors.length,
    unreachable: unreachable.length,
    nonHtml: errs.filter((e) => e.nonHtml).length,
    blockedByRobots: crawl.blocked || 0,
    notIndexable: notIndexable.size, // noindex or a canonical pointing at a different page. Whether Google has indexed a page is in Search Console, not here.
  };
  const withLinkers = (list) => cap(list.map((e) => ({ url: path(e.url), status: e.status, ...linkers(P, e.url) })).sort((a, b) => b.count - a.count));

  // Links written with the wrong host or protocol, and where they end up. pagesSample lets the issue list name the pages that carry them.
  const variantPages = new Map();
  for (const p of P) for (const l of p.altHostLinks || []) { const k = norm(l); if (!variantPages.has(k)) variantPages.set(k, []); variantPages.get(k).push(path(p.url)); }
  const hv = crawl.hostVariants;
  const hostIssues = hv ? { canonicalHost: hv.canonicalHost, pagesLinking: hv.pagesLinking, httpLinks: hv.targets.filter((t) => /^http:/.test(t.url)).length, targets: cap([...hv.targets].sort((a, b) => b.count - a.count), 30).map((t) => ({ ...t, pagesSample: cap(variantPages.get(t.url) || [], 30) })) } : null;
  const redirectChains = (crawl.redirects || []).filter((r) => !r.entry && r.hops >= 2 && !r.loop).map((r) => ({ url: path(r.from), to: path(r.to), hops: r.hops }));
  const oneInlink = P.filter((p, i) => i > 0 && inl[norm(p.url)] === 1).map((p) => path(p.url));
  const parsedRobots = crawl.robots && crawl.robots.groups ? crawl.robots : parseRobots(crawl.robotsTxt);
  const aiBots = aiBotAccess(parsedRobots);
  const heavyImages = (crawl.imageSample || []).filter((i) => i.bytes > 300 * 1024).map((i) => ({ url: i.url, kb: Math.round(i.bytes / 1024) }));

  const out = {
    aiBots,
    hostIssues,
    redirectChains: cap(redirectChains, 30),
    schemaCoverage: schemaCoverage(P),
    orgSchema: orgSchema(P[0]),
    performance: performanceSample(crawl.timing),
    oneInlink: cap(oneInlink, 100),
    ogIncomplete: cap(P.filter((p) => !p.og).map((p) => path(p.url)), 200),
    heavyImages,
    statusOverview,
    clientErrors: withLinkers(clientErrors),
    serverErrors: withLinkers(serverErrors),
    unreachable: withLinkers(unreachable),
    canonicalElsewhere: cap(canonicalElsewhere),
    scannedAt: new Date().toISOString(),
    pages: P.length,
    sitemapUrls: smTotal,
    complete,
    stopped,
    downloadedBytes: crawl.bytes ? crawl.bytes.used : null,
    linksChecked: crawl.linkCheck?.targets || 0,
    broken: cap(broken),
    redirects: cap(redirects),
    noindex: cap(P.filter((p) => p.noindex).map((p) => path(p.url))),
    orphans: orphans && cap(orphans),
    dupDescriptions: cap(groups(P, (p) => p.description.toLowerCase()), 30),
    dupTitles: cap(groups(P, (p) => p.title.toLowerCase()), 30),
    h1Missing: cap(P.filter((p) => p.h1.length === 0).map((p) => path(p.url))),
    h1Multiple: cap(P.filter((p) => p.h1.length > 1).map((p) => ({ url: path(p.url), count: p.h1.length }))),
  };
  out.issues = issueList(out);
  out.health = healthScore(out);
  out.severity = { error: out.issues.filter((i) => i.severity === 'error').reduce((n, i) => n + i.count, 0), warning: out.issues.filter((i) => i.severity === 'warning').reduce((n, i) => n + i.count, 0), notice: out.issues.filter((i) => i.severity === 'notice').reduce((n, i) => n + i.count, 0) };
  return out;
}

// Adds what changed since the previous audit and the health trend. `earlier` = previous site_audits rows ({ day, data }), newest first.
function attachHistory(audit, earlier) {
  const rows = Array.isArray(earlier) ? earlier : [];
  const last = rows[0];
  audit.changes = last ? diffIssues(last.data && last.data.issues, audit.issues) : null;
  audit.changesSince = last ? last.day : null;
  audit.healthHistory = rows.slice().reverse().map((r) => ({ day: r.day, health: r.data && r.data.health != null ? r.data.health : null })).filter((x) => x.health !== null);
  return audit;
}

module.exports = { attachHistory, buildAudit, issueList, healthScore, diffIssues, pageType, schemaCoverage, orgSchema, performanceSample };
