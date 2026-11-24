// The scoring engine. Given a crawl and a project's settings it returns scores. It does NO network or database work:
// everything it needs is passed in, so it can be tested, replayed and run from cached data.
//
//   collect (lib/scoring/collect.js)  ->  score (this file)  ->  recommend (lib/recommendations.js, reads stored rows)
const seo = require('../modules/seo');
const geo = require('../modules/geo');
const local = require('../modules/local');
const keywords = require('../modules/keywords');
const { WEIGHTS, AREA_ORDER, METHODOLOGY_VERSION, basisOf } = require('./config');

// Each module is independent: it reads the crawl and returns { score, checks }. One failing never affects the others.
const MODULES = { seo, geo, local, keywords };

function combine(row, weights = WEIGHTS) {
  const wsum = AREA_ORDER.reduce((s, k) => s + weights[k], 0);
  return Math.round((AREA_ORDER.reduce((s, k) => s + (row[k] || 0) * weights[k], 0) / wsum) * 10) / 10;
}

// settings: { keywords, locations }. ctx: { site: { name }, serpRanks, external: { places, aiProbe, pagespeed } }.
async function scoreSite(crawl, settings, ctx) {
  const cfg = { keywords: settings.keywords || [], locations: settings.locations || [] };
  const row = {}, details = {};
  for (const [name, mod] of Object.entries(MODULES)) {
    try {
      const r = await mod(crawl, cfg, ctx);
      for (const c of r.checks || []) c.basis = basisOf(c.name);
      row[name] = r.score; details[name] = r;
    } catch (e) {
      row[name] = 0; details[name] = { score: 0, checks: [], note: `Module error: ${String((e && e.message) || e).slice(0, 200)}` };
    }
  }
  return { row, overall: combine(row), details, methodVersion: METHODOLOGY_VERSION, weights: { ...WEIGHTS } };
}

module.exports = { scoreSite, combine, MODULES };
