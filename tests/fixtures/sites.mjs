// Synthetic websites for scoring tests: built from real HTML through the real page analyser, so they match what the crawler produces.
import crawler from '../../lib/crawl.js';

const PAGE = ({ title, body, extra = '', ld = true, h1 = true, h2 = 2 }) => `<html lang="en"><head><title>${title}</title><meta name="description" content="${body.slice(0, 120)}"><meta name="viewport" content="width=device-width">
  <link rel="canonical" href="https://x.example.com/"><meta property="og:title" content="x"><meta property="og:description" content="d"><meta property="og:image" content="i">
  ${ld ? `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Shop","address":{"streetAddress":"12 Main Road","addressLocality":"Pune"},"areaServed":"Pune","sameAs":["https://facebook.com/shop","https://linkedin.com/company/shop"],"aggregateRating":{"ratingValue":4.8}}</script>` : ''}</head>
  <body>${h1 ? `<h1>${title}</h1>` : ''}${Array.from({ length: h2 }, (_, i) => `<h2>Section ${i}${i === 0 ? '?' : ''}</h2>`).join('')}<p>${body}</p><a href="tel:+911234567890">Call +91 12345 67890</a><img src="/a.jpg" alt="shop"><img src="/b.jpg">${extra}</body></html>`;

const build = (origin, pages, over = {}) => ({
  origin, robotsTxt: 'User-agent: *\nAllow: /', robots: crawler.parseRobots('User-agent: *\nAllow: /\nSitemap: ' + origin + '/sitemap.xml'), llmsTxt: false,
  sitemap: { found: true, count: pages.length, sampled: pages.length }, errors: [], redirects: [], brokenLinks: [], linkCheck: { targets: 3, verified: 0 }, imageSample: [],
  pages: pages.map((p, i) => ({ ...crawler.analyzePage(PAGE(p), `${origin}/${p.slug || (i ? 'p' + i : '')}`), ms: 150 + i * 20, status: 200, https: true, noindex: false, redirectHops: 0, fromSitemap: true, requested: `${origin}/${p.slug || (i ? 'p' + i : '')}` })),
  ...over,
});

const long = (s, n) => s.repeat(n);
export const STRONG = () => build('https://strong.example.com', [
  { title: 'Plumber in Pune | Strong Plumbing', body: long('We are a plumbing company serving Pune and Mumbai with leak repair, pipe fitting and bathroom plumbing. ', 14) },
  { title: 'Bathroom plumbing in Pune', body: long('Complete bathroom plumbing for homes in Pune: fittings, drainage, geysers and waterproofing. ', 12), slug: 'bathroom' },
  { title: 'Contact our Pune office', body: long('Visit 12 Main Road, Pune 411001. Call us today for plumber services in Pune. ', 9), slug: 'contact', extra: '<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>' },
], { llmsTxt: true, imageSample: [{ url: 'https://strong.example.com/a.jpg', bytes: 40000 }, { url: 'https://strong.example.com/b.jpg', bytes: 60000 }, { url: 'https://strong.example.com/c.jpg', bytes: 20000 }] });

export const WEAK = () => build('https://weak.example.com', [
  { title: 'Home', body: 'Welcome to our website.', ld: false, h1: false, h2: 0 },
  { title: 'Home', body: 'Welcome to our website.', ld: false, h1: false, h2: 0, slug: 'about' },
], { sitemap: { found: false, count: 0, sampled: 0 }, robotsTxt: '', robots: crawler.parseRobots(''), errors: [{ url: 'https://weak.example.com/x', status: 404 }], brokenLinks: [{ from: 'https://weak.example.com/', to: 'https://weak.example.com/x', status: 404 }],
  redirects: [{ from: 'https://weak.example.com/old', to: 'https://weak.example.com/', hops: 3, status: 301 }], imageSample: [{ url: 'https://weak.example.com/big.jpg', bytes: 2_000_000 }, { url: 'https://weak.example.com/big2.jpg', bytes: 900000 }, { url: 'https://weak.example.com/ok.jpg', bytes: 10000 }] });

export const EMPTY = () => ({ origin: 'https://empty.example.com', pages: [], errors: [], robotsTxt: '', robots: crawler.parseRobots(''), llmsTxt: false, sitemap: { found: false, count: 0, sampled: 0 }, redirects: [], brokenLinks: [], linkCheck: { targets: 0 }, imageSample: [] });

export const CONFIGS = {
  full: { cfg: { keywords: ['plumber pune', 'bathroom plumbing', 'geyser repair'], locations: ['Pune', 'Mumbai'], aiPrompts: [] }, ctx: { site: { name: 'strong.example.com' }, pagespeed: false, serpRanks: { 'plumber pune|Pune': 3, 'plumber pune|Mumbai': 0, 'bathroom plumbing|Pune': 12, 'geyser repair|Pune': 0 } } },
  bare: { cfg: { keywords: [], locations: [], aiPrompts: [] }, ctx: { site: { name: 'weak.example.com' }, pagespeed: false } },
};
