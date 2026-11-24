// A check is { name, value (0..1), weight, note }. Score = weighted mean * 100.
function score(checks) {
  const live = checks.filter((c) => c.value != null);
  const w = live.reduce((s, c) => s + c.weight, 0) || 1;
  const total = live.reduce((s, c) => s + c.value * c.weight, 0) / w;
  return { score: Math.round(total * 1000) / 10, checks };
}
const frac = (n, d) => (d ? n / d : 0);
const clamp = (x) => Math.max(0, Math.min(1, x));
// 1.0 inside [lo, hi], tapering to 0 outside
const inRange = (x, lo, hi, slack) => (x >= lo && x <= hi ? 1 : clamp(1 - (x < lo ? lo - x : x - hi) / slack));

module.exports = { score, frac, clamp, inRange };
