// SSRF guard: every outbound request that touches a host a user (or a crawled page) can influence goes through here.
//
// What it enforces
//  - http and https only, no credentials in the URL, ports 80 and 443 only
//  - hostnames only: IP literals (including decimal, hex and octal spellings) are refused
//  - local-looking suffixes (.local, .internal, ...) are refused
//  - the address the connection will actually use is checked at CONNECT time, inside the socket's own DNS lookup,
//    so the address that was validated is the address that is dialled. This defeats DNS rebinding: there is no
//    second resolution between "check" and "connect"
//  - every redirect hop is validated again, redirects are capped
//  - response size and total time are capped, content types can be restricted
//
// Known limits are listed in docs/SECURITY.md (for example: IPv6 zone ids, and anything that bypasses this module).
const dns = require('node:dns');
const net = require('node:net');
const { Agent, fetch: undiciFetch } = require('undici');

class GuardError extends Error {
  constructor(code, detail) {
    super(PUBLIC_MESSAGES[code] || 'That address is not allowed.');
    this.name = 'GuardError';
    this.code = code;
    this.detail = detail; // for logs only; never sent to a user
  }
}
const PUBLIC_MESSAGES = {
  'bad-url': 'That is not a valid web address.',
  'bad-protocol': 'Only http and https addresses are allowed.',
  'credentials': 'Addresses with a username or password are not allowed.',
  'bad-port': 'That port is not allowed.',
  'ip-literal': 'Use a website name, not an IP address.',
  'bad-host': 'That is not a valid website name.',
  'blocked-host': 'That address is not allowed.',
  'blocked-address': 'That address is not allowed.',
  'dns-failed': 'We could not find that website.',
  'too-many-redirects': 'That website redirects too many times.',
  'too-large': 'That response is too large.',
  'budget-exhausted': 'This website is larger than our crawl limit.',
  'timeout': 'That website took too long to respond.',
  'aborted': 'The request was cancelled.',
};

// ----- address ranges that must never be reached from our servers -------------------------------------------------
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(addr, prefix, 'ipv6');

