// Single home for scoring configuration. Nothing else in the codebase defines weights or the methodology version.
//
// METHODOLOGY_VERSION identifies HOW scores are calculated. Bump it whenever a score could change for the same website:
// a weight, a check added or removed, a threshold, or the crawl sample. Every stored score records the version it was
// calculated under, so scores from different methods stay distinguishable and are never silently compared.
//
//   1  Original method: 4 areas, 15 SEO checks, crawl sample of 15 pages (until 2026-11-05).
//   2  Adds technical SEO checks (redirects, broken links, noindex, orphans, duplicates, image size),
//      stricter Open Graph check, crawl sample of up to 40 pages.
const METHODOLOGY_VERSION = 2;

// Area weights. Changing these changes every score: document the impact and get approval first.
const WEIGHTS = Object.freeze({ seo: 0.3, geo: 0.25, local: 0.2, keywords: 0.25 });
const AREA_ORDER = Object.freeze(['seo', 'geo', 'local', 'keywords']);

// Where each check's number comes from. Shown to users so measured facts are never confused with estimates.
//   measured   read directly from the site (a file exists, a header is present)
//   sampled    measured on the pages we crawled, which are a sample of the site (up to 40 pages)
//   heuristic  an estimate from a rule of thumb (for example a pattern that looks like an address)
//   external   a number from a third party (Google results, Google Places, PageSpeed)
//   ai-sampled the result of asking an AI assistant a few questions
const BASIS_RULES = Object.freeze([
  [/^(XML sitemap|robots\.txt|llms\.txt|AI crawlers allowed|HTTPS)/, 'measured'],
  [/^(Google position|Live Google positions|Google rating|Google review|Google Business Profile|PageSpeed)/, 'external'],
  [/^Mentioned in AI answers/, 'ai-sampled'],
  [/^(Phone number|Street address|Structured, scannable|Article \/ authorship|FAQ \/ Q&A|Coverage:|Target locations|Location \/ contact|Content depth|Substantive content)/, 'heuristic'],
]);
const basisOf = (name) => { for (const [re, b] of BASIS_RULES) if (re.test(name)) return b; return 'sampled'; };

module.exports = { METHODOLOGY_VERSION, WEIGHTS, AREA_ORDER, BASIS_RULES, basisOf };
