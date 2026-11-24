// Recommendations are generated from stored score details, never from raw crawls, and must cover every check we score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STRONG, WEAK, CONFIGS } from '../fixtures/sites.mjs';
import engine from '../../lib/scoring/engine.js';
import { buildActions, buildPlan, lessonFor, AREAS, WEIGHTS, EFFORT } from '../../lib/recommendations.js';

const score = async (site, c = CONFIGS.full) => (await engine.scoreSite(site, c.cfg, { ...c.ctx, external: {} })).details;
const ctx = { keywords: ['plumber pune'], locations: ['Pune'], brand: 'Acme' };

test('the weak site gets many concrete, prioritised actions; the strong site gets fewer', async () => {
  const weak = buildActions(await score(WEAK()), {}, ctx), strong = buildActions(await score(STRONG()), {}, ctx);
  assert.ok(weak.length > strong.length);
  assert.ok(weak.length >= 10);
  for (const a of weak) {
    assert.ok(a.title && a.why && Array.isArray(a.how) && a.how.length, a.check);
    assert.ok(a.gain > 0, a.check); assert.ok([1, 2, 3].includes(a.effort), a.check); assert.ok(AREAS[a.area], a.check);
    assert.ok(a.current >= 0 && a.current < 85, `${a.check} is only suggested while it scores under 85`);
  }
  const pr = weak.map((a) => a.priority);
  assert.deepEqual(pr, [...pr].sort((a, b) => b - a), 'sorted by priority, highest first');
});

test('the total possible gain never exceeds what is actually available in each area', async () => {
  const d = await score(WEAK());
  const actions = buildActions(d, {}, ctx);
  for (const area of Object.keys(AREAS)) {
    const sum = actions.filter((a) => a.area === area).reduce((s, a) => s + a.areaGain, 0);
    assert.ok(sum <= 100 - d[area].score + 0.6, `${area}: ${sum} vs headroom ${100 - d[area].score}`); // rounding tolerance
  }
});

test('every check the scoring modules can produce either has a playbook rule or is deliberately silent', async () => {
  const seen = new Set(), unmatched = [];
  for (const site of [STRONG(), WEAK()]) for (const c of Object.values(CONFIGS)) {
    const d = await score(site, c);
    for (const a of Object.keys(AREAS)) for (const ch of d[a].checks) {
      if (seen.has(ch.name)) continue; seen.add(ch.name);
      if (!lessonFor(ch.name)) unmatched.push(ch.name);
    }
  }
  // Keyword checks have dynamic rules (no static lesson); the disabled Places / AI-probe checks have no value to improve.
  const allowed = (n) => /^(Coverage:|Google position:|Live Google positions|Google Business Profile|Mentioned in AI answers|PageSpeed|Google rating|Google review)/.test(n);
  assert.deepEqual(unmatched.filter((n) => !allowed(n)), []);
});

test('keyword actions are written for the specific keyword', async () => {
  const d = await score(WEAK());
  const a = buildActions(d, {}, ctx).find((x) => /^Coverage:/.test(x.check));
  assert.match(a.title, /Create a dedicated page for "/);
  assert.match(a.how.join(' '), /plumber pune|geyser|bathroom/i);
});

test('benchmarks against the best competitor raise priority', async () => {
  const d = await score(WEAK());
  const none = buildActions(d, {}, ctx), withBest = buildActions(d, { seo: { 'Exactly one H1': 1 } }, ctx);
  const a = none.find((x) => x.check === 'Exactly one H1'), b = withBest.find((x) => x.check === 'Exactly one H1');
  assert.equal(b.best, 100); assert.ok(b.priority >= a.priority);
});

test('buildPlan spreads quick wins first and big builds later, without losing or repeating any action', async () => {
  const actions = buildActions(await score(WEAK()), {}, ctx);
  const weeks = buildPlan(actions);
  assert.equal(weeks.length, 4);
  const flat = weeks.flat();
  assert.equal(flat.length, actions.length);
  assert.equal(new Set(flat.map((a) => a.check)).size, flat.length);
  assert.ok(weeks[0].every((a) => a.effort === 1));
  assert.ok(weeks[3].every((a) => a.effort === 3));
});

test('recommendations use the single weight definition', () => {
  assert.deepEqual({ ...WEIGHTS }, { seo: 0.3, geo: 0.25, local: 0.2, keywords: 0.25 });
  assert.ok(EFFORT[1] && EFFORT[2] && EFFORT[3]);
});

test('a site with no data produces no actions instead of failing', () => {
  assert.deepEqual(buildActions(null, {}, ctx), []);
  assert.deepEqual(buildActions({ seo: { checks: [] } }, {}, ctx), []);
});
