import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChanges } from '../../lib/changes.js';

const row = (o) => ({ domain: 'a.example.com', is_me: true, rank: 1, overall: 60, method_version: 2, details: { seo: { checks: [{ name: 'Title tags (30-65 chars)', value: 1 }] }, profile: null }, ...o });

test('a real score movement on the same method is reported', () => {
  const out = buildChanges([row({ overall: 60 })], [row({ overall: 66 })]);
  assert.ok(out.some((c) => /rose 6 points/.test(c.text)));
});
test('across a methodology change, score and check movements are suppressed and the change is announced once', () => {
  const prev = row({ method_version: 1, overall: 80, details: { seo: { checks: [{ name: 'Title tags (30-65 chars)', value: 1 }] } } });
  const cur = row({ method_version: 2, overall: 60, details: { seo: { checks: [{ name: 'Title tags (30-65 chars)', value: 0.2 }] } } });
  const out = buildChanges([prev], [cur]);
  assert.ok(!out.some((c) => /fell|rose|dropped|improved/.test(c.text)), JSON.stringify(out));
  const info = out.filter((c) => /Scoring method updated/.test(c.text));
  assert.equal(info.length, 1); assert.match(info[0].text, /version 1 to 2/); assert.equal(info[0].kind, 'info');
});
test('rows without a method version are treated as version 1', () => {
  const out = buildChanges([row({ method_version: undefined, overall: 60 })], [row({ method_version: 1, overall: 70 })]);
  assert.ok(out.some((c) => /rose 10 points/.test(c.text)));
});
test('facts about the site itself are still reported across a methodology change', () => {
  const prof = (n) => ({ schemaTypes: n ? ['LocalBusiness'] : [], llmsTxt: false, faqPages: 0, sitemapUrls: 10, avgWords: 300 });
  const out = buildChanges([row({ method_version: 1, details: { profile: prof(0) } })], [row({ method_version: 2, details: { profile: prof(1) } })]);
  assert.ok(out.some((c) => /Added structured data/.test(c.text)));
});
