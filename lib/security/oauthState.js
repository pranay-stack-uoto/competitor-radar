// Single-use state for the Google (Search Console) sign-in round trip. The state the browser carries is signed and expiring
// (lib/security/crypto.js) and also holds a random nonce; the server stores only the nonce's hash (migration 0017) and the callback consumes it
// atomically, so a copied or replayed state cannot be used a second time. The nonce is tied to the user and project that started the flow.
const crypto = require('node:crypto');
const { signState, readState } = require('./crypto');
const { HttpError, isUuid } = require('./validate');

const hashNonce = (nonce) => crypto.createHash('sha256').update('oauth-nonce:' + nonce).digest('hex');
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

// Returns the signed state string to put in the Google URL. Throws a generic 503 if the nonce cannot be stored (never starts a flow it cannot verify).
async function startOAuth(db, { userId, projectId }, env = process.env) {
  const nonce = crypto.randomBytes(32).toString('base64url');
  let res;
  try { res = await db.rpc('oauth_state_create', { p_hash: hashNonce(nonce), p_user: userId, p_project: projectId, p_ttl_seconds: 600 }); }
  catch { res = { data: null, error: { message: 'exception' } }; }
  if (res.error || res.data !== true) throw new HttpError(res.data === false && !res.error ? 403 : 503, res.data === false && !res.error ? 'You do not have permission to do that.' : 'Search Console is temporarily unavailable. Please try again.');
  return signState({ projectId, userId, n: nonce }, env);
}

// Validates the signature and expiry, then consumes the nonce. { ok: true, userId, projectId } or { ok: false, reason } (reasons are for logs only).
async function finishOAuth(db, state, env = process.env, now = Date.now()) {
  let st;
  try { st = readState(state, env, now); } catch { return { ok: false, reason: 'unavailable' }; }
  if (!st) return { ok: false, reason: 'bad-state' };
  if (typeof st.n !== 'string' || !NONCE_RE.test(st.n) || !isUuid(st.userId) || !isUuid(st.projectId)) return { ok: false, reason: 'bad-state' };
  let res;
  try { res = await db.rpc('oauth_state_consume', { p_hash: hashNonce(st.n), p_user: st.userId, p_project: st.projectId }); }
  catch { return { ok: false, reason: 'unavailable' }; }
  if (res.error) return { ok: false, reason: 'unavailable' };
  if (res.data !== true) return { ok: false, reason: 'used-or-invalid' };
  return { ok: true, userId: st.userId, projectId: st.projectId };
}

module.exports = { startOAuth, finishOAuth, hashNonce };
