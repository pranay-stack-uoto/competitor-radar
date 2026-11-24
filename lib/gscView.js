// Turns a stored Search Console snapshot into the lists people act on. Pure functions.
const STOP = new Set(['the', 'and', 'for', 'near', 'best', 'top', 'with', 'from', 'in', 'of', 'to', 'a']);
const toks = (s) => s.toLowerCase().split(/\W+/).filter((t) => t.length > 2 && !STOP.has(t)).map((t) => t.replace(/(es|s)$/, ''));

// A search counts as tracked when it contains every significant word of a tracked keyword, or the other way round.
export function matchesTracked(query, keywords) {
  const q = toks(query);
  return keywords.some((k) => { const t = toks(k); return t.length > 0 && (t.every((w) => q.includes(w)) || (q.length > 0 && q.every((w) => t.includes(w)))); });
}
const expectedCtr = (pos) => (pos <= 1.5 ? 0.28 : pos <= 2.5 ? 0.15 : pos <= 3.5 ? 0.1 : pos <= 5.5 ? 0.06 : 0.025);

export function gscInsights(snap, keywords = []) {
  if (!snap) return null;
  const q = snap.queries || [];
  const strike = q.filter((r) => r.position >= 8 && r.position <= 20 && r.impressions >= 20).sort((a, b) => b.impressions - a.impressions).slice(0, 10);
  const lowCtr = q.filter((r) => r.position <= 10 && r.impressions >= 50 && r.ctr < expectedCtr(r.position) / 2).sort((a, b) => b.impressions - a.impressions).slice(0, 8);
  const untracked = q.filter((r) => r.impressions >= 20 && !matchesTracked(r.query, keywords)).sort((a, b) => b.impressions - a.impressions).slice(0, 10);
  const pageLowCtr = (snap.pages || []).filter((p) => p.position <= 10 && p.impressions >= 100 && p.ctr < expectedCtr(p.position) / 2).slice(0, 6);
  // Your real average position for each tracked keyword (from the searches that match it)
  const realRank = {};
  for (const k of keywords) {
    const rows = q.filter((r) => matchesTracked(r.query, [k]));
    const imp = rows.reduce((s, r) => s + r.impressions, 0);
    if (imp) realRank[k] = { position: Math.round(rows.reduce((s, r) => s + r.position * r.impressions, 0) / imp * 10) / 10, clicks: rows.reduce((s, r) => s + r.clicks, 0), impressions: imp };
  }
  const t = snap.totals, p = snap.prevTotals;
  const change = (a, b) => (b ? Math.round((a - b) / b * 100) : null);
  return { strike, lowCtr, untracked, pageLowCtr, realRank, deltas: { clicks: change(t.clicks, p.clicks), impressions: change(t.impressions, p.impressions) } };
}
