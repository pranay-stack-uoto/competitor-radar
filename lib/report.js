// Pure analysis helpers for the improvement report. They only read data already stored from crawls.
import { AREAS, EFFORT } from './recommendations';

const NOISE = new Set('the and for with from that this your our are was were has have you who what why how best top near new all any can will get more most one two into out about their they them its not but also than then per via of in on to a an at by or as is it we us home page contact services service about'.split(' '));

export function competitorPlaybook(me, others, serp, domain, limit = 3) {
  const mineP = me?.details?.profile;
  const myKw = new Set(serp.filter((r) => r.domain === domain && r.position <= 10).map((r) => r.keyword));
  return [...others].sort((a, b) => b.overall - a.overall).slice(0, limit).map((o) => {
    const p = o.details?.profile;
    const lead = Object.keys(AREAS).filter((k) => o[k] - me[k] >= 5).map((k) => ({ area: k, theirs: Math.round(o[k]), mine: Math.round(me[k]) }));
    const better = [];
    for (const area of Object.keys(AREAS)) {
      const theirChecks = o.details?.[area]?.checks || [];
      for (const c of me.details?.[area]?.checks || []) {
        const t = theirChecks.find((x) => x.name === c.name);
        if (t && t.value != null && c.value != null && t.value - c.value >= 0.3) better.push({ area, name: c.name, theirs: Math.round(t.value * 100), mine: Math.round(c.value * 100), note: t.note || '' });
      }
    }
    better.sort((a, b) => (b.theirs - b.mine) - (a.theirs - a.mine));
    const owns = {};
    for (const r of serp) if (r.domain === o.domain && r.position <= 10 && !myKw.has(r.keyword)) owns[r.keyword] = Math.min(owns[r.keyword] ?? 99, r.position);
    const keywordsTheyOwn = Object.entries(owns).sort((a, b) => a[1] - b[1]).slice(0, 6).map(([keyword, position]) => ({ keyword, position }));
    const tips = [];
    if (p && mineP) {
      if (p.avgWords > mineP.avgWords * 1.2) tips.push(`Their pages average ${p.avgWords} words against your ${mineP.avgWords}. Deeper pages are one reason they outrank you on shared searches.`);
      const theirSchema = p.schemaTypes.filter((t) => !mineP.schemaTypes.includes(t));
      if (theirSchema.length) tips.push(`They use ${theirSchema.slice(0, 5).join(', ')} structured data that you do not. Add the ones that fit your pages.`);
      if (p.faqPages > mineP.faqPages) tips.push(`${p.faqPages} of their pages answer customer questions, against ${mineP.faqPages} of yours. Add FAQ sections to more service pages.`);
      if (p.llmsTxt && !mineP.llmsTxt) tips.push('They publish an llms.txt file so AI tools can read their site. Add one.');
      if (p.sameAs.length > mineP.sameAs.length) tips.push(`They link ${p.sameAs.length} official profiles in their markup against your ${mineP.sameAs.length}. Connect more of your profiles.`);
      if (p.sitemapUrls > mineP.sitemapUrls * 1.3) tips.push(`Their sitemap lists ${p.sitemapUrls} pages against your ${mineP.sitemapUrls}. They publish more content.`);
    }
    for (const b of better.slice(0, 3)) tips.push(`${b.name}: they score ${b.theirs} and you score ${b.mine}.`);
    for (const k of keywordsTheyOwn.slice(0, 3)) tips.push(`They rank #${k.position} for "${k.keyword}" and you do not appear in the top 10. Study their page for it and build a stronger one.`);
    const topPages = (p?.pages || []).filter((x) => x.words > 150).sort((a, b) => b.inlinks - a.inlinks || b.words - a.words).slice(0, 6).map((x) => ({ title: x.title, url: x.url, words: x.words }));
    return { domain: o.domain, overall: o.overall, scores: Object.fromEntries(Object.keys(AREAS).map((k) => [k, Math.round(o[k])])), lead, better: better.slice(0, 6), keywordsTheyOwn, tips, topPages, facts: p ? { pages: p.pagesCrawled, avgWords: p.avgWords, faqPages: p.faqPages, schemaTypes: p.schemaTypes, sameAs: p.sameAs.length, llmsTxt: p.llmsTxt, sitemapUrls: p.sitemapUrls } : null, hasProfile: !!p };
  });
}

