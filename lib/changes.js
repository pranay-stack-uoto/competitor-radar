// Compares today's stored scores with the previous day's and lists what moved, for you and for each competitor.
// Pure function: it only reads rows already in the database.
import { AREAS, lessonFor } from './recommendations.js';

const pct = (v) => Math.round(v * 100);
const label = (n) => n.replace(/^Coverage: /, 'Page coverage for ').replace(/^Google position: /, 'Google position for ');

function siteChanges(prev, cur) {
  const out = [];
  const who = { domain: cur.domain, is_me: !!cur.is_me };
  // Scores calculated under different methodologies (lib/scoring/config.js) are not comparable, so score and check
  // movements are only reported between two days that used the same method. Facts about the site itself still are.
  const sameMethod = (prev.method_version || 1) === (cur.method_version || 1);
  const d = Math.round((cur.overall - prev.overall) * 10) / 10;
  if (sameMethod && Math.abs(d) >= 2) out.push({ ...who, kind: d > 0 ? 'gain' : 'loss', impact: Math.abs(d) * 2, text: `Overall score ${d > 0 ? 'rose' : 'fell'} ${Math.abs(d)} points to ${cur.overall}.` });

  const checks = [];
  for (const area of sameMethod ? Object.keys(AREAS) : []) {
    const before = prev.details?.[area]?.checks || [];
    for (const c of cur.details?.[area]?.checks || []) {
      const b = before.find((x) => x.name === c.name);
      if (!b || b.value == null || c.value == null) continue;
      const diff = c.value - b.value;
      if (Math.abs(diff) >= 0.25) checks.push({ area, name: c.name, diff, from: pct(b.value), to: pct(c.value) });
    }
  }
  checks.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  for (const c of checks.slice(0, 4)) {
    const gain = c.diff > 0;
    const lesson = !cur.is_me && gain ? lessonFor(c.name) : null;
    out.push({ ...who, kind: gain ? 'gain' : 'loss', area: c.area, impact: Math.abs(c.diff) * 10, text: `${label(c.name)} ${gain ? 'improved' : 'dropped'} from ${c.from}% to ${c.to}% (${AREAS[c.area].label}).`, lesson: lesson ? `${lesson.title}. ${lesson.why}` : undefined });
  }

  // Profile-level facts (only when both days stored a detailed profile)
  const a = prev.details?.profile, b = cur.details?.profile;
  if (a && b) {
    const newSchema = b.schemaTypes.filter((t) => !a.schemaTypes.includes(t));
    if (newSchema.length) out.push({ ...who, kind: 'gain', impact: 4, text: `Added structured data: ${newSchema.slice(0, 4).join(', ')}.`, lesson: cur.is_me ? undefined : 'Structured data helps Google and AI assistants understand the business. Add the types that fit your pages.' });
    if (!a.llmsTxt && b.llmsTxt) out.push({ ...who, kind: 'gain', impact: 3, text: 'Published an llms.txt file for AI tools.', lesson: cur.is_me ? undefined : 'Publish an llms.txt file with a short description of the business and links to the key pages.' });
    if (b.faqPages - a.faqPages >= 2) out.push({ ...who, kind: 'gain', impact: 3, text: `Added question-and-answer content: ${a.faqPages} to ${b.faqPages} pages.`, lesson: cur.is_me ? undefined : 'Add FAQ sections to your service pages.' });
    if (b.sitemapUrls - a.sitemapUrls >= 5) out.push({ ...who, kind: 'gain', impact: 3, text: `Published new pages: sitemap grew from ${a.sitemapUrls} to ${b.sitemapUrls} URLs.`, lesson: cur.is_me ? undefined : 'They are publishing more content. Look at their newest pages for topics you do not cover.' });
    if (a.sitemapUrls - b.sitemapUrls >= 5) out.push({ ...who, kind: 'loss', impact: 3, text: `Sitemap shrank from ${a.sitemapUrls} to ${b.sitemapUrls} URLs.` });
    if (b.avgWords > a.avgWords * 1.25 && b.avgWords - a.avgWords >= 80) out.push({ ...who, kind: 'gain', impact: 3, text: `Pages got deeper: ${a.avgWords} to ${b.avgWords} words on average.`, lesson: cur.is_me ? undefined : 'Deeper pages tend to win the same searches. Expand your key pages.' });
  }
  return out;
}

// prevRows / curRows: score rows (domain, is_me, overall, rank, details). Returns at most 14 changes, most important first.
export function buildChanges(prevRows, curRows) {
  if (!prevRows?.length) return [];
  const prev = new Map(prevRows.map((r) => [r.domain, r]));
  const out = [];
  for (const cur of curRows) {
    const p = prev.get(cur.domain);
    if (p) out.push(...siteChanges(p, cur));
  }
  // Rank movement around you
  const me = curRows.find((r) => r.is_me), meBefore = me && prev.get(me.domain);
  if (me && meBefore?.rank && me.rank && meBefore.rank !== me.rank) {
    const up = me.rank < meBefore.rank;
    out.push({ domain: me.domain, is_me: true, kind: up ? 'gain' : 'loss', impact: 20, text: `You moved ${up ? 'up' : 'down'} from #${meBefore.rank} to #${me.rank}.` });
  }
  if (me && meBefore?.rank) for (const cur of curRows) {
    const p = prev.get(cur.domain);
    if (!cur.is_me && p?.rank && cur.rank && p.rank > meBefore.rank && cur.rank < me.rank) out.push({ domain: cur.domain, is_me: false, kind: 'loss', impact: 15, text: `${cur.domain} overtook you and is now #${cur.rank}.` });
  }
  if (me && meBefore && (meBefore.method_version || 1) !== (me.method_version || 1)) {
    out.push({ domain: me.domain, is_me: true, kind: 'info', impact: 25, text: `Scoring method updated (version ${meBefore.method_version || 1} to ${me.method_version || 1}). Score changes across this date are not directly comparable.` });
  }
  const added = curRows.filter((r) => !prev.has(r.domain) && !r.is_me).map((r) => r.domain);
  if (added.length) out.push({ domain: added[0], is_me: false, kind: 'info', impact: 1, text: `Newly tracked: ${added.slice(0, 5).join(', ')}.` });
  return out.sort((a, b) => b.impact - a.impact).slice(0, 14).map(({ impact, ...rest }) => rest);
}
