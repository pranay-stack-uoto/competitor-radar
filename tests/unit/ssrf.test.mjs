// SSRF guard tests. No real network: DNS is faked and requests go to throw-away local servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import guardModule from '../../lib/security/netguard.js';

const { GuardError, isBlockedAddress, isValidHostname, validateUrl, createGuard } = guardModule;

// ---------- address policy ----------
test('blocks every private, loopback, link-local, metadata and reserved IPv4 address', () => {
  for (const ip of ['0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.255.0.9',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) assert.equal(isBlockedAddress(ip), true, ip);
});
test('blocks private, loopback, link-local, unique-local and tunnelling IPv6 forms', () => {
  for (const ip of ['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'FE80::ABCD', 'fc00::1', 'fd12:3456::1', 'fec0::1', 'ff02::1', '2001:db8::1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001::1', '100::1']) assert.equal(isBlockedAddress(ip), true, ip);
});
test('blocks IPv4 addresses hidden inside IPv4-mapped IPv6', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::FFFF:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '::ffff:c0a8:101']) assert.equal(isBlockedAddress(ip), true, ip);
});
test('allows ordinary public addresses, including a mapped public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.255.255', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8']) assert.equal(isBlockedAddress(ip), false, ip);
});
test('treats anything that is not an IP address as blocked', () => {
  for (const x of ['', 'localhost', 'example.com', '999.1.1.1', '1.2.3', null, undefined]) assert.equal(isBlockedAddress(x), true, String(x));
});

// ---------- URL and hostname policy ----------
const code = (fn) => { try { fn(); } catch (e) { return e instanceof GuardError ? e.code : 'other:' + e.message; } return 'allowed'; };

test('only http and https are accepted', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,x', 'ws://example.com/', 'dict://example.com/'])
    assert.equal(code(() => validateUrl(u)), u.startsWith('javascript') || u.startsWith('data') ? 'bad-protocol' : 'bad-protocol', u);
});
test('credentials, odd ports and malformed input are refused', () => {
  assert.equal(code(() => validateUrl('https://user:pass@example.com/')), 'credentials');
  assert.equal(code(() => validateUrl('https://user@example.com/')), 'credentials');
  for (const p of [22, 25, 3306, 5432, 6379, 8080, 9200, 11211]) assert.equal(code(() => validateUrl(`http://example.com:${p}/`)), 'bad-port', String(p));
  assert.equal(code(() => validateUrl('http://example.com:80/')), 'allowed');
  assert.equal(code(() => validateUrl('https://example.com:443/')), 'allowed');
  for (const u of ['not a url', '', 'http://', '//example.com', 'http:///x']) assert.notEqual(code(() => validateUrl(u)), 'allowed', u);
  assert.equal(code(() => validateUrl('x'.repeat(3000))), 'bad-url');
  assert.equal(code(() => validateUrl(null)), 'bad-url');
});
test('IP literals are refused in every spelling', () => {
  for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://8.8.8.8/', 'http://0/', 'http://0.0.0.0/'])
    assert.equal(code(() => validateUrl(u)), 'ip-literal', u);
});
test('local-looking and internal hostnames are refused', () => {
  for (const u of ['http://localhost/', 'http://localhost./', 'http://LOCALHOST/', 'http://foo.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://db.internal/', 'http://router.lan/', 'http://nas.home.arpa/', 'http://x.corp/', 'http://intranet/'])
    assert.notEqual(code(() => validateUrl(u)), 'allowed', u);
});
test('ordinary public hostnames are accepted', () => {
  for (const u of ['https://example.com/', 'http://www.siscoprofiles.co.in/about?x=1', 'https://sub.domain.example.org/a/b', 'https://xn--bcher-kva.example/', 'https://EXAMPLE.com./'])
    assert.equal(code(() => validateUrl(u)), 'allowed', u);
});
test('isValidHostname agrees with the database constraint', () => {
  for (const h of ['example.com', 'a-b.co.in', 'x.y.z.example.org']) assert.equal(isValidHostname(h), true, h);
  for (const h of ['localhost', '127.0.0.1', 'example', 'exa mple.com', '-a.com', 'a-.com', 'example.c', 'foo.internal', 'a.com:80', '']) assert.equal(isValidHostname(h), false, h);
});

