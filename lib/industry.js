// Industry benchmarks and evidence-backed technical findings. PURE: no network, no database (the pipeline stores the snapshots, the report page
// reads them). Everything here is computed from crawls we already hold: your site's profile and the profiles of the competitors in your market,
// so every finding can say which numbers it rests on and how many sites they come from. "Top performers" are the three competitors with the
// highest overall score today; "field" is every competitor we scored. Nothing here changes a score.

const median = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

// lower_better: a bigger number is worse. unit is used when the number is written out.
const METRICS = {
  avgWords:     { label: 'Average words per page', unit: 'words', higher: true },
  thinPct:      { label: 'Pages under 300 words', unit: '%', higher: false },
  sitemapUrls:  { label: 'Pages listed in the sitemap', unit: 'pages', higher: true },
  schemaPct:    { label: 'Pages with structured data', unit: '%', higher: true },
  schemaTypes:  { label: 'Different structured-data types', unit: 'types', higher: true },
  faqPct:       { label: 'Pages that answer questions (FAQ)', unit: '%', higher: true },
  titleOkPct:   { label: 'Titles of 30 to 65 characters', unit: '%', higher: true },
  descOkPct:    { label: 'Meta descriptions of 70 to 160 characters', unit: '%', higher: true },
  h1OkPct:      { label: 'Pages with exactly one H1', unit: '%', higher: true },
  canonicalPct: { label: 'Pages with a canonical tag', unit: '%', higher: true },
  altPct:       { label: 'Images with alt text', unit: '%', higher: true },
  orphanPct:    { label: 'Pages no other page links to', unit: '%', higher: false },
  avgInlinks:   { label: 'Internal links pointing at a page (average)', unit: 'links', higher: true },
  medianMs:     { label: 'Median server response time', unit: 'ms', higher: false },
  slowPct:      { label: 'Pages slower than 1.5 seconds', unit: '%', higher: false },
  noindexPct:   { label: 'Pages marked noindex', unit: '%', higher: false },
  brokenLinks:  { label: 'Broken internal links found', unit: 'links', higher: false },
  heavyImages:  { label: 'Images over 300 KB', unit: 'images', higher: false },
  sameAsCount:  { label: 'Official profiles linked in markup (sameAs)', unit: 'profiles', higher: true },
  updated180Pct:{ label: 'Pages changed in the last 6 months', unit: '%', higher: true },
  medianAgeDays:{ label: 'Median age of page content', unit: 'days', higher: false },
  lcpMs:        { label: 'Largest Contentful Paint (home page, mobile)', unit: 'ms', higher: false },
  cls:          { label: 'Cumulative Layout Shift (home page, mobile)', unit: 'score', higher: false },
  inpMs:        { label: 'Interaction to Next Paint (real users)', unit: 'ms', higher: false },
  tbtMs:        { label: 'Total Blocking Time (lab test, mobile)', unit: 'ms', higher: false },
};

// The measurements of one site, from the profile stored with its score (lib/profile.js).
function profileMetrics(profile) {
  if (!profile || !Array.isArray(profile.pages) || !profile.pages.length) return null;
  const P = profile.pages, n = P.length;
  const images = P.reduce((s, p) => s + (p.images || 0), 0), alt = P.reduce((s, p) => s + (p.alt || 0), 0);
  return {
    avgWords: profile.avgWords ?? Math.round(P.reduce((s, p) => s + p.words, 0) / n),
    thinPct: pct(P.filter((p) => p.words < 300).length, n),
    sitemapUrls: profile.sitemapUrls || 0,
    schemaPct: pct(P.filter((p) => (p.schema || []).length).length, n),
    schemaTypes: (profile.schemaTypes || []).length,
    faqPct: pct(P.filter((p) => p.faq).length, n),
    titleOkPct: pct(P.filter((p) => p.title && p.title.length >= 30 && p.title.length <= 65).length, n),
    descOkPct: pct(P.filter((p) => p.descLen >= 70 && p.descLen <= 160).length, n),
    h1OkPct: pct(P.filter((p) => (p.h1 || []).length === 1).length, n),
    canonicalPct: pct(P.filter((p) => p.canonical).length, n),
    altPct: images ? pct(alt, images) : null,
    orphanPct: n > 1 ? pct(P.filter((p, i) => i > 0 && !p.inlinks).length, n - 1) : null,
    avgInlinks: round1(P.reduce((s, p) => s + (p.inlinks || 0), 0) / n),
    medianMs: median(P.map((p) => p.ms)),
    slowPct: pct(P.filter((p) => p.ms > 1500).length, n),
    noindexPct: pct(P.filter((p) => p.noindex).length, n),
    brokenLinks: (profile.brokenLinks || []).length,
    heavyImages: (profile.heavyImages || []).length,
    sameAsCount: (profile.sameAs || []).length,
    updated180Pct: profile.freshness ? profile.freshness.updated180Pct : null,
    medianAgeDays: profile.freshness ? profile.freshness.medianAgeDays : null,
    lcpMs: profile.vitals && profile.vitals.lcp != null ? Math.round(profile.vitals.lcp) : null,
    cls: profile.vitals && profile.vitals.cls != null ? Math.round(profile.vitals.cls * 1000) / 1000 : null,
    inpMs: profile.vitals && profile.vitals.inp != null ? Math.round(profile.vitals.inp) : null,
    tbtMs: profile.vitals && profile.vitals.tbt != null ? Math.round(profile.vitals.tbt) : null,
  };
}