function grams(page, brand) {
  const text = [page.title, ...(page.h1 || []), ...(page.h2 || [])].join(' . ').toLowerCase();
  const out = new Set();
  for (const sent of text.split(/[.|\-–:,;\n]+/)) {
    const w = sent.split(/[^a-z0-9&]+/).filter((t) => t && !NOISE.has(t) && !brand.has(t) && t.length > 2);
    for (let i = 0; i + 2 <= w.length; i++) out.add(w.slice(i, i + 2).join(' '));
  }
  return out;
}

// Topics that at least two competitors build pages around but your site never mentions in a title or heading.
export function contentGaps(me, others, domain) {
  const mineP = me?.details?.profile;
  if (!mineP) return [];
  const brand = new Set(domain.split('.')[0].split(/[^a-z0-9]+/));
  const mine = new Set();
  for (const pg of mineP.pages) for (const g of grams(pg, brand)) mine.add(g);
  const count = new Map();
  for (const o of others) {
    const p = o.details?.profile; if (!p) continue;
    const seen = new Map();
    for (const pg of p.pages) for (const g of grams(pg, new Set([o.domain.split('.')[0]]))) if (!seen.has(g)) seen.set(g, pg);
    for (const [g, pg] of seen) { const c = count.get(g) || { sites: 0, example: pg, names: [] }; c.sites += 1; c.names.push(o.domain); count.set(g, c); }
  }
  return [...count.entries()].filter(([g, c]) => c.sites >= 2 && !mine.has(g)).sort((a, b) => b[1].sites - a[1].sites).slice(0, 12)
    .map(([phrase, c]) => ({ phrase, sites: c.sites, competitors: c.names.slice(0, 3), example: { title: c.example.title, url: c.example.url } }));
}

export function techAudit(profile) {
  if (!profile) return null;
  const P = profile.pages;
  const rule = (id, label, fn) => { const list = P.filter(fn); return { id, label, count: list.length, examples: list.slice(0, 5).map((p) => p.url) }; };
  const issues = [
    rule('no-title', 'Pages with no title', (p) => !p.title),
    rule('long-title', 'Titles over 65 characters', (p) => p.title.length > 65),
    rule('short-title', 'Titles under 30 characters', (p) => p.title && p.title.length < 30),
    rule('no-desc', 'Pages with no meta description', (p) => !p.descLen),
    rule('bad-desc', 'Meta descriptions outside 70 to 160 characters', (p) => p.descLen && (p.descLen < 70 || p.descLen > 160)),
    rule('no-h1', 'Pages with no H1', (p) => !p.h1.length),
    rule('multi-h1', 'Pages with more than one H1', (p) => p.h1.length > 1),
    rule('thin', 'Thin pages under 300 words', (p) => p.words < 300),
    rule('no-canon', 'Pages with no canonical tag', (p) => !p.canonical),
    rule('noindex', 'Pages marked noindex', (p) => p.noindex),
    rule('slow', 'Slow responses over 1.5 seconds', (p) => p.ms > 1500),
    rule('alt', 'Pages with images missing alt text', (p) => p.images > p.alt),
    rule('no-schema', 'Pages with no structured data', (p) => !p.schema.length),
  ].filter((i) => i.count > 0);
  const titles = {};
  for (const p of P) if (p.title) (titles[p.title] = titles[p.title] || []).push(p.url);
  const dup = Object.entries(titles).filter(([, u]) => u.length > 1).map(([title, urls]) => ({ title, urls }));
  return { pages: P, issues, duplicateTitles: dup, totals: { pages: profile.pagesCrawled, sitemap: profile.sitemapUrls, avgWords: profile.avgWords, schemaTypes: profile.schemaTypes, faqPages: profile.faqPages, llmsTxt: profile.llmsTxt, robotsTxt: profile.robotsTxt } };
}