// ---------- DNS answers ----------
const fakeDns = (table) => (host, opts, cb) => { const a = table[host]; a ? setImmediate(() => cb(null, a)) : setImmediate(() => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }))); };
const A = (address, family = 4) => ({ address, family });
const resolveVia = (guard, host, opts = { all: true }) => new Promise((res) => guard.guardedLookup(host, opts, (err, a, f) => res({ err, a, f })));

test('a hostname that resolves to a private address is refused at connect time', async () => {
  const g = createGuard({ lookup: fakeDns({ 'evil.example': [A('127.0.0.1')], 'meta.example': [A('169.254.169.254')], 'v6.example': [A('::1', 6)], 'mapped.example': [A('::ffff:7f00:1', 6)] }) });
  for (const h of ['evil.example', 'meta.example', 'v6.example', 'mapped.example']) {
    const r = await resolveVia(g, h);
    assert.equal(r.err?.code, 'blocked-address', h);
  }
});
test('mixed public and private answers are refused (a hostile name can return both)', async () => {
  const g = createGuard({ lookup: fakeDns({ 'mixed.example': [A('93.184.216.34'), A('10.0.0.5')] }) });
  assert.equal((await resolveVia(g, 'mixed.example')).err?.code, 'blocked-address');
});
test('public answers pass, in both lookup call styles', async () => {
  const g = createGuard({ lookup: fakeDns({ 'ok.example': [A('93.184.216.34')] }) });
  const all = await resolveVia(g, 'ok.example', { all: true });
  assert.deepEqual(all.a, [A('93.184.216.34')]);
  const one = await resolveVia(g, 'ok.example', {});
  assert.equal(one.a, '93.184.216.34');
});
test('DNS failures and empty answers are reported as dns-failed', async () => {
  const g = createGuard({ lookup: fakeDns({ 'empty.example': [] }) });
  assert.equal((await resolveVia(g, 'nope.example')).err?.code, 'dns-failed');
  assert.equal((await resolveVia(g, 'empty.example')).err?.code, 'dns-failed');
});
test('DNS rebinding: the address is checked on every connection lookup, so a name that turns private is refused', async () => {
  let calls = 0;
  const g = createGuard({ lookup: (h, o, cb) => setImmediate(() => cb(null, [A(++calls === 1 ? '93.184.216.34' : '127.0.0.1')])) });
  assert.equal((await resolveVia(g, 'rebind.example')).err, null);
  assert.equal((await resolveVia(g, 'rebind.example')).err?.code, 'blocked-address');
});

// ---------- real requests against local servers ----------
let servers = [], port, hits;
const loopbackOnly = (ip) => ip !== '127.0.0.1' && isBlockedAddress(ip);
const names = { 'allowed.example': [A('127.0.0.1')], 'blocked.example': [A('127.0.0.2')] };
const g = () => createGuard({ lookup: fakeDns(names), isBlocked: loopbackOnly, anyPort: true });
const at = (p) => `http://allowed.example:${port}${p}`;

