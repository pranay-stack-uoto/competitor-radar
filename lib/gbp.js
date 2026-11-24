// Google Business Profile / Google Maps tracking. PURE: works on the rows stored in maps_results (migration 0025).
// Everything a business shows on its Maps listing that we can read from Google's results: rating, number of reviews, category, phone, and
// where it appears in the Maps list for your keywords in your cities. History (the previous check) gives review growth.
// Not available from this data, so never claimed: reply rate, review text and topics, photo counts, posts.

const median = (a) => { const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

// One listing per business: matched by website domain, else by the name that was looked up. Highest review count wins (the freshest, fullest row).
function listings(rows) {
  const by = new Map();
  const pick = (key, r) => { const cur = by.get(key); if (!cur || (r.rating_count || 0) > (cur.rating_count || 0)) by.set(key, r); };
  for (const r of rows) if (r.domain) pick('d:' + r.domain, r);
  for (const r of rows) if (r.keyword === '__brand__' && r.position === 1 && !r.domain) pick('n:' + norm(r.location), r); // top hit of a name look-up that has no website
  return by;
}

// For the brand look-ups, which listing belongs to which site: the first result whose website is the site, else whose name resembles the one looked up.
function brandListing(rows, domain, name) {
  const mine = rows.filter((r) => r.keyword === '__brand__');
  const byDomain = mine.filter((r) => r.domain && r.domain.replace(/^www\./, '') === domain);
  if (byDomain.length) return byDomain.sort((a, b) => (b.rating_count || 0) - (a.rating_count || 0))[0];
  const n = norm(name);
  return mine.find((r) => r.position === 1 && n && norm(r.location) === n && norm(r.name).includes(n.slice(0, 6))) || null;
}

function visibility(rows, domain) {
  const maps = rows.filter((r) => r.keyword !== '__brand__');
  const pairs = new Set(maps.map((r) => `${r.keyword}|${r.location}`));
  const best = new Map();
  for (const r of maps) if (r.domain.replace(/^www\./, '') === domain) { const k = `${r.keyword}|${r.location}`; if (!(best.get(k) <= r.position)) best.set(k, r.position); }
  const pos = [...best.values()];
  return { pairs: pairs.size, top3: pos.filter((p) => p <= 3).length, listed: pos.length, avgPosition: pos.length ? round1(pos.reduce((a, b) => a + b, 0) / pos.length) : null };
}

// domains: [{ domain, name, isMe }]. rows / prevRows: maps_results rows for the latest and the previous check; days: their dates (for growth per week).
function gbpSummary(rows, prevRows, domains, days = {}) {
  if (!rows || !rows.length) return null;
  const gapDays = days.now && days.prev ? Math.max(1, Math.round((Date.parse(days.now) - Date.parse(days.prev)) / 86400000)) : null;
  const out = domains.map((d) => {
    const own = (r) => (r.domain || '').replace(/^www\./, '') === d.domain;
    const l = brandListing(rows, d.domain, d.name) || rows.filter(own).sort((a, b) => (b.rating_count || 0) - (a.rating_count || 0))[0] || null;
    const lp = prevRows && prevRows.length ? (brandListing(prevRows, d.domain, d.name) || prevRows.filter(own).sort((a, b) => (b.rating_count || 0) - (a.rating_count || 0))[0] || null) : null;
    const growth = l && lp && l.rating_count != null && lp.rating_count != null ? l.rating_count - lp.rating_count : null;
    return { domain: d.domain, isMe: !!d.isMe, found: !!l, name: l ? l.name : null, rating: l ? l.rating : null, reviews: l ? l.rating_count : null, category: l ? l.category : null, phone: l ? l.phone : null, reviewGrowth: growth, reviewsPerWeek: growth !== null && gapDays ? round1((growth / gapDays) * 7) : null, ...visibility(rows, d.domain) };
  });
  const me = out.find((x) => x.isMe) || null, others = out.filter((x) => !x.isMe && x.found);
  const top = [...others].sort((a, b) => (b.reviews || 0) - (a.reviews || 0)).slice(0, 3);
  const market = { sites: others.length, topReviews: median(top.map((x) => x.reviews)), marketReviews: median(others.map((x) => x.reviews)), marketRating: round1(median(others.map((x) => x.rating))), topRating: round1(median(top.map((x) => x.rating))), marketPerWeek: round1(median(others.map((x) => x.reviewsPerWeek))) };
  return { day: days.now || null, prevDay: days.prev || null, me, others: out.filter((x) => !x.isMe), market, findings: me ? gbpFindings(me, market) : [] };
}

function gbpFindings(me, m) {
  const f = [];
  const ev = (label, yours, top, market) => ({ label, yours, topPerformers: top, market, sites: m.sites, topSites: Math.min(3, m.sites) });
  if (!me.found) {
    f.push({ id: 'gbp-missing', area: 'local', severity: 'high', title: 'We could not find your Google Business Profile', why: 'Searching Google Maps for your business name and city returned no listing with your website. Without a verified profile you cannot appear in the local map results.', evidence: [], trend: null,
      fix: 'Create or claim your profile at business.google.com, verify it, add your website address exactly as it appears in your site\'s URL, choose the right primary category, and add your service areas.' });
    return f;
  }
  if (m.sites && m.topReviews != null && me.reviews != null && me.reviews < m.topReviews * 0.6) f.push({ id: 'gbp-reviews', area: 'local', severity: me.reviews < m.topReviews * 0.25 ? 'high' : 'medium', title: 'Fewer Google reviews than the leaders',
    why: `You have ${me.reviews} reviews; the three best-reviewed competitors have a median of ${m.topReviews}. Review count and recency are among the strongest local ranking signals and what customers compare first.`, evidence: [ev('Google reviews', String(me.reviews), String(m.topReviews), String(m.marketReviews))], trend: null,
    fix: 'Ask every finished customer for a review the same week, with your Google review link sent by WhatsApp or SMS. Aim for a steady stream (a few a week) rather than a burst, and reply to every review.' });
  if (m.sites && m.topRating != null && me.rating != null && me.rating < m.topRating - 0.2) f.push({ id: 'gbp-rating', area: 'local', severity: 'medium', title: 'Your Google rating is below the leaders\'',
    why: `Your rating is ${me.rating}; the leaders\' median is ${m.topRating}.`, evidence: [ev('Google rating', String(me.rating), String(m.topRating), String(m.marketRating))], trend: null, fix: 'Read the lower-rated reviews, fix the recurring problem, reply politely and specifically, and ask satisfied customers to review so recent good experiences outweigh old ones.' });
  if (me.reviewsPerWeek != null && m.marketPerWeek != null && me.reviewsPerWeek < m.marketPerWeek * 0.7 && m.marketPerWeek > 0) f.push({ id: 'gbp-velocity', area: 'local', severity: 'low', title: 'Your review growth is slower than the market\'s',
    why: `You gained about ${me.reviewsPerWeek} reviews a week since the previous check; the market median is ${m.marketPerWeek}.`, evidence: [ev('New reviews per week', String(me.reviewsPerWeek), '', String(m.marketPerWeek))], trend: null, fix: 'Make asking for a review part of your handover checklist for every project.' });
  if (me.pairs > 0 && me.top3 < me.pairs * 0.34) f.push({ id: 'gbp-maps-visibility', area: 'local', severity: me.listed === 0 ? 'high' : 'medium', title: 'You rarely appear in the top 3 of the Google Maps results',
    why: `For ${me.pairs} tracked searches (keyword and city), your listing is in the Maps top 3 for ${me.top3} and appears at all for ${me.listed}.`, evidence: [], trend: null,
    fix: 'Check your primary and secondary categories match what people search, add services and service areas, put the main keyword and city naturally in your description, add photos regularly, and build reviews that mention the service and place.' });
  if (!me.phone) f.push({ id: 'gbp-phone', area: 'local', severity: 'low', title: 'No phone number shown on the listing', why: 'Google did not show a phone number for your listing in the results we read.', evidence: [], trend: null, fix: 'Add your main phone number to the profile and make sure it matches the number on your website.' });
  return f;
}

module.exports = { gbpSummary, gbpFindings, listings, brandListing, visibility };
