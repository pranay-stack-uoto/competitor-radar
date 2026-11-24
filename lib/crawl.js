const cheerio = require('cheerio');
const crypto = require('crypto');
const { safeFetch, request, GuardError, createByteBudget } = require('./security/netguard');
const { parseRobots, agentBlocked } = require('./robots');

const MAX_BODY = 6 * 1024 * 1024; // no single response is read past this
// Everything one crawl may download in total (robots.txt, sitemaps, pages, link checks, image checks). Counted from the bytes actually
// read, after decompression. Set per crawl with cfg.crawl.maxTotalBytes, or for everything with CRAWL_MAX_TOTAL_BYTES.
// Sized from real sites: a Wix site averages about 1.3 MB of HTML per page, so 40 pages is about 50 MB and a full audit of 133 pages
// about 170 MB. The defaults leave roughly twice that, so normal crawls are never cut short, while a hostile or huge site is.
const DEFAULT_TOTAL_BYTES = 100 * 1024 * 1024;
function resolveBudgetBytes(cfg, env = process.env) {
  for (const v of [cfg && cfg.crawl && cfg.crawl.maxTotalBytes, env.CRAWL_MAX_TOTAL_BYTES]) { const n = Number(v); if (Number.isFinite(n) && n > 0) return Math.floor(n); }
  return DEFAULT_TOTAL_BYTES;
}
const isBudgetError = (e) => e instanceof GuardError && e.code === 'budget-exhausted';
const isAbortError = (e) => e instanceof GuardError && e.code === 'aborted'; // the owning job lost its lease: stop the whole crawl
const TEXT_TYPES = /^(text\/|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml)|$)/i;
const failure = (e) => (e instanceof GuardError ? e.code : String((e && e.message) || e).slice(0, 120));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn over items with at most n in flight.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; out.push(await fn(it)); }
  }));
  return out;
}

// Same as get(), but follows redirects one hop at a time so chains and loops are visible. Each hop is validated by the guard.
// method 'HEAD' skips the body (used to check links and image sizes cheaply).
async function getTracked(url, ua, timeoutMs = 15000, method = 'GET', budget) {
  const chain = [];
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    try {
      const r = await request(cur, { method, headers: { 'user-agent': ua, accept: 'text/html,*/*' }, timeoutMs, maxBytes: MAX_BODY, allowTypes: TEXT_TYPES, budget });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        chain.push({ url: cur, status: r.status });
        let next;
        try { next = new URL(loc, cur).href; } catch { return { ok: false, status: r.status, type: '', body: '', url: cur, chain, error: 'bad redirect' }; }
        if (chain.some((c) => c.url === next)) return { ok: false, status: r.status, type: '', body: '', url: next, chain, loop: true };
        cur = next;
        continue;
      }
      return { ok: r.ok, status: r.status, type: r.type, body: r.body, url: cur, chain, xrobots: (r.headers.get('x-robots-tag') || '').toLowerCase(), length: r.length, ttfbMs: r.ttfbMs, totalMs: r.totalMs, bytes: r.bytes, encoding: r.encoding };
    } catch (e) {
      if (isBudgetError(e) || isAbortError(e)) throw e; // the whole crawl must stop, not just this request
      return { ok: false, status: 0, type: '', body: '', url: cur, chain, error: failure(e) };
    }
  }
  return { ok: false, status: 310, type: '', body: '', url: cur, chain, tooMany: true };
}

// Round-robin over the kinds of page (/post/..., /blog/..., top-level pages) so a small sample covers all of them
// instead of only the first section of the sitemap. A top-level page like /about counts as one kind.
function spread(urls) {
  const groups = new Map();
  for (const u of urls) {
    let k = '';
    try { const seg = new URL(u).pathname.split('/').filter(Boolean); k = seg.length > 1 ? seg[0] : ''; } catch {}
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  }
  const lists = [...groups.values()], out = [];
  for (let i = 0; out.length < urls.length; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

// Only probe hosts that look like ordinary public sites (images often live on a CDN).
const publicHost = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !/^[\d.]+$|^\[|^localhost$|\.local$|\.internal$/i.test(x.hostname); } catch { return false; } };

// Every outbound fetch goes through the SSRF guard (lib/security/netguard.js): validated URL, validated address at
// connect time, validated redirects, capped size and time.
async function get(url, ua, timeoutMs = 15000, budget, signal) {
  try {
    const r = await safeFetch(url, { headers: { 'user-agent': ua, accept: 'text/html,*/*' }, timeoutMs, maxBytes: MAX_BODY, allowTypes: TEXT_TYPES, budget, signal });
    return { ok: r.ok, status: r.status, type: r.type, body: r.ok ? r.body : '', url: r.url };
  } catch (e) {
    if (isBudgetError(e) || isAbortError(e)) throw e; // the whole crawl must stop, not just this request
    return { ok: false, status: 0, type: '', body: '', url, error: failure(e) };
  }
}

function extractLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).contents().text());
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          if (n['@type']) out.push(n);
          if (n['@graph']) walk(n['@graph']);
        }
      };
      walk(j);
    } catch {}
  });
  return out;
}
const typesOf = (ld) => ld.flatMap((n) => [].concat(n['@type']));

