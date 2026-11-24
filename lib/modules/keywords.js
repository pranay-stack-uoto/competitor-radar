// Keyword listing: how well the site targets each tracked keyword (title/H1/H2/body coverage),
// plus real Google positions when ctx.serpRanks is supplied by the discovery step.
const { score } = require('./util');

const STOP = new Set(['the', 'and', 'for', 'near', 'best', 'top', 'with', 'from', 'in', 'of']);

module.exports = async function keywords(crawl, cfg, ctx) {
  const kws = cfg.keywords || [];
  if (!kws.length) return { score: 0, checks: [], note: 'No keywords configured' };
  const P = crawl.pages;
  const domain = new URL(crawl.origin).hostname.replace(/^www\./, '');
  const rows = [];
  const checks = [];
  for (const kw of kws) {
    const k = kw.toLowerCase();
    // A field matches if it has the exact phrase, or every significant word of the keyword
    // (so "interior contractor in Vadodara" matches "Vadodara interior contractors").
    const toks = k.split(/\W+/).filter((t) => t.length > 2 && !STOP.has(t)).map((t) => t.replace(/(es|s)$/, ''));
    const hit = (s) => { s = s.toLowerCase(); return s.includes(k) || (toks.length > 0 && toks.every((t) => s.includes(t))); };
    const inTitle = P.filter((p) => hit(p.title));
    const inH1 = P.filter((p) => hit(p.h1.join(' ')));
    const inH2 = P.filter((p) => hit(p.h2.join(' ')));
    const inBody = P.filter((p) => hit(p.text));
    const inUrl = P.filter((p) => p.url.toLowerCase().includes(k.replace(/\s+/g, '-')));
    // Weighted coverage 0..1: dedicated page (title+H1) matters most
    const dedicated = inTitle.length && inH1.length ? 1 : inTitle.length || inH1.length ? 0.6 : 0;
    const cov = Math.min(1, dedicated * 0.5 + Math.min(1, inH2.length / 2) * 0.15 + Math.min(1, inBody.length / 5) * 0.25 + (inUrl.length ? 0.1 : 0));
    // Best Google position across your locations from today's discovery run (0 = not in results).
    let rank = null;
    if (ctx.serpRanks) {
      const pos = Object.entries(ctx.serpRanks).filter(([key]) => key.startsWith(kw + '|')).map(([, v]) => v).filter(Boolean);
      rank = pos.length ? Math.min(...pos) : 0;
    }
    rows.push({ keyword: kw, coverage: Math.round(cov * 100), title: inTitle.length, h1: inH1.length, h2: inH2.length, body: inBody.length, bestPage: (inTitle[0] || inH1[0] || inBody[0] || {}).url || null, rank });
    checks.push({ name: `Coverage: "${kw}"`, weight: 1, value: cov, note: `title ${inTitle.length}, H1 ${inH1.length}, body ${inBody.length} pages` });
    if (rank !== null) {
      // position 1 -> 1.0, 10 -> 0.55, 50 -> 0.1, absent -> 0
      checks.push({ name: `Google position: "${kw}"`, weight: 2, value: rank === 0 ? 0 : Math.max(0.1, 1 - (rank - 1) / 20 * 0.9), note: rank ? `#${rank}` : 'Not in top 20' });
    }
  }
  if (!ctx.serpRanks) checks.push({ name: 'Live Google positions', weight: 3, value: null, note: 'Disabled: no search data for this run' });
  const r = score(checks);
  r.extra = { rows };
  return r;
};