// Things a site either has or does not: the share of the market that has each tells you how normal it is.
const FEATURES = {
  localBusiness: { label: 'LocalBusiness / Organization structured data', test: (p) => (p.schemaTypes || []).some((t) => /LocalBusiness|Organization|Contractor|ProfessionalService|Store|Restaurant/i.test(t)) },
  faqSchema:     { label: 'FAQPage structured data', test: (p) => (p.schemaTypes || []).includes('FAQPage') },
  breadcrumbs:   { label: 'BreadcrumbList structured data', test: (p) => (p.schemaTypes || []).includes('BreadcrumbList') },
  serviceSchema: { label: 'Service or Product structured data', test: (p) => (p.schemaTypes || []).some((t) => /^(Service|Product|Offer)$/i.test(t)) },
  reviewSchema:  { label: 'Review or rating structured data', test: (p) => (p.schemaTypes || []).some((t) => /Review|AggregateRating/i.test(t)) },
  llmsTxt:       { label: 'llms.txt for AI tools', test: (p) => !!p.llmsTxt },
  sameAs:        { label: 'Official profiles linked in markup', test: (p) => (p.sameAs || []).length > 0 },
};

// One site's row for the snapshot: its measurements and which features it has.
function siteRecord(domain, overall, profile) {
  const m = profileMetrics(profile);
  if (!m) return null;
  return { domain, overall: Number(overall) || 0, profilePages: profile.pages, metrics: m, features: Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, f.test(profile) ? 1 : 0])) };
}

// Compares you with the market. mine / others are siteRecords. Returns the numbers every finding and every trend is built from.
function benchmark(mine, others, { topN = 3 } = {}) {
  if (!mine) return null;
  const ranked = [...others].sort((a, b) => b.overall - a.overall);
  const top = ranked.slice(0, topN);
  const metrics = {};
  for (const k of Object.keys(METRICS)) {
    const col = (list) => list.map((r) => r.metrics[k]).filter((v) => v !== null && v !== undefined);
    metrics[k] = { mine: mine.metrics[k] ?? null, top: round1(median(col(top))), field: round1(median(col(ranked))), nTop: col(top).length, nField: col(ranked).length };
  }
  const adoption = {};
  for (const k of Object.keys(FEATURES)) adoption[k] = { mine: !!mine.features[k], top: pct(top.filter((r) => r.features[k]).length, top.length), field: pct(ranked.filter((r) => r.features[k]).length, ranked.length) };
  return { sites: ranked.length, topSites: top.map((t) => t.domain), metrics, adoption };
}

// How far behind you are on a metric (positive = behind the top performers, in the metric's own unit; negative = ahead).
const shortfall = (k, b) => { const m = b.metrics[k]; if (m.mine === null || m.top === null) return null; return METRICS[k].higher ? m.top - m.mine : m.mine - m.top; };
const fmt = (k, v) => (v === null || v === undefined ? 'no data' : METRICS[k].unit === 'score' ? String(v) : METRICS[k].unit === '%' ? `${v}%` : METRICS[k].unit === 'ms' ? `${Math.round(v)} ms` : `${Number.isInteger(v) ? v.toLocaleString('en-IN') : v} ${METRICS[k].unit}`);