// A usable calendar date (YYYY-MM-DD) from whatever a page or sitemap says, or '' when it is missing, unreadable, absurdly old or in the future.
function isoDate(v, now = Date.now()) {
  if (!v || typeof v !== 'string') return '';
  const t = Date.parse(v.trim());
  if (!Number.isFinite(t) || t < Date.parse('2000-01-01') || t > now + 86400000) return '';
  return new Date(t).toISOString().slice(0, 10);
}
// When a page was last changed: the newest 'modified' date it declares, else the newest 'published' date.
function pageDate($, ld) {
  const latest = (list) => list.map((v) => isoDate(String(v || ''))).filter(Boolean).sort().pop() || '';
  const modified = [...ld.map((n) => n.dateModified), $('meta[property="article:modified_time"]').attr('content'), $('meta[property="og:updated_time"]').attr('content'), $('meta[itemprop="dateModified"]').attr('content')];
  const published = [...ld.map((n) => n.datePublished), $('meta[property="article:published_time"]').attr('content'), $('time[datetime]').first().attr('datetime')];
  return latest(modified) || latest(published);
}

function analyzePage(html, url) {
  const $ = cheerio.load(html);
  const ld = extractLd($);
  const modified = pageDate($, ld);
  $('script,style,noscript').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const words = text ? text.split(' ').length : 0;
  const host = new URL(url).host;
  const links = [], altHost = [];
  const bareHost = (h) => h.replace(/^www\./, '');
  const pageProto = new URL(url).protocol;
  $('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), url);
      u.hash = '';
      const asset = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js|xml)$/i.test(u.pathname);
      if (u.host === host && /^https?:$/.test(u.protocol) && !asset) links.push(u.href);
      // The same site written another way: www vs non-www, or http on an https site. Each such link makes visitors and Google take a redirect.
      if (/^https?:$/.test(u.protocol) && !asset && bareHost(u.host) === bareHost(host) && (u.host !== host || u.protocol !== pageProto)) altHost.push(u.href);
    } catch {}
  });
  const imgs = $('img');
  const imgsWithAlt = imgs.filter((_, i) => ($(i).attr('alt') || '').trim()).length;
  const imgSrcs = [];
  imgs.each((_, i) => {
    const s = $(i).attr('src') || $(i).attr('data-src');
    if (!s || /^data:/i.test(s)) return;
    try { imgSrcs.push(new URL(s, url).href); } catch {}
  });
  return {
    url,
    title: ($('title').first().text() || '').trim(),
    description: ($('meta[name="description"]').attr('content') || '').trim(),
    canonical: $('link[rel="canonical"]').attr('href') || '',
    robotsMeta: ($('meta[name="robots"]').attr('content') || '').toLowerCase(),
    lang: $('html').attr('lang') || '',
    viewport: !!$('meta[name="viewport"]').length,
    og: ['og:title', 'og:description', 'og:image'].every((p) => $(`meta[property="${p}"]`).length > 0),
    h1: $('h1').map((_, e) => $(e).text().trim()).get(),
    h2: $('h2').map((_, e) => $(e).text().trim()).get(),
    words,
    text: text.slice(0, 60000),
    images: imgs.length,
    imagesWithAlt: imgsWithAlt,
    imgSrcs: [...new Set(imgSrcs)].slice(0, 12),
    bodyHash: words >= 80 ? crypto.createHash('sha1').update(text.toLowerCase()).digest('hex') : '',
    internalLinks: [...new Set(links)],
    altHostLinks: [...new Set(altHost)].slice(0, 40),
    ogType: $('meta[property="og:type"]').attr('content') || '',
    ldTypes: typesOf(ld),
    ld,
    hasQuestions: /<(h2|h3)[^>]*>[^<]*\?/i.test(html) || typesOf(ld).includes('FAQPage'),
    tel: !!$('a[href^="tel:"]').length,
    mapsEmbed: /google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps/i.test(html),
    sameAs: ld.flatMap((n) => [].concat(n.sameAs || [])),
    hasAuthor: /rel=["']author["']|itemprop=["']author["']|"author"\s*:/i.test(html),
    modified,
    hasDate: /datePublished|dateModified|<time\b/i.test(html),
  };
}

