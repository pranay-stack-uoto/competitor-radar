// Small, dependency-free request validation helpers. Pure functions: safe to unit test without a server.
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) { super(message); this.name = 'HttpError'; this.status = status; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// "Bearer <token>" and nothing else. Anything unusual is treated as no credentials.
function bearerToken(headerValue) {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{10,4096})$/.exec(String(headerValue || ''));
  return m ? m[1] : null;
}

// Reads the body as a stream and stops the moment more than maxBytes have arrived: the stream is cancelled, so an oversized or endless
// upload is never buffered. The Content-Length header is only an early exit; it is not trusted (it can be missing, wrong or absent for
// chunked uploads), so the byte count is taken from what is actually read.
async function readBodyBounded(req, maxBytes) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { try { await req.body?.cancel(); } catch {} throw new HttpError(413, 'That request is too large.'); }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw new HttpError(413, 'That request is too large.'); }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'That request could not be read.');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))); }
  catch { throw new HttpError(400, 'That request is not valid text.'); }
}

// Reads a JSON object body with a hard size cap. Never returns arrays, primitives or null.
async function readJsonBody(req, { maxBytes = 16 * 1024 } = {}) {
  const text = await readBodyBounded(req, maxBytes);
  if (!text) return {};
  let v;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'That request is not valid JSON.'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'That request has the wrong shape.');
  return v;
}

function needUuid(v, what = 'id') {
  if (!isUuid(v)) throw new HttpError(400, `Missing or invalid ${what}.`);
  return v.toLowerCase();
}
function needString(v, { max = 200, min = 1, what = 'value' } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `Missing ${what}.`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new HttpError(400, `Invalid ${what}.`);
  return t;
}

// Constant-time string comparison (secrets must not be compared with ===).
function safeEqual(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x ?? '')).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

module.exports = { HttpError, isUuid, bearerToken, readJsonBody, needUuid, needString, safeEqual };
