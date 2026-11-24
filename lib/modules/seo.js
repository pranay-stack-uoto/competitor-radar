const { score, frac, clamp, inRange } = require('./util');

module.exports = async function seo(crawl, cfg, ctx) {
  const P = crawl.pages;
  const n = P.length;
  if (!n) return { score: 0, checks: [], note: 'No pages could be crawled' };
  const dupTitles = n - new Set(P.map((p) => p.title.toLowerCase()).filter(Boolean)).size;
  const imgs = P.reduce((s, p) => s + p.images, 0);
  const alts = P.reduce((s, p) => s + p.imagesWithAlt, 0);
  const avgWords = P.reduce((s, p) => s + p.words, 0) / n;
  const avgMs = P.reduce((s, p) => s + p.ms, 0) / n;

  const checks = [
    { name: 'Title tags (30-65 chars)', weight: 2, value: frac(P.filter((p) => p.title.length >= 30 && p.title.length <= 65).length, n), note: `${P.filter((p) => !p.title).length} pages missing a title` },
    { name: 'Unique titles', weight: 1, value: 1 - frac(dupTitles, n), note: `${dupTitles} duplicate titles` },
    { name: 'Meta descriptions (70-160 chars)', weight: 2, value: frac(P.filter((p) => p.description.length >= 70 && p.description.length <= 160).length, n), note: `${P.filter((p) => !p.description).length} pages missing a description` },
    { name: 'Exactly one H1', weight: 2, value: frac(P.filter((p) => p.h1.length === 1).length, n) },
    { name: 'Subheadings (H2) present', weight: 1, value: frac(P.filter((p) => p.h2.length >= 2).length, n) },
    { name: 'Content depth (avg words)', weight: 2, value: inRange(avgWords, 600, 3000, 600), note: `${Math.round(avgWords)} words per page on average` },
    { name: 'Image alt text', weight: 1, value: imgs ? frac(alts, imgs) : 1, note: `${alts}/${imgs} images have alt text` },
    { name: 'Canonical tags', weight: 1, value: frac(P.filter((p) => p.canonical).length, n) },
    { name: 'Mobile viewport', weight: 1, value: frac(P.filter((p) => p.viewport).length, n) },
    { name: 'HTTPS', weight: 1, value: frac(P.filter((p) => p.https).length, n) },
    { name: 'Open Graph tags', weight: 0.5, value: frac(P.filter((p) => p.og).length, n) },
    { name: 'XML sitemap', weight: 1, value: crawl.sitemap.found ? 1 : 0, note: `${crawl.sitemap.count} URLs listed` },
    { name: 'robots.txt', weight: 0.5, value: crawl.robotsTxt ? 1 : 0 },
    { name: 'Server response time', weight: 1, value: inRange(avgMs, 0, 800, 2000), note: `${Math.round(avgMs)} ms average` },
    { name: 'Crawl errors', weight: 1, value: 1 - clamp(frac(crawl.errors.length, n + crawl.errors.length) * 3), note: `${crawl.errors.length} URLs failed` },
  ];

  // Technical checks. They work on the pages we crawled plus a spot-check of linked URLs, so notes say "checked", not "found".
  const path = (u) => { try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return String(u); } };
  const eg = (list, f) => list.slice(0, 3).map(f).join(', ');
  const norm = (u) => String(u).replace(/\/$/, '');
  const linkTargets = Math.max(1, crawl.linkCheck?.targets || n);

  const reds = (crawl.redirects || []).filter((r) => !r.entry);
  const chains = reds.filter((r) => r.loop || r.hops >= 2);
  const singles = reds.length - chains.length;
  checks.push({
    name: 'Redirects (chains and loops)', weight: 1,
    value: 1 - clamp((chains.length + singles * 0.25) / linkTargets * 4),
    note: reds.length ? `${chains.length} chains or loops and ${singles} single redirects among ${linkTargets} internal URLs checked, e.g. ${eg(reds, (r) => path(r.from) + ' to ' + path(r.to))}` : `No redirects among ${linkTargets} internal URLs checked`,
  });

  const broken = crawl.brokenLinks || [];
  const brokenTargets = new Set(broken.map((b) => b.to)).size;
  checks.push({
    name: 'Broken internal links', weight: 2,
    value: 1 - clamp(brokenTargets / linkTargets * 5),
    note: brokenTargets ? `${brokenTargets} broken among ${linkTargets} internal URLs checked, e.g. ${eg([...new Map(broken.map((b) => [b.to, b])).values()], (b) => path(b.to) + ' (' + b.status + ')')}` : `None among ${linkTargets} internal URLs checked`,
  });

  const noidx = P.filter((p) => p.noindex);
  const smBad = P.filter((p) => p.fromSitemap && (p.noindex || p.redirectHops));
  checks.push({
    name: 'Indexable pages (no stray noindex)', weight: 1.5,
    value: 1 - clamp(noidx.length / n * 3),
    note: `${noidx.length} of ${n} crawled pages are noindex${noidx.length ? ', e.g. ' + eg(noidx, (p) => path(p.url)) : ''}${smBad.length ? `; ${smBad.length} sitemap URLs redirect or are noindex` : ''}`,
  });

  // Orphans only make sense when most of the sitemap was crawled; otherwise "no links in" just means "not crawled".
  const smTotal = crawl.sitemap?.sampled || 0;
  const inl = {};
  for (const p of P) for (const l of new Set(p.internalLinks.map(norm))) if (l !== norm(p.url)) inl[l] = (inl[l] || 0) + 1;
  const smPages = P.filter((p) => p.fromSitemap);
  const orphans = smPages.filter((p, i) => P[0] !== p && !inl[norm(p.url)] && !inl[norm(p.requested || p.url)]);
  const canJudge = smTotal >= 3 && n >= smTotal * 0.6 && smPages.length >= 3;
  checks.push({
    name: 'Orphan pages (no internal links)', weight: 1,
    value: canJudge ? 1 - clamp(orphans.length / smPages.length * 3) : null,
    note: canJudge ? `${orphans.length} of ${smPages.length} sitemap pages have no internal links${orphans.length ? ', e.g. ' + eg(orphans, (p) => path(p.url)) : ''}` : `Only ${n} of ${smTotal} sitemap pages crawled, too few to judge`,
  });

  const shared = (keyOf) => {
    const m = {};
    for (const p of P) { const k = keyOf(p); if (k) (m[k] = m[k] || []).push(p); }
    return new Set(Object.values(m).filter((g) => g.length > 1).flat());
  };
  const dDesc = shared((p) => p.description.toLowerCase());
  const dH1 = shared((p) => (p.h1.length ? p.h1[0].toLowerCase() : ''));
  const dBody = shared((p) => p.bodyHash);
  const dAny = new Set([...dDesc, ...dH1, ...dBody]);
  checks.push({
    name: 'Duplicate descriptions, H1s and content', weight: 1,
    value: 1 - clamp(dAny.size / n),
    note: `${dDesc.size} pages share a meta description, ${dH1.size} share an H1, ${dBody.size} have identical text`,
  });

  const imgSample = crawl.imageSample || [];
  const heavy = imgSample.filter((i) => i.bytes > 300 * 1024);
  const biggest = heavy.sort((a, b) => b.bytes - a.bytes)[0];
  checks.push({
    name: 'Image file size (sampled)', weight: 1,
    value: imgSample.length >= 3 ? 1 - clamp(heavy.length / imgSample.length * 2) : null,
    note: imgSample.length ? `${heavy.length} of ${imgSample.length} sampled images are over 300 KB${biggest ? `, largest ${Math.round(biggest.bytes / 1024)} KB (${path(biggest.url)})` : ''}` : 'Image sizes unavailable',
  });

  // PageSpeed is collected beforehand (lib/scoring/collect.js) and passed in. This module never fetches anything.
  const ps = (ctx.external && ctx.external.pagespeed) || null;
  checks.push({ name: 'PageSpeed mobile performance', weight: 3, value: ps ? ps.perf : null, note: ps ? `Lighthouse ${Math.round(ps.perf * 100)}` : 'PageSpeed unavailable' });

  const r = score(checks);
  r.extra = { pages: n, avgWords: Math.round(avgWords), avgMs: Math.round(avgMs), pagespeed: ps };
  return r;
};
