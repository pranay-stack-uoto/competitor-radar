// Scoring engine: behaviour is locked to golden outputs captured from the pre-refactor modules, weights live in one
// place, and scoring never touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { STRONG, WEAK, EMPTY, CONFIGS } from '../fixtures/sites.mjs';
import engine from '../../lib/scoring/engine.js';
import config from '../../lib/scoring/config.js';
import seo from '../../lib/modules/seo.js';
import geo from '../../lib/modules/geo.js';
import local from '../../lib/modules/local.js';
import keywords from '../../lib/modules/keywords.js';
import util from '../../lib/modules/util.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/scoring-golden.json', import.meta.url), 'utf8'));
const MODS = { seo, geo, local, keywords };
const trim = (r) => ({ score: r.score, checks: (r.checks || []).map((k) => ({ name: k.name, value: k.value, weight: k.weight, note: k.note ?? null })), note: r.note ?? null });

test('the refactored modules reproduce the original scores exactly (golden fixtures)', async () => {
  for (const [sn, site] of Object.entries({ STRONG, WEAK, EMPTY })) for (const [cn, c] of Object.entries(CONFIGS)) for (const [mn, mod] of Object.entries(MODS)) {
    const ctx = { ...c.ctx, external: {} }; // nothing collected, exactly as the golden run had no network
    assert.deepEqual(trim(await mod(site(), c.cfg, ctx)), golden[`${sn}/${cn}`][mn], `${sn}/${cn}/${mn}`);
  }
});

test('scoring modules never use the network', () => {
  for (const f of readdirSync(new URL('../../lib/modules/', import.meta.url)).filter((x) => x.endsWith('.js'))) {
    const code = readFileSync(new URL('../../lib/modules/' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /(^|[^.\w])fetch\(|require\('\.\.\/crawl'\)|api\.anthropic|googleapis/, f);
  }
});

test('weights are defined once, sum to 1, and are exactly the approved values', () => {
  assert.deepEqual({ ...config.WEIGHTS }, { seo: 0.3, geo: 0.25, local: 0.2, keywords: 0.25 });
  assert.equal(Object.values(config.WEIGHTS).reduce((a, b) => a + b, 0), 1);
  assert.throws(() => { 'use strict'; config.WEIGHTS.seo = 0.9; }); // frozen: nothing can change them at runtime
  const defs = [];
  for (const dir of ['lib', 'app']) for (const f of walk(new URL(`../../${dir}/`, import.meta.url).pathname)) if (/seo:\s*0\.3\b/.test(readFileSync(f, 'utf8'))) defs.push(path.relative(process.cwd(), f));
  assert.deepEqual(defs, ['lib/scoring/config.js']);
});
function walk(d) { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.js$/.test(e.name) ? [path.join(d, e.name)] : [])); }

test('the methodology version is a positive integer', () => assert.ok(Number.isInteger(config.METHODOLOGY_VERSION) && config.METHODOLOGY_VERSION >= 2));

test('scoreSite returns scores, an overall score, the method version and the weights used', async () => {
  const r = await engine.scoreSite(STRONG(), { keywords: CONFIGS.full.cfg.keywords, locations: CONFIGS.full.cfg.locations }, { ...CONFIGS.full.ctx, external: {} });
  for (const a of config.AREA_ORDER) assert.ok(r.row[a] >= 0 && r.row[a] <= 100, a);
  assert.equal(r.methodVersion, config.METHODOLOGY_VERSION);
  assert.deepEqual(r.weights, { ...config.WEIGHTS });
  const expected = Math.round((r.row.seo * 0.3 + r.row.geo * 0.25 + r.row.local * 0.2 + r.row.keywords * 0.25) * 10) / 10;
  assert.equal(r.overall, expected);
});

test('overall score arithmetic', () => {
  assert.equal(engine.combine({ seo: 100, geo: 100, local: 100, keywords: 100 }), 100);
  assert.equal(engine.combine({ seo: 0, geo: 0, local: 0, keywords: 0 }), 0);
  assert.equal(engine.combine({}), 0);
  assert.equal(engine.combine({ seo: 80, geo: 60, local: 40, keywords: 20 }), 52); // .3*80+.25*60+.2*40+.25*20
});

test('one failing module is contained: the others still score and the failure is recorded safely', async () => {
  const crawl = STRONG(); crawl.sitemap = null; // only the SEO module reads crawl.sitemap.found, so only it fails
  const r = await engine.scoreSite(crawl, { keywords: ['plumber pune'], locations: ['Pune'] }, { site: { name: 'x' }, external: {} });
  assert.equal(r.row.seo, 0); assert.match(r.details.seo.note, /Module error/);
  assert.ok(r.row.geo > 0 && r.row.local > 0);
});

test('every check is labelled with how it was obtained', async () => {
  const r = await engine.scoreSite(STRONG(), { keywords: ['plumber pune'], locations: ['Pune'] }, { ...CONFIGS.full.ctx, external: {} });
  const basis = new Set();
  for (const a of config.AREA_ORDER) for (const c of r.details[a].checks) { assert.ok(['measured', 'sampled', 'heuristic', 'external', 'ai-sampled'].includes(c.basis), `${c.name}: ${c.basis}`); basis.add(c.basis); }
  assert.ok(basis.has('measured') && basis.has('sampled') && basis.has('heuristic') && basis.has('external'));
  assert.equal(config.basisOf('Google position: "x"'), 'external');
  assert.equal(config.basisOf('Mentioned in AI answers (live probe)'), 'ai-sampled');
  assert.equal(config.basisOf('XML sitemap'), 'measured');
});

test('external facts passed in become checks; missing or failed ones add nothing misleading', async () => {
  const base = { ...CONFIGS.full.ctx };
  const names = async (external) => { const r = await engine.scoreSite(STRONG(), CONFIGS.full.cfg, { ...base, external }); return [...r.details.local.checks, ...r.details.geo.checks, ...r.details.seo.checks].map((c) => c.name + '=' + c.value); };
  assert.ok((await names({ places: { status: 'ok', rating: 4.8, reviews: 400 } })).includes('Google review volume=1'));
  assert.ok((await names({ places: { status: 'ok', rating: 4.8, reviews: 100 } })).includes('Google review volume=0.5'));
  assert.ok((await names({ aiProbe: { status: 'ok', asked: 4, hits: 1 } })).includes('Mentioned in AI answers (live probe)=0.25'));
  assert.ok((await names({ pagespeed: { perf: 0.9, seo: 1 } })).includes('PageSpeed mobile performance=0.9'));
  const none = await names({ places: { status: 'none' }, aiProbe: { status: 'none' } });
  assert.ok(!none.some((n) => /Google (rating|review)|Business Profile|Mentioned in AI/.test(n)), 'a failed lookup must not add a check');
  const off = await names({ places: { status: 'disabled' }, aiProbe: { status: 'disabled' } });
  assert.ok(off.includes('Google Business Profile rating & reviews=null') && off.includes('Mentioned in AI answers (live probe)=null'));
});

test('score() ignores unmeasured checks (value null) instead of counting them as zero', () => {
  const r = util.score([{ name: 'a', value: 1, weight: 1 }, { name: 'b', value: null, weight: 100 }]);
  assert.equal(r.score, 100);
  assert.equal(util.score([]).score, 0);
});