async function sitemapUrls(base, robots, ua, fetchGet = get) {
  const cands = robots.sitemaps.length ? robots.sitemaps : [new URL('/sitemap.xml', base).href];
  const urls = [], lastmod = {};
  const readEntries = (body) => { // <url><loc>..</loc><lastmod>..</lastmod></url>: keep the date with its address
    for (const m of body.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = (m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/) || [])[1], lm = isoDate(((m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1]) || '');
      if (loc && lm && Object.keys(lastmod).length < 3000) lastmod[loc.replace(/\/$/, '')] = lm;
    }
  };
  let found = false;
  for (const sm of cands.slice(0, 3)) {
    const r = await fetchGet(sm, ua);
    if (!r.ok) continue;
    found = true;
    readEntries(r.body);
    const locs = [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    for (const l of locs) {
      if (/\.xml(\.gz)?$/i.test(l) && urls.length < 200) {
        const sub = await fetchGet(l, ua);
        if (sub.ok) readEntries(sub.body);
        if (sub.ok) urls.push(...[...sub.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
      } else urls.push(l);
    }
  }
  return { found, urls: [...new Set(urls)], lastmod };
}

async function crawlSite(siteUrl, cfg) {
  // cfg.fetchers exists so tests can run the crawler against a fake website. Production never sets it, so every real request
  // goes through the SSRF guard (lib/security/netguard.js).
  // One byte budget covers everything this crawl downloads. When it is spent the crawl stops and returns what it has.
  const budget = createByteBudget(resolveBudgetBytes(cfg), { signal: cfg.signal }); // cfg.signal: abort when the owning job loses its lease
  const net = cfg.fetchers || { get: (u, ua, t) => get(u, ua, t, budget), getTracked: (u, ua, t, m) => getTracked(u, ua, t, m, budget) };
  const ua = cfg.crawl.userAgent;
  const base = new URL(siteUrl);
  const origin = base.origin;
  const out = { origin, pages: [], errors: [], redirects: [], brokenLinks: [], linkCheck: { targets: 0, verified: 0 }, imageSample: [] };

  try {
  const rob = await net.get(origin + '/robots.txt', ua);
  out.robotsTxt = rob.ok && !/<html/i.test(rob.body.slice(0, 200)) ? rob.body : '';
  out.robots = parseRobots(out.robotsTxt);
  const llms = await net.get(origin + '/llms.txt', ua);
  out.llmsTxt = llms.ok && !/<html/i.test(llms.body.slice(0, 200)) && llms.body.length > 20;
  const sm = await sitemapUrls(origin, out.robots, ua, net.get);
  out.sitemap = { found: sm.found, count: sm.urls.length };
  out.sitemapLastmod = sm.lastmod || {};

  // Queue: homepage first, then internal links from it, then sitemap URLs
  const max = cfg.crawl.maxPagesPerSite;
  const seen = new Set();
  const queue = [base.href];
  // Same site if the host matches with or without "www." (a domain saved as example.com often serves from www.example.com).
  const bare = (h) => h.replace(/^www\./, '');
  const sitemapQueue = spread(sm.urls.filter((u) => { try { return bare(new URL(u).host) === bare(base.host); } catch { return false; } }));
  const frontier = [], inFrontier = new Set(); // links found on every crawled page, read after the sitemap pages
  const sitemapSet = new Set(sitemapQueue.map((u) => u.replace(/\/$/, '')));
  out.sitemap.sampled = sitemapSet.size;
  const disallowed = (url) => {
    const rules = out.robots.groups['*'] || [];
    const p = new URL(url).pathname;
    return rules.some((r) => !r.allow && r.path && r.path !== '/' && p.startsWith(r.path)) || (rules.some((r) => !r.allow && r.path === '/') && !rules.some((r) => r.allow && p.startsWith(r.path)));
  };
  const t0 = Date.now(), maxMs = cfg.crawl.maxMs || 45000; // never let one site hold a worker for long
  const conc = Math.max(1, Math.min(8, cfg.crawl.concurrency || 1)); // only the audit of the owner's own site reads in parallel; scoring crawls stay one at a time
  out.blocked = 0;
  let firstFetch = true;
  while ((queue.length || sitemapQueue.length || frontier.length) && out.pages.length < max && Date.now() - t0 < maxMs && !(cfg.signal && cfg.signal.aborted)) {
    const batch = [];
    while (batch.length < conc && out.pages.length + batch.length < max) {
      const url = queue.shift() || sitemapQueue.shift() || frontier.shift();
      if (!url) break;
      const key = url.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (disallowed(url)) { out.blocked++; continue; }
      batch.push({ url, key });
    }
    if (!batch.length) continue;
    const fetched = await Promise.all(batch.map(async (b) => { const started = Date.now(); 
      let r = await net.getTracked(b.url, ua);
      // A name lookup or connection that fails once is usually a hiccup, not a missing page: try once more before reporting the page as unreachable.
      if (!r.ok && !r.status && /^(dns-failed|timeout|connection)/.test(String(r.error || ''))) { await sleep(700); r = await net.getTracked(b.url, ua); }
      return { ...b, r, started }; }));
    for (const { url, key, r, started } of fetched) {
    const entry = firstFetch && out.pages.length === 0 && !out.errors.length;
    firstFetch = false;
    if (r.chain.length || r.loop || r.tooMany) out.redirects.push({ from: url, to: r.url, hops: r.chain.length, status: r.chain[0]?.status, loop: !!(r.loop || r.tooMany), entry });
    if (!r.ok || !/html/i.test(r.type)) { out.errors.push({ url, status: r.status || r.error, loop: !!(r.loop || r.tooMany), nonHtml: !!(r.ok && !/html/i.test(r.type)) }); continue; }
    const fkey = r.url.replace(/\/$/, '');
    if (fkey !== key) { if (seen.has(fkey)) continue; seen.add(fkey); }
    const page = analyzePage(r.body, r.url);
    r.body = null; // the HTML has been reduced to the fields we keep; let the string be freed
    page.ms = Date.now() - started;
    page.status = r.status;
    page.ttfb = r.ttfbMs; page.totalMs = r.totalMs; page.bytes = r.bytes; page.enc = r.encoding || '';
    page.https = r.url.startsWith('https:');
    page.requested = url;
    page.redirectHops = r.chain.length;
    page.noindex = /noindex/.test(page.robotsMeta) || /noindex/.test(r.xrobots || '');
    page.fromSitemap = sitemapSet.has(key);
    out.pages.push(page);
    for (const l of page.internalLinks) { const k = l.replace(/\/$/, ''); if (!seen.has(k) && !inFrontier.has(k) && frontier.length < (cfg.crawl.frontierMax || 1000)) { inFrontier.add(k); frontier.push(l); } }
    // Homepage links first (the pages owners care about), then a spread across the sitemap, then the rest of the homepage links.
    if (out.pages.length === 1) { queue.push(...page.internalLinks.slice(0, 6)); sitemapQueue.push(...page.internalLinks.slice(6, 60)); }
    }
    await sleep(cfg.crawl.delayMs);
  }

  // Links: which internal links point at broken or redirecting URLs. Pages we crawled are checked for free;
  // links to pages we did not crawl are spot-checked (HEAD, small sample, short time budget).
  const norm = (u) => u.replace(/\/$/, '');
  const crawled = new Set(out.pages.flatMap((p) => [norm(p.url), norm(p.requested)]));
  const failed = new Map(out.errors.map((e) => [norm(e.url), e]));
  const linkFrom = new Map();
  for (const p of out.pages) for (const l of p.internalLinks) { const k = norm(l); if (!linkFrom.has(k)) linkFrom.set(k, p.url); }
  let targets = 0;
  for (const [k, from] of linkFrom) {
    if (crawled.has(k)) targets++;
    else if (failed.has(k)) { targets++; const e = failed.get(k); if (e.loop || e.status >= 400) out.brokenLinks.push({ from, to: k, status: e.loop ? 'loop' : e.status }); }
  }
  const todo = [...linkFrom.entries()].filter(([k]) => !crawled.has(k) && !failed.has(k) && !disallowed(k)).slice(0, cfg.crawl.linkCheckMax || 40);
  const linkDeadline = Date.now() + 15000;
  await pool(todo, 6, async ([k, from]) => {
    if (Date.now() > linkDeadline) return;
    let r = await net.getTracked(k, ua, 8000, 'HEAD');
    if ([400, 403, 405, 501].includes(r.status)) r = await net.getTracked(k, ua, 8000, 'GET');
    if (!r.status) return; // network trouble, not evidence of a broken link
    out.linkCheck.verified++; targets++;
    if (r.loop || r.tooMany) out.redirects.push({ from: k, to: r.url, hops: r.chain.length, loop: true, via: from });
    else if (r.chain.length) out.redirects.push({ from: k, to: r.url, hops: r.chain.length, status: r.chain[0].status, via: from });
    if (r.loop || r.status >= 400) out.brokenLinks.push({ from, to: k, status: r.loop ? 'loop' : r.status });
  });
  out.linkCheck.targets = targets;

  // Links that write the site another way (non-www, http): where each one really ends up, and through how many hops. The pages are not crawled.
  const variantFrom = new Map();
  for (const p of out.pages) for (const l of p.altHostLinks || []) { const k = norm(l); if (!variantFrom.has(k)) variantFrom.set(k, new Set()); variantFrom.get(k).add(p.url); }
  if (cfg.crawl.hostCheck) { // the owner's own full-site audit only; competitor crawls do not pay for these requests
    out.hostVariants = { canonicalHost: new URL(out.pages[0] ? out.pages[0].url : siteUrl).host, pagesLinking: new Set([...variantFrom.values()].flatMap((v) => [...v])).size, targets: [] };
    await pool([...variantFrom.entries()].slice(0, 60), 6, async ([k, from]) => {
      const r = await net.getTracked(k, ua, 8000, 'HEAD');
      out.hostVariants.targets.push({ url: k, count: from.size, status: r.chain.length ? r.chain[0].status : r.status, to: r.url, hops: r.chain.length });
    });
  }

  // Speed, measured properly: a few pages fetched ONE AT A TIME (the crawl above may run several at once, which slows every request).
  // ttfb = until the server's headers arrive; total = the whole HTML; bytes and compression as sent.
  if (cfg.crawl.timingSample) {
    const step = Math.max(1, Math.floor(out.pages.length / cfg.crawl.timingSample));
    out.timing = [];
    for (let i = 0; i < out.pages.length && out.timing.length < cfg.crawl.timingSample; i += step) {
      if (cfg.signal && cfg.signal.aborted) break;
      const u = out.pages[i].requested || out.pages[i].url;
      const r = await net.getTracked(u, ua);
      if (r.ok) out.timing.push({ url: r.url, ttfb: r.ttfbMs, total: r.totalMs, bytes: r.bytes, enc: r.encoding || '' });
      await sleep(cfg.crawl.delayMs);
    }
  }

  // Image weight: size of a small sample of images, from the Content-Length header.
  const imgUrls = [...new Set(out.pages.flatMap((p) => p.imgSrcs))].filter(publicHost).slice(0, cfg.crawl.imageSample || 12);
  const sizes = await pool(imgUrls, 6, async (u) => {
    const r = await net.getTracked(u, ua, 6000, 'HEAD');
    return r.ok && r.length ? { url: u, bytes: r.length } : null;
  });
  out.imageSample = sizes.filter(Boolean);
  } catch (e) {
    if (!isBudgetError(e)) throw e;
    out.stopped = { reason: 'byte-budget', usedBytes: budget.used, maxBytes: budget.max, pages: out.pages.length };
  }
  if (cfg.signal && cfg.signal.aborted) throw new GuardError('aborted'); // never hand back a crawl that was cut short by a lost lease
  out.bytes = { used: budget.used, max: budget.max };
  // Nothing readable inside the budget: report that clearly instead of returning an empty crawl that looks like an outage.
  if (out.stopped && !out.pages.length) throw new GuardError('budget-exhausted', `${budget.used}/${budget.max}`);
  return out;
}

module.exports = { crawlSite, agentBlocked, get, getTracked, analyzePage, parseRobots, resolveBudgetBytes, DEFAULT_TOTAL_BYTES };