// What changed since the previous crawl(s): is your gap narrowing, and are the leaders moving? history = earlier snapshots' `metrics`, oldest first.
function trendOf(k, b, history) {
  const prev = (history || []).map((h) => h.metrics && h.metrics[k]).filter((m) => m && m.mine !== null && m.top !== null);
  if (!prev.length) return null;
  const first = prev[0], last = prev[prev.length - 1], now = b.metrics[k];
  const gap = (m) => (METRICS[k].higher ? m.top - m.mine : m.mine - m.top);
  const was = gap(last), isNow = gap(now);
  const rel = was ? (isNow - was) / Math.abs(was) : 0;
  return {
    crawls: prev.length, sinceDay: (history.find((h) => h.metrics && h.metrics[k]) || {}).day || null,
    gapWas: round1(was), gapNow: round1(isNow),
    direction: Math.abs(rel) < 0.1 ? 'steady' : isNow < was ? 'closing' : 'widening',
    leadersMoved: first.top !== null && now.top !== null ? round1(now.top - first.top) : null,
  };
}

// Turns the comparison into findings, most important first. Every finding states its evidence (your number, the top performers', the market's, and
// how many sites those come from) and a concrete technical fix. Thresholds are deliberately plain so a finding can be explained to a client.
function buildFindings(mine, others, history = []) {
  const b = benchmark(mine, others);
  if (!b || !b.sites) return { benchmark: b, findings: [] };
  const out = [];
  const evidence = (k) => { const m = b.metrics[k]; return [{ label: METRICS[k].label, yours: fmt(k, m.mine), topPerformers: fmt(k, m.top), market: fmt(k, m.field), sites: m.nField, topSites: m.nTop }]; };
  const add = (id, area, severity, title, why, ks, fix, extra = {}) => out.push({ id, area, severity, title, why, evidence: ks.flatMap(evidence), trend: ks[0] ? trendOf(ks[0], b, history) : null, fix, ...extra });
  const behind = (k, min) => { const s = shortfall(k, b); return s !== null && s >= min ? s : null; };
  const P = (mine.profilePages || []);

  let s;
  if ((s = behind('avgWords', 150)) !== null) add('content-depth', 'seo', s >= 400 ? 'high' : 'medium', 'Pages are shorter than the pages that outrank you',
    `Search engines favour pages that cover a topic in depth. The top performers' pages average ${fmt('avgWords', b.metrics.avgWords.top)}; yours average ${fmt('avgWords', b.metrics.avgWords.mine)}.`, ['avgWords', 'thinPct'],
    `Expand the shortest service and location pages toward ${Math.round(b.metrics.avgWords.top / 50) * 50} words with sections that answer real questions (cost factors, process, materials, timelines, areas served). Do not pad: add information a buyer would look for.`, { pages: P.filter((p) => p.words < 300).slice(0, 8).map((p) => ({ url: p.url, note: `${p.words} words` })) });
  if ((s = behind('schemaPct', 25)) !== null || (s = behind('schemaTypes', 2)) !== null) add('structured-data', 'seo', 'medium', 'Structured data is thinner than the leaders\'',
    `${fmt('schemaPct', b.metrics.schemaPct.mine)} of your pages carry structured data against ${fmt('schemaPct', b.metrics.schemaPct.top)} for the top performers. It helps Google and AI assistants understand and quote your pages.`, ['schemaPct', 'schemaTypes'],
    'Add JSON-LD to every page type: Organization or LocalBusiness on the home page, Service on each service page, BreadcrumbList on inner pages, FAQPage where you answer questions. Validate in Google\'s Rich Results Test.');
  for (const [k, f] of Object.entries(FEATURES)) {
    const a = b.adoption[k];
    if (!a.mine && a.top !== null && a.top >= 66 && (a.field || 0) >= 40) add('feature-' + k, k === 'llmsTxt' ? 'geo' : 'seo', a.top === 100 ? 'medium' : 'low', `Missing: ${f.label}`,
      `${a.top}% of the top performers and ${a.field}% of the ${b.sites} sites we compared have this. You do not.`, [], k === 'llmsTxt' ? 'Publish /llms.txt: a short Markdown file naming your business, services, areas and your most important pages, so AI tools can summarise you correctly.' : `Add ${f.label} to the relevant pages (see the structured-data finding for where each type goes).`, { evidence: [{ label: f.label, yours: 'no', topPerformers: `${a.top}% have it`, market: `${a.field}% have it`, sites: b.sites, topSites: b.topSites.length }] });
  }
  if ((s = behind('faqPct', 15)) !== null) add('faq-coverage', 'geo', 'medium', 'Fewer pages answer customer questions than on leading sites',
    `Question-and-answer content is what AI assistants and Google's "People also ask" quote. ${fmt('faqPct', b.metrics.faqPct.top)} of the top performers' pages have it; ${fmt('faqPct', b.metrics.faqPct.mine)} of yours.`, ['faqPct'],
    'Add 4 to 6 question-and-answer blocks to each main service page, written as the questions customers actually ask, with direct answers in the first sentence. Mark them up with FAQPage structured data.');
  if ((s = behind('titleOkPct', 20)) !== null || (s = behind('descOkPct', 20)) !== null) add('snippets', 'seo', 'medium', 'Titles or descriptions are outside the lengths that display well',
    `Only ${fmt('titleOkPct', b.metrics.titleOkPct.mine)} of your titles and ${fmt('descOkPct', b.metrics.descOkPct.mine)} of your descriptions are in the range that shows in full on Google; the top performers manage ${fmt('titleOkPct', b.metrics.titleOkPct.top)} and ${fmt('descOkPct', b.metrics.descOkPct.top)}.`, ['titleOkPct', 'descOkPct'],
    'Rewrite titles to 30 to 65 characters with the main keyword first, and meta descriptions to 70 to 160 characters that state a benefit and a call to action. Make each one unique.', { pages: P.filter((p) => !p.title || p.title.length < 30 || p.title.length > 65 || p.descLen < 70 || p.descLen > 160).slice(0, 8).map((p) => ({ url: p.url, note: `title ${(p.title || '').length} chars, description ${p.descLen}` })) });
  if ((s = behind('h1OkPct', 20)) !== null) add('headings', 'seo', 'low', 'Heading structure is inconsistent', `${fmt('h1OkPct', b.metrics.h1OkPct.mine)} of your pages have exactly one H1; the leaders have ${fmt('h1OkPct', b.metrics.h1OkPct.top)}.`, ['h1OkPct'], 'Give every page exactly one H1 that states what the page is about, then use H2 and H3 for the sections beneath it.', { pages: P.filter((p) => (p.h1 || []).length !== 1).slice(0, 8).map((p) => ({ url: p.url, note: `${(p.h1 || []).length} H1` })) });
  if ((s = behind('orphanPct', 10)) !== null || (s = behind('avgInlinks', 2)) !== null) add('internal-links', 'seo', 'medium', 'Internal linking is weaker than the leaders\'',
    `${fmt('orphanPct', b.metrics.orphanPct.mine)} of your pages are not linked from any other page we read (top performers: ${fmt('orphanPct', b.metrics.orphanPct.top)}). Pages with no internal links rarely rank.`, ['orphanPct', 'avgInlinks'],
    'Link every service and location page from at least three related pages and from the main navigation or a hub page, using descriptive anchor text instead of "click here".', { pages: P.filter((p, i) => i > 0 && !p.inlinks).slice(0, 8).map((p) => ({ url: p.url, note: 'no internal links to it' })) });
  if ((s = behind('medianMs', 400)) !== null || (s = behind('slowPct', 15)) !== null) add('speed', 'seo', s !== null && s > 1200 ? 'high' : 'medium', 'The server answers more slowly than the leaders\'',
    `Your median response is ${fmt('medianMs', b.metrics.medianMs.mine)} against ${fmt('medianMs', b.metrics.medianMs.top)} for the top performers, and ${fmt('slowPct', b.metrics.slowPct.mine)} of your pages take over 1.5 seconds. (Server response time as we measured it, not full browser load time.)`, ['medianMs', 'slowPct'],
    'Turn on page caching and a CDN, compress and resize images, remove unused scripts, and check hosting. Re-test with PageSpeed Insights for Core Web Vitals.', { pages: P.filter((p) => p.ms > 1500).slice(0, 8).map((p) => ({ url: p.url, note: `${p.ms} ms` })) });
  if (b.metrics.brokenLinks.mine > 0 || b.metrics.heavyImages.mine > 0) add('hygiene', 'seo', b.metrics.brokenLinks.mine >= 5 ? 'high' : 'medium', 'Broken links and heavy images',
    `We found ${b.metrics.brokenLinks.mine} broken internal link(s) and ${b.metrics.heavyImages.mine} image(s) over 300 KB on your site; the top performers show ${fmt('brokenLinks', b.metrics.brokenLinks.top)} and ${fmt('heavyImages', b.metrics.heavyImages.top)}.`, ['brokenLinks', 'heavyImages'],
    'Fix or redirect each broken link (the full-site audit lists them with the pages that link to them) and convert large images to WebP at the displayed size.');
  if ((s = behind('noindexPct', 0.1)) !== null && b.metrics.noindexPct.mine > 0) add('indexability', 'seo', 'high', 'Pages are blocked from Google with noindex', `${fmt('noindexPct', b.metrics.noindexPct.mine)} of the pages we read tell Google not to index them. The top performers: ${fmt('noindexPct', b.metrics.noindexPct.top)}.`, ['noindexPct'], 'Remove noindex from any page that should bring customers (keep it on thank-you, login and internal pages), then request indexing in Search Console.', { pages: P.filter((p) => p.noindex).slice(0, 8).map((p) => ({ url: p.url, note: 'noindex' })) });
  if ((s = behind('sameAsCount', 2)) !== null) add('entity', 'geo', 'low', 'Fewer official profiles are linked than on leading sites', `You link ${fmt('sameAsCount', b.metrics.sameAsCount.mine)} against ${fmt('sameAsCount', b.metrics.sameAsCount.top)} for the top performers. Linking your Google Business, LinkedIn and other profiles helps search engines and AI tools treat them as one business.`, ['sameAsCount'], 'List every official profile in the "sameAs" field of your Organization / LocalBusiness JSON-LD.');
  if ((s = behind('sitemapUrls', 20)) !== null) add('content-volume', 'seo', 'medium', 'The market publishes more pages than you', `Your sitemap lists ${fmt('sitemapUrls', b.metrics.sitemapUrls.mine)}; the top performers' list ${fmt('sitemapUrls', b.metrics.sitemapUrls.top)}. More useful pages means more searches you can appear for.`, ['sitemapUrls'], 'Use the content-gap list in this report: build a dedicated page for each topic two or more competitors cover and you do not.');

  const rated = (k, lim) => b.metrics[k].mine !== null && b.metrics[k].mine > lim;
  if (rated('lcpMs', 2500) || rated('cls', 0.1) || rated('inpMs', 200) || rated('tbtMs', 200)) {
    const bad = [rated('lcpMs', 2500) && 'LCP over 2.5 s', rated('cls', 0.1) && 'CLS over 0.1', rated('inpMs', 200) && 'INP over 200 ms', rated('tbtMs', 200) && 'blocking time over 200 ms'].filter(Boolean);
    const poor = rated('lcpMs', 4000) || rated('cls', 0.25) || rated('inpMs', 500) || rated('tbtMs', 600);
    add('core-web-vitals', 'seo', poor ? 'high' : 'medium', 'Core Web Vitals are outside Google\'s "good" range',
      `Google measures loading, responsiveness and visual stability and uses them as a ranking signal. On your home page (mobile): ${bad.join(', ')}.`, ['lcpMs', 'cls', 'inpMs', 'tbtMs'].filter((k) => b.metrics[k].mine !== null),
      'Largest Contentful Paint: compress and properly size the hero image, preload it, and cut render-blocking CSS and scripts. Layout shift: set width and height on images and embeds and reserve space for banners. Interaction: defer or remove third-party scripts (chat widgets, trackers). Re-test in PageSpeed Insights.');
  }
  if ((s = behind('updated180Pct', 25)) !== null || (s = behind('medianAgeDays', 180)) !== null) add('freshness', 'seo', 'medium', 'Your content is older than the leaders\'',
    `${fmt('updated180Pct', b.metrics.updated180Pct.mine)} of your dated pages changed in the last 6 months against ${fmt('updated180Pct', b.metrics.updated180Pct.top)} for the top performers (median page age: ${fmt('medianAgeDays', b.metrics.medianAgeDays.mine)} against ${fmt('medianAgeDays', b.metrics.medianAgeDays.top)}). Fresh, maintained pages are favoured for searches where the answer changes.`, ['updated180Pct', 'medianAgeDays'],
    'Review your main service and location pages every quarter: update facts, projects, prices and photos, and show the "last updated" date and the dateModified field in your structured data. Publish new project or case-study pages regularly.');

  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, c) => rank[a.severity] - rank[c.severity]);
  return { benchmark: b, findings: out };
}

// Share of voice: for each domain, in how many of the tracked keyword x location searches it appears in Google's top 3 and top 10.
// serpRows: { keyword, location, position, domain } for one day. Returns { domain: { pairs, top3, top10 } } for the domains asked about.
function shareOfVoice(serpRows, domains) {
  const pairs = new Set(serpRows.map((r) => `${r.keyword}|${r.location || ''}`));
  const best = new Map(); // domain -> pair -> best position
  for (const r of serpRows) {
    const m = best.get(r.domain) || new Map(); const k = `${r.keyword}|${r.location || ''}`;
    if (!(m.get(k) <= r.position)) m.set(k, r.position);
    best.set(r.domain, m);
  }
  const out = {};
  for (const d of domains) { const m = best.get(d) || new Map(); out[d] = { pairs: pairs.size, top3: [...m.values()].filter((p) => p <= 3).length, top10: [...m.values()].filter((p) => p <= 10).length }; }
  return out;
}

module.exports = { shareOfVoice, METRICS, FEATURES, profileMetrics, siteRecord, benchmark, trendOf, buildFindings, median };
