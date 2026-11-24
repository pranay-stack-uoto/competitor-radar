// Everything that needs the network for scoring lives here, so the scoring modules themselves never fetch anything.
// Each collector returns a small, validated object with an explicit status: 'disabled' (not configured), 'none'
// (configured but no usable answer) or 'ok'. The scoring modules turn those into checks.
const { get } = require('../crawl');
const { askClaude } = require('../ai');

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

// Google Places: rating and review count for the business, used by the local score.
async function collectPlaces({ query, key, getFn = get, signal }) {
  if (!key || !query) return { status: 'disabled' };
  const r = await getFn(`https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`, 'CompetitorRadarBot/1.0', undefined, undefined, signal);
  if (!r || !r.ok) return { status: 'none' };
  try {
    const results = JSON.parse(r.body).results;
    const top = Array.isArray(results) ? results[0] : null;
    return top && typeof top === 'object' ? { status: 'ok', rating: num(top.rating), reviews: num(top.user_ratings_total) } : { status: 'none' };
  } catch { return { status: 'none' }; }
}

// Asks an AI assistant a few buyer questions and counts how often the brand is named. Sampled, so it is labelled as such.
async function collectAiProbe({ prompts, brand, host, ask = askClaude, env = process.env, signal }) {
  if (!env.ANTHROPIC_API_KEY || !prompts || !prompts.length || !brand) return { status: 'disabled' };
  let asked = 0, hits = 0;
  for (const prompt of prompts.slice(0, 5)) {
    try {
      const text = (await ask({ prompt, model: env.AI_PROBE_MODEL || 'claude-haiku-5-5', maxTokens: 600, signal })).toLowerCase();
      asked++;
      if (text.includes(brand.toLowerCase()) || text.includes(host)) hits++;
    } catch {}
  }
  return asked ? { status: 'ok', asked, hits } : { status: 'none' };
}

// Google PageSpeed Insights (free API). Not used by the daily pipeline today; kept so it can be switched on without touching the scorer.
async function collectPagespeed({ url, key, getFn = get }) {
  const k = key ? `&key=${key}` : '';
  const r = await getFn(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&category=performance&category=seo${k}`, 'CompetitorRadarBot/1.0', 90000);
  if (!r || !r.ok) return null;
  try {
    const c = JSON.parse(r.body).lighthouseResult.categories;
    return { perf: num(c.performance && c.performance.score, null), seo: num(c.seo && c.seo.score, null) };
  } catch { return null; }
}

// What the daily pipeline collects for one project's site today: Places and the AI probe (both off unless configured).
async function collectExternal({ crawl, locations, aiPrompts, siteName, env = process.env, getFn, ask, signal }) {
  const host = new URL(crawl.origin).hostname.replace(/^www\./, '');
  const [places, aiProbe] = await Promise.all([
    collectPlaces({ query: locations && locations.length ? `${siteName} ${locations[0]}` : '', key: env.GOOGLE_PLACES_API_KEY, getFn, signal }),
    collectAiProbe({ prompts: aiPrompts, brand: siteName, host, ask, env, signal }),
  ]);
  return { places, aiProbe };
}

module.exports = { collectPlaces, collectAiProbe, collectPagespeed, collectExternal };