// Attach the exact pages each action applies to, so advice is specific to this site and not generic.
export function attachTargets(actions, profile, keywordRows, locations = []) {
  const P = profile?.pages || [];
  const locRe = locations.length ? new RegExp(locations.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
  const by = {
    'Title tags': (p) => !p.title || p.title.length < 30 || p.title.length > 65,
    'Meta descriptions': (p) => !p.descLen || p.descLen < 70 || p.descLen > 160,
    'Exactly one H1': (p) => p.h1.length !== 1,
    'Subheadings': (p) => (p.h2 || []).length < 2,
    'Content depth': (p) => p.words < 600,
    'Substantive content': (p) => p.words < 400,
    'Image alt': (p) => p.images > p.alt,
    'Canonical': (p) => !p.canonical,
    'Target locations in titles': (p) => locRe && !locRe.test(p.title + ' ' + p.h1.join(' ')),
    'Structured, scannable': (p) => (p.h2 || []).length < 3,
    'FAQ': (p) => !p.faq && p.words > 200,
  };
  return actions.map((a) => {
    let targets = [];
    const key = Object.keys(by).find((k) => a.check.startsWith(k));
    if (key && P.length) targets = P.filter(by[key]).slice(0, 12).map((p) => ({ url: p.url, title: p.title, description: p.description, h1: p.h1, words: p.words, h2: (p.h2 || []).length }));
    else if (/^Coverage:|^Google position:/.test(a.check)) {
      const kw = (a.check.match(/"(.+)"/) || [])[1];
      const r = (keywordRows || []).find((x) => x.keyword === kw);
      if (r) targets = [{ url: r.bestPage || null, keyword: kw, coverage: r.coverage, note: r.bestPage ? 'Best-matching page today. Strengthen it or build a dedicated one.' : 'No page targets this phrase yet. Create one.' }];
    }
    return { ...a, targets };
  });
}

// One Markdown file a person can paste into Claude, with enough exact detail to make the changes on the site.
export function buildBrief({ project, report, me, actions, playbook, gaps, audit, keywordRows, ai, gscIns, gscSnap }) {
  const L = [];
  const pct = (v) => Math.round(v);
  L.push(`# Website improvement brief: ${project.domain}`, '');
  L.push('## Your job',
    'You are improving this website using the findings below. Work through the tasks in priority order. The findings are platform-neutral: they describe what to change and on which pages, not how any one system does it.',
    '',
    '### Step 1: find out how you can reach the site',
    'Check what you have access to and pick the matching mode:',
    '- **Direct access.** You can edit the site through a CMS or site-builder API or admin (for example WordPress, Shopify, Wix, Webflow, Squarespace, Ghost or a headless CMS), through a code repository (static site, Next.js or similar), or through a browser session. Make the changes yourself.',
    '- **No access.** Produce a change sheet instead: for every page, the field to change (title, meta description, H1, body section, image alt text, schema markup, robots.txt, sitemap, llms.txt), the current value and the exact new value, ready to copy and paste, plus the steps to apply it in the platform the site uses.',
    '- Either way, identify the platform from the page source or ask the owner, and say which mode you are in before you start.',
    '',
    '### Step 2: ground rules',
    '- Work in priority order. For each task, open the affected pages, make or draft the change, and record what changed.',
    '- Ask for confirmation before publishing anything that alters visible copy, URLs or navigation. Prefer drafts or a staging copy when available.',
    '- Keep the brand voice. Never invent facts, prices, awards, certifications or client names. Use only information visible on the site or supplied by the owner.',
    '- Write for people first. Use keywords naturally, never stuff them.',
    '- Do not change URLs of ranking pages without adding a 301 redirect.',
    '- Structured data goes in as JSON-LD and must match visible content.',
    '',
    '### Step 3: report back',
    'At the end, return a changelog: page, what changed, old value, new value, and anything skipped with the reason.',
    '');
  L.push('## Business', `- Site: https://${project.domain}`, `- What it does: ${project.summary || 'n/a'}`, `- Places served: ${project.locations.join(', ')}`, `- Target keywords: ${project.keywords.join('; ')}`, '');
  L.push(`## Scores (report date ${report.day})`, `| Area | You | Best competitor |`, '|---|---|---|');
  for (const [k, a] of Object.entries(AREAS)) L.push(`| ${a.label} | ${pct(me[k])} | ${pct(Math.max(...playbook.map((p) => p.scores[k]), 0))} |`);
  L.push(`Overall: ${me.overall}/100, rank ${report.summary.myRank} of ${report.summary.total}.`, '');
  L.push('## Prioritised tasks');
  actions.slice(0, 25).forEach((a, i) => {
    L.push(`### ${i + 1}. ${a.title}`, `- Area: ${AREAS[a.area].label}`, `- Effort: ${EFFORT[a.effort]}`, `- Estimated gain: +${a.gain} overall points`, `- Why: ${a.why}`, '- Steps:');
    a.how.forEach((h) => L.push(`  - ${h}`));
    if (a.best != null) L.push(`- Benchmark: you ${a.current}, best competitor ${a.best}`);
    if (a.targets?.length) {
      L.push('- Pages to change:');
      a.targets.forEach((t) => L.push(t.keyword ? `  - "${t.keyword}": ${t.url || '(no page yet)'}. ${t.note}` : `  - ${t.url}\n    - title (${(t.title || '').length}): ${t.title || '(none)'}\n    - description: ${t.description || '(none)'}\n    - H1: ${(t.h1 || []).join(' | ') || '(none)'} · words: ${t.words} · subheadings: ${t.h2}`));
    }
    L.push('');
  });
  if (audit?.issues.length) {
    L.push('## Page-level fixes (exact pages)');
    for (const it of audit.issues) {
      L.push(`### ${it.label} (${it.count} pages)`);
      const pgs = audit.pages.filter((p) => it.examples.includes(p.url));
      pgs.forEach((p) => L.push(`- ${p.url}\n  - title (${p.title.length}): ${p.title || '(none)'}\n  - description (${p.descLen}): ${p.description || '(none)'}\n  - H1: ${p.h1.join(' | ') || '(none)'}\n  - words: ${p.words}`));
      L.push('');
    }
  }
  if (keywordRows?.length) {
    L.push('## Keyword targets', '| Keyword | Page coverage | Your Google position | Ranking above you |', '|---|---|---|---|');
    keywordRows.forEach((r) => L.push(`| ${r.keyword} | ${r.coverage}% | ${r.mineBest ? '#' + r.mineBest : 'not in top 10'} | ${r.top.map(([d, p]) => `${d} (#${p})`).join(', ') || 'none'} |`));
    L.push('');
  }
  if (gscSnap && gscIns) {
    const row = (r) => `| ${r.query} | ${r.position} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(1)}% |`;
    L.push('## Real Google data (Search Console, last 28 days)', `- ${gscSnap.totals.clicks} clicks, ${gscSnap.totals.impressions} impressions, average position ${gscSnap.totals.position}, click rate ${(gscSnap.totals.ctr * 100).toFixed(1)}%.`, '');
    if (gscIns.strike.length) L.push('### Close to page one (positions 8 to 20): strengthen the page that matches each search', '| Search | Position | Impressions | Clicks | Click rate |', '|---|---|---|---|---|', ...gscIns.strike.map(row), '');
    if (gscIns.lowCtr.length) L.push('### Ranking in the top 10 but rarely clicked: rewrite the title and meta description', '| Search | Position | Impressions | Clicks | Click rate |', '|---|---|---|---|---|', ...gscIns.lowCtr.map(row), '');
    if (gscIns.untracked.length) L.push('### Searches that already find the site: make sure a page deliberately targets each', ...gscIns.untracked.map((r) => `- "${r.query}" (position ${r.position}, ${r.impressions} impressions)`), '');
  }
  if (gaps?.length) { L.push('## Content gaps (topics competitors cover that you do not)'); gaps.forEach((g) => L.push(`- "${g.phrase}": covered by ${g.competitors.join(', ')}. Example: ${g.example.title} (${g.example.url})`)); L.push(''); }
  L.push('## What the top competitors do');
  playbook.forEach((c) => { L.push(`### ${c.domain} (overall ${c.overall})`); c.tips.forEach((t) => L.push(`- ${t}`)); if (c.topPages.length) L.push(`- Their key pages: ${c.topPages.map((p) => p.title).join(' | ')}`); L.push(''); });
  if (ai) {
    L.push('## AI recommendations');
    if (ai.summary) L.push(ai.summary, '');
    if (ai.rewrites?.length) { L.push('### Suggested title and description rewrites'); ai.rewrites.forEach((r) => L.push(`- ${r.url}\n  - new title: ${r.title}\n  - new description: ${r.description}`)); L.push(''); }
    if (ai.contentIdeas?.length) { L.push('### New content to publish'); ai.contentIdeas.forEach((c) => L.push(`- **${c.title}** (targets "${c.keyword}")\n  - ${c.outline}`)); L.push(''); }
  }
  L.push('## Definition of done', '- Every task above is completed or marked skipped with a reason.', '- No page has a missing or duplicate title, description or H1.', '- Re-run the Competitor Radar report afterwards and compare scores.');
  return L.join('\n');
}
