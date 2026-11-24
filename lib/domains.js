// One way to turn "whatever the user typed" or "a URL from a search result" into the domain we store and crawl.
const { isValidHostname } = require('./security/netguard');

// "https://www.Example.com/a?b=1" -> "example.com". Returns null for anything that is not an ordinary public hostname.
function normalizeDomain(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  let host;
  try {
    const u = new URL(s);
    if (u.username || u.password || u.port) return null; // a site name has no credentials and no port
    host = u.hostname;
  } catch { return null; }
  host = host.replace(/\.$/, '').replace(/^www\./, '');
  return isValidHostname(host) ? host : null;
}

module.exports = { normalizeDomain };
