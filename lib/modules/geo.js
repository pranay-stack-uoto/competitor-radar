// GEO / AI visibility: how ready is the site to be read and cited by AI answer engines,
// plus an optional live probe whose answers are collected beforehand (lib/scoring/collect.js) and passed in as ctx.external.aiProbe.
const { agentBlocked } = require('../robots');
const { score, frac, inRange } = require('./util');

const AI_BOTS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot'];

module.exports = async function geo(crawl, cfg, ctx) {
  const P = crawl.pages;
  const n = P.length || 1;
  const blocked = AI_BOTS.filter((b) => agentBlocked(crawl.robots, b));
  const allTypes = new Set(P.flatMap((p) => p.ldTypes));
  const has = (...t) => t.some((x) => allTypes.has(x));
  const sameAs = new Set(P.flatMap((p) => p.sameAs));
  const questionPages = P.filter((p) => p.hasQuestions).length;
  const listy = P.filter((p) => p.h2.length >= 3).length;

  const checks = [
    { name: 'AI crawlers allowed', weight: 3, value: 1 - frac(blocked.length, AI_BOTS.length), note: blocked.length ? `Blocks: ${blocked.join(', ')}` : 'No AI bot is blocked' },
    { name: 'llms.txt published', weight: 1, value: crawl.llmsTxt ? 1 : 0 },
    { name: 'Organization schema', weight: 2, value: has('Organization', 'LocalBusiness', 'Corporation') ? 1 : 0 },
    { name: 'Entity links (sameAs profiles)', weight: 1.5, value: inRange(sameAs.size, 3, 12, 3), note: `${sameAs.size} sameAs links` },
    { name: 'FAQ / Q&A content', weight: 2, value: frac(questionPages, n) > 0.15 ? 1 : frac(questionPages, n) / 0.15, note: `${questionPages} pages with question headings or FAQ schema` },
    { name: 'FAQPage / HowTo schema', weight: 1, value: has('FAQPage', 'HowTo') ? 1 : 0 },
    { name: 'Article / authorship signals', weight: 1.5, value: frac(P.filter((p) => p.hasAuthor && p.hasDate).length, n) > 0.2 ? 1 : frac(P.filter((p) => p.hasAuthor && p.hasDate).length, n) / 0.2 },
    { name: 'Structured, scannable pages', weight: 1.5, value: frac(listy, n) },
    { name: 'Substantive content (>400 words)', weight: 1, value: frac(P.filter((p) => p.words > 400).length, n) },
  ];

  // Live probe: does an AI answer mention this brand? Collected beforehand; this module never calls an AI service.
  const probe = ctx.external && ctx.external.aiProbe;
  if (probe && probe.status === 'ok') checks.push({ name: 'Mentioned in AI answers (live probe)', weight: 4, value: probe.hits / probe.asked, note: `${probe.hits}/${probe.asked} prompts mention the brand` });
  else if (!probe || probe.status === 'disabled') checks.push({ name: 'Mentioned in AI answers (live probe)', weight: 4, value: null, note: 'Disabled: set ANTHROPIC_API_KEY to enable' });
  // status 'none' (asked, but no usable answer): no check, as before.

  const r = score(checks);
  r.extra = { blockedBots: blocked, llmsTxt: crawl.llmsTxt, probe: probe && probe.status === 'ok' ? { asked: probe.asked, hits: probe.hits } : null };
  return r;
};
