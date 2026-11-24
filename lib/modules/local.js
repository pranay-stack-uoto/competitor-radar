// Local search readiness: NAP, LocalBusiness schema, maps/reviews signals, location relevance.
// Google Places data (rating, reviews) is collected beforehand (lib/scoring/collect.js) and passed in as ctx.external.places.
const { score, frac, inRange } = require('./util');

module.exports = async function local(crawl, cfg, ctx) {
  const P = crawl.pages;
  const n = P.length || 1;
  const types = new Set(P.flatMap((p) => p.ldTypes));
  const lb = P.flatMap((p) => p.ld).find((x) => [].concat(x['@type']).some((t) => /LocalBusiness|Store|Restaurant|Service|Dentist|Attorney|RealEstateAgent|Contractor|ProfessionalService/.test(t)));
  const locs = (cfg.locations || []).map((l) => l.toLowerCase());
  const mentionsLoc = locs.length ? P.filter((p) => locs.some((l) => p.text.toLowerCase().includes(l))).length : 0;
  const titleLoc = locs.length ? P.filter((p) => locs.some((l) => (p.title + ' ' + p.h1.join(' ')).toLowerCase().includes(l))).length : 0;
  const phoneInText = P.filter((p) => /(\+?\d[\d\s().-]{8,}\d)/.test(p.text)).length;
  const addressInText = P.filter((p) => /\b\d{1,5}\s+\w+(\s\w+){0,3}\s(street|st|road|rd|avenue|ave|lane|ln|nagar|marg|sector|floor|block)\b/i.test(p.text) || /\b\d{5,6}\b/.test(p.text)).length;
  const locPages = P.filter((p) => /location|contact|near-me|branch|store|service-area|city/i.test(p.url)).length;

  const checks = [
    { name: 'LocalBusiness schema', weight: 3, value: lb ? 1 : 0 },
    { name: 'Schema has address + geo/areaServed', weight: 1.5, value: lb ? (lb.address ? 0.6 : 0) + (lb.geo || lb.areaServed ? 0.4 : 0) : 0 },
    { name: 'Phone number published', weight: 1.5, value: frac(phoneInText, n) > 0.5 ? 1 : frac(phoneInText, n) / 0.5, note: `${P.filter((p) => p.tel).length} pages with click-to-call` },
    { name: 'Street address published', weight: 1.5, value: frac(addressInText, n) > 0.3 ? 1 : frac(addressInText, n) / 0.3 },
    { name: 'Google Maps embed', weight: 1, value: P.some((p) => p.mapsEmbed) ? 1 : 0 },
    { name: 'Review / rating markup', weight: 1.5, value: P.flatMap((p) => p.ld).some((x) => x.aggregateRating || [].concat(x['@type']).includes('Review')) ? 1 : 0 },
    { name: 'Location / contact pages', weight: 1, value: locPages ? 1 : 0, note: `${locPages} location-style pages` },
    { name: 'Target locations in content', weight: 2, value: locs.length ? frac(mentionsLoc, n) : null, note: locs.length ? `${mentionsLoc}/${n} pages mention ${cfg.locations.join(', ')}` : 'No locations configured' },
    { name: 'Target locations in titles/H1', weight: 2, value: locs.length ? (frac(titleLoc, n) > 0.3 ? 1 : frac(titleLoc, n) / 0.3) : null },
  ];

  const gp = ctx.external && ctx.external.places;
  if (gp && gp.status === 'ok') {
    checks.push({ name: 'Google rating', weight: 2, value: inRange(gp.rating, 4.5, 5, 2), note: `${gp.rating} stars` });
    checks.push({ name: 'Google review volume', weight: 2, value: Math.min(1, gp.reviews / 200), note: `${gp.reviews} reviews` });
  } else if (!gp || gp.status === 'disabled') {
    checks.push({ name: 'Google Business Profile rating & reviews', weight: 4, value: null, note: 'Disabled: set GOOGLE_PLACES_API_KEY to enable' });
  }
  // status 'none' (configured, but Google returned no match): no check, as before.

  const r = score(checks);
  r.extra = { places: gp && gp.status === 'ok' ? { rating: gp.rating, reviews: gp.reviews } : null };
  return r;
};