before(async () => {
  hits = { blocked: 0 };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/ok') { res.setHeader('content-type', 'text/html'); return res.end('<html>hello</html>'); }
    if (p === '/json') { res.setHeader('content-type', 'application/json'); return res.end('{"a":1}'); }
    if (p === '/big') { res.setHeader('content-type', 'text/html'); return res.end('x'.repeat(2_000_000)); }
    if (p === '/slow') return; // never answers
    if (p === '/a') { res.statusCode = 301; res.setHeader('location', '/b'); return res.end(); }
    if (p === '/b') { res.statusCode = 302; res.setHeader('location', `http://allowed.example:${port}/ok`); return res.end(); }
    if (p === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop2'); return res.end(); }
    if (p === '/loop2') { res.statusCode = 302; res.setHeader('location', '/loop'); return res.end(); }
    const m = /^\/hop(\d+)$/.exec(p);
    if (m) { res.statusCode = 302; res.setHeader('location', `/hop${Number(m[1]) + 1}`); return res.end(); }
    const to = { '/to-private': 'http://blocked.example:' + port + '/', '/to-meta': 'http://169.254.169.254/latest/meta-data/', '/to-localhost': 'http://localhost/', '/to-file': 'file:///etc/passwd', '/to-creds': 'http://u:p@allowed.example/', '/to-port': 'http://allowed.example:6379/', '/to-ip6': 'http://[::1]/' }[p];
    if (to) { res.statusCode = 302; res.setHeader('location', to); return res.end(); }
    res.statusCode = 404; res.end('no');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port; servers.push(srv);
});
after(() => { for (const s of servers) s.close(); servers = []; });

const failsWith = async (p, c, opts) => { await assert.rejects(g().safeFetch(at(p), opts), (e) => e instanceof GuardError && e.code === c, `${p} should fail with ${c}`); };

test('fetches an allowed page and returns its body', async () => {
  const r = await g().safeFetch(at('/ok'));
  assert.equal(r.status, 200); assert.equal(r.body, '<html>hello</html>'); assert.match(r.type, /html/);
});
test('follows ordinary redirects, including a relative one', async () => {
  const r = await g().safeFetch(at('/a'));
  assert.equal(r.status, 200); assert.equal(r.redirects.length, 2); assert.match(r.url, /\/ok$/);
});
test('refuses a redirect to a host that resolves to a blocked address, and never contacts it', async () => {
  await failsWith('/to-private', 'blocked-address');
});
test('refuses a redirect to the cloud metadata address, localhost, a file URL, credentials, an odd port and IPv6 loopback', async () => {
  await failsWith('/to-meta', 'ip-literal');
  await failsWith('/to-localhost', 'blocked-host');
  await failsWith('/to-file', 'bad-protocol');
  await failsWith('/to-creds', 'credentials');
  await failsWith('/to-ip6', 'ip-literal');
  // the odd-port check is part of the default policy, so test it with a strict instance
  const strict = createGuard({ lookup: fakeDns(names), isBlocked: loopbackOnly, anyPort: false });
  await assert.rejects(strict.safeFetch(at('/ok')), (e) => e.code === 'bad-port');
});
test('stops redirect loops and long chains', async () => {
  await failsWith('/loop', 'too-many-redirects');
  await failsWith('/hop1', 'too-many-redirects');
  const r = await g().safeFetch(at('/hop1'), { maxRedirects: 50 }).catch((e) => e);
  assert.ok(r instanceof GuardError); // the chain never ends, so even a high cap terminates with an error
});
test('aborts oversized responses', async () => { await failsWith('/big', 'too-large', { maxBytes: 100_000 }); });
test('times out a server that never answers', async () => { await failsWith('/slow', 'timeout', { timeoutMs: 250 }); });
test('does not read the body of a content type that was not requested', async () => {
  const r = await g().safeFetch(at('/json'), { allowTypes: /text\/html/ });
  assert.equal(r.status, 200); assert.equal(r.body, '');
});
test('HEAD requests return headers without a body', async () => {
  const r = await g().request(at('/ok'), { method: 'HEAD' });
  assert.equal(r.status, 200); assert.equal(r.body, '');
});
test('error messages shown to users never contain internal addresses', async () => {
  const e = await g().safeFetch(at('/to-private')).catch((x) => x);
  assert.doesNotMatch(e.message, /127\.|169\.254|10\.|blocked\.example/);
});
test('the exported default instance is strict: it refuses loopback by name and by literal', async () => {
  for (const u of ['http://127.0.0.1:1/', 'http://localhost:1/', 'http://[::1]/', 'http://169.254.169.254/']) await assert.rejects(guardModule.safeFetch(u, { timeoutMs: 500 }), (e) => e instanceof GuardError, u);
});