function isBlockedAddress(ip) {
  let fam = net.isIP(ip);
  if (!fam) return true; // not an address at all: refuse
  if (fam === 6) {
    // Normalise the spelling (expanded, mixed-case, zero-compressed) before matching.
    let norm;
    try { norm = new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return true; }
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(norm);
    if (dotted) return isBlockedAddress(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(norm);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return BLOCKED.check(norm, 'ipv6');
  }
  return BLOCKED.check(ip, 'ipv4');
}

// ----- URL and hostname validation ----------------------------------------------------------------------------------
const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home', '.corp', '.intranet', '.private', '.localdomain', '.home.arpa'];

function isValidHostname(host) {
  const h = String(host || '').toLowerCase();
  return h.length <= 253 && HOST_RE.test(h) && !LOCAL_SUFFIXES.some((s) => h.endsWith(s));
}

function validateUrl(raw, { anyPort = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 2048) throw new GuardError('bad-url');
  let u;
  try { u = new URL(raw); } catch { throw new GuardError('bad-url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GuardError('bad-protocol', u.protocol);
  if (u.username || u.password) throw new GuardError('credentials');
  if (!anyPort && u.port && u.port !== '80' && u.port !== '443') throw new GuardError('bad-port', u.port);
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  // WHATWG parsing already rewrites 2130706433, 0x7f.1 and 017700000001 to 127.0.0.1, so one isIP check covers them all.
  if (net.isIP(host)) throw new GuardError('ip-literal');
  if (!isValidHostname(host)) throw new GuardError(LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || host === 'localhost' ? 'blocked-host' : 'bad-host', host);
  return u;
}

// ----- aggregate download budget -----------------------------------------------------------------------------------------------
// A budget is shared by every request of one crawl. It counts the bytes actually read from the network, after decompression, so it
// cannot be fooled by a missing or false Content-Length or by a compressed response that expands. Each request also costs a small
// fixed amount so an endless run of bodiless requests (HEAD) is bounded too. When it is spent, requests stop at once.
function createByteBudget(maxBytes, { requestOverhead = 1024, signal } = {}) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('A byte budget must be a positive number');
  const b = {
    max: maxBytes, used: 0, exhausted: false, requestOverhead, signal, // signal: aborted when the job that owns this crawl loses its lease
    add(n) { b.used += n; if (b.used > b.max) { b.exhausted = true; throw new GuardError('budget-exhausted', `${b.used}/${b.max}`); } },
    assertOpen() { if (signal && signal.aborted) throw new GuardError('aborted'); if (b.exhausted || b.used >= b.max) { b.exhausted = true; throw new GuardError('budget-exhausted', `${b.used}/${b.max}`); } },
    remaining() { return Math.max(0, b.max - b.used); },
  };
  return b;
}

// ----- the guard ----------------------------------------------------------------------------------------------------------
// createGuard() builds an instance. Production code uses the default instance exported below. Tests build instances with a
// fake resolver and a relaxed address policy so they can talk to local servers. The relaxed policy is never reachable from
// the exported defaults.
function createGuard({ lookup = dns.lookup, isBlocked = isBlockedAddress, anyPort = false } = {}) {
  // Runs inside the socket's own resolution. Validate every answer, then hand back only validated answers.
  function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(new GuardError('dns-failed', err.code));
      if (!Array.isArray(addrs) || !addrs.length) return cb(new GuardError('dns-failed', 'empty'));
      // One bad answer poisons the lot: a hostile name can mix public and private records.
      if (addrs.some((a) => isBlocked(a.address))) return cb(new GuardError('blocked-address', hostname));
      if (options && options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  }
  const agent = new Agent({ connect: { lookup: guardedLookup, timeout: 10000 }, maxRedirections: 0 });

  // Reads at most maxBytes for this response AND at most what is left of the crawl budget. Whichever runs out first stops the read
  // immediately: the stream is cancelled, so no more data is pulled into memory.
  async function readLimited(res, maxBytes, budget) {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return Buffer.alloc(0);
    let chunks = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (budget) budget.add(value.length);          // counts what was really downloaded; throws when the crawl budget is spent
        if (n > maxBytes) throw new GuardError('too-large');
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    } finally {
      chunks = null; // drop the pieces as soon as they have been joined (or abandoned)
    }
  }

  // One request, no redirects. Everything is validated; the connection can only go to an address that passed.
  async function request(raw, { method = 'GET', headers = {}, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024, readBody, allowTypes, budget, signal: outer } = {}) {
    const u = validateUrl(raw, { anyPort });
    const external = outer || (budget && budget.signal); // cancelled from outside (a job that lost its lease)
    if (external && external.aborted) throw new GuardError('aborted');
    if (budget) { budget.assertOpen(); budget.add(budget.requestOverhead); } // before anything is sent
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    if (external) external.addEventListener('abort', onAbort, { once: true });
    try {
      const t0 = Date.now();
      const res = await undiciFetch(u.href, { method, headers, redirect: 'manual', signal: ctrl.signal, dispatcher: agent });
      const ttfbMs = Date.now() - t0; // until the response headers arrived: how fast the server itself answered
      const type = res.headers.get('content-type') || '';
      const wantBody = (readBody ?? method === 'GET') && res.status >= 200 && res.status < 300;
      let body = '';
      if (wantBody && (!allowTypes || allowTypes.test(type))) body = (await readLimited(res, maxBytes, budget)).toString('utf8');
      else if (res.body) await res.body.cancel().catch(() => {});
      return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, type, body, url: u.href, length: Number(res.headers.get('content-length')) || body.length, ttfbMs, totalMs: Date.now() - t0, bytes: Buffer.byteLength(body), encoding: res.headers.get('content-encoding') || '' };
    } catch (e) {
      if (e instanceof GuardError) throw e;
      // undici wraps errors thrown by our lookup; unwrap so callers see the guard's code.
      const inner = e && e.cause;
      if (inner instanceof GuardError) throw inner;
      if (external && external.aborted) throw new GuardError('aborted');
      if (ctrl.signal.aborted || (e && e.name === 'AbortError')) throw new GuardError('timeout');
      throw new GuardError('dns-failed', String(e && (e.code || e.message)).slice(0, 120));
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  }

  // Follows redirects itself so that every hop is validated before anything is sent to it.
  async function safeFetch(raw, opts = {}) {
    const { maxRedirects = 5 } = opts;
    let cur = raw;
    const redirects = [];
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const r = await request(cur, opts);
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        redirects.push({ url: cur, status: r.status });
        let next;
        try { next = new URL(loc, cur).href; } catch { throw new GuardError('bad-url'); }
        if (redirects.some((x) => x.url === next)) throw new GuardError('too-many-redirects', 'loop');
        cur = next;
        continue;
      }
      return { ...r, redirects };
    }
    throw new GuardError('too-many-redirects');
  }

  return { request, safeFetch, validateUrl: (u) => validateUrl(u, { anyPort }), guardedLookup };
}

const guard = createGuard();
module.exports = { GuardError, isBlockedAddress, isValidHostname, validateUrl, createGuard, createByteBudget, ...guard };
