// A tiny in-memory website for crawler and audit tests. No network.
// A tiny in-memory web. pages: { '/path': { status, type, body, headers, location, delay } }
export function web(host, pages, { sitemap, robots, llms } = {}) {
  const calls = [];
  const resolve = (url) => { const u = new URL(url); return { u, entry: pages[u.pathname + (u.search || '')] }; };
  const respond = (url, method) => {
    const { u, entry } = resolve(url);
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === '/robots.txt' && robots != null) return { status: 200, type: 'text/plain', body: robots, headers: {} };
    if (u.pathname === '/llms.txt' && llms) return { status: 200, type: 'text/plain', body: llms, headers: {} };
    if (u.pathname === '/sitemap.xml' && sitemap) return { status: 200, type: 'application/xml', body: sitemap, headers: {} };
    if (u.pathname.startsWith('/sitemap-') && pages[u.pathname]) return entry;
    if (!entry) return { status: 404, type: 'text/html', body: '', headers: {} };
    return entry;
  };
  const mk = (url, method, chain = []) => {
    const r = respond(url, method);
    if (r.location) {
      const next = new URL(r.location, url).href;
      if (chain.some((c) => c.url === next) || chain.length >= 5) return r.location.includes('loop') || chain.length >= 5 ? { ok: false, status: r.status || 302, type: '', body: '', url: next, chain: [...chain, { url, status: r.status }], loop: true } : null;
      return mk(next, method, [...chain, { url, status: r.status || 301 }]);
    }
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, type: r.type || '', body: ok && method === 'GET' ? r.body || '' : '', url, chain, xrobots: (r.headers && r.headers['x-robots-tag']) || '', length: (r.body || '').length };
  };
  return {
    calls,
    fetchers: {
      get: async (url) => { const r = mk(url, 'GET'); return { ok: r.ok, status: r.status, type: r.type, body: r.body, url: r.url }; },
      getTracked: async (url, ua, t, method = 'GET') => mk(url, method),
    },
  };
}
export const html = (title, links = [], extra = '') => `<html><head><title>${title}</title><meta name="description" content="${title} description long enough to count"></head><body><h1>${title}</h1><p>${'word '.repeat(120)}</p>${links.map((l) => `<a href="${l}">link</a>`).join('')}${extra}</body></html>`;
export const page = (body, extra = {}) => ({ status: 200, type: 'text/html', body, headers: {}, ...extra });
export const cfgOf = (fetchers, over = {}) => ({ fetchers, crawl: { maxPagesPerSite: 20, delayMs: 0, maxMs: 5000, userAgent: 'test', ...over } });

