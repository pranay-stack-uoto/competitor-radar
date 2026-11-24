// Encryption for secrets we must store (Search Console refresh tokens) and signing for short-lived OAuth state.
//
// Key ring: TOKEN_ENC_KEYS is a JSON object of { "<version>": "<base64 of 32 random bytes>" }. TOKEN_ENC_ACTIVE names the
// version used for new writes (default: the highest version). Old versions stay in the ring so old data stays readable.
// Rotating a key = add a new version, set it active, keep the old one until nothing uses it.
//
// Stored formats (all AES-256-GCM):
//   envelope  e<kek>.<kIv>.<kTag>.<wrappedKey>.<iv>.<tag>.<ciphertext>   a random data key per value encrypts it; the ring key (the "KEK")
//                                                                         only wraps that data key. Written when TOKEN_ENVELOPE=1.
//   versioned v<version>.<iv>.<tag>.<ciphertext>                         the ring key encrypts the value directly. Written by default.
//   legacy    <iv>.<tag>.<ciphertext>                                     key derived from the service-role key; still readable.
// Envelope encryption means a rotation only re-wraps small keys (rewrap() never sees the plaintext), and a value can be bound to a
// context (the project id) so a ciphertext copied onto another project's row will not decrypt. All formats are always READABLE;
// only the write format is switched by the flag, so deploying this code changes nothing until the flag is set, and rolling back
// before the flag is set is safe. The ring (TOKEN_ENC_KEYS) lives in the host's secret store, never in the database.
//
// PRODUCTION requires independent keys: with no valid TOKEN_ENC_KEYS (or a key that is just derived from the service-role key) encrypt()
// and the OAuth state signer REFUSE to run, so a new secret is never protected by a key that the database service key can recreate.
// The legacy key is still used to READ old values, and only for that, so they can be migrated (npm run rotate-keys). Outside production
// (NODE_ENV development or test) the legacy key still works for local use. Setup steps are in docs/OPERATIONS.md.
const crypto = require('node:crypto');

const sha = (s) => crypto.createHash('sha256').update(s).digest();
// Anything that is not explicitly development or test is production, so a missing or odd NODE_ENV cannot weaken this.
const isProduction = (env) => !['development', 'test'].includes(String(env.NODE_ENV || ''));

// Called before every write. Reading old values never calls this.
function requireIndependentKeys(env, { ring, active, legacy }) {
  if (!isProduction(env)) return;
  if (!active) throw new Error('TOKEN_ENC_KEYS is required in production');
  if (legacy) for (const k of ring.values()) if (k.equals(legacy)) throw new Error('A token encryption key must not be derived from the service-role key');
}

// True when this process may store new secrets and sign OAuth state (used to switch Search Console off instead of failing half way).
function cryptoReady(env = process.env) {
  try { const k = loadKeyring(env); requireIndependentKeys(env, k); if (isProduction(env) && !env.STATE_SIGNING_KEY && !k.active) return false; return !!(k.active || k.legacy); }
  catch { return false; }
}

function loadKeyring(env = process.env) {
  const ring = new Map();
  if (env.TOKEN_ENC_KEYS) {
    let parsed;
    try { parsed = JSON.parse(env.TOKEN_ENC_KEYS); } catch { throw new Error('TOKEN_ENC_KEYS is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('TOKEN_ENC_KEYS must be a JSON object of version: key');
    for (const [version, b64] of Object.entries(parsed)) {
      if (!/^\d{1,4}$/.test(version)) throw new Error(`Key version "${version}" must be a number`);
      const key = Buffer.from(String(b64), 'base64');
      if (key.length !== 32) throw new Error(`Key version ${version} must be 32 bytes, base64 encoded`);
      ring.set(version, key);
    }
  }
  let active = env.TOKEN_ENC_ACTIVE ? String(env.TOKEN_ENC_ACTIVE) : [...ring.keys()].sort((a, b) => Number(b) - Number(a))[0] || null;
  if (active && !ring.has(active)) throw new Error(`TOKEN_ENC_ACTIVE ${active} is not in TOKEN_ENC_KEYS`);
  const legacy = env.SUPABASE_SERVICE_ROLE_KEY ? sha('gsc:' + env.SUPABASE_SERVICE_ROLE_KEY) : null;
  return { ring, active, legacy };
}

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64'));
}
function open(key, iv, tag, enc, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

const envelopeOn = (env) => env.TOKEN_ENVELOPE === '1' || env.TOKEN_ENVELOPE === 'true';
const ENVELOPE = /^e\d{1,4}$/;
const ctxAad = (context) => (context ? 'ctx:' + context : '');
const kekAad = (version) => 'kek:' + version;

// context: optional text the value is bound to (the project id). Decrypting needs the same context.
function encrypt(plain, env = process.env, context = '') {
  const keys = loadKeyring(env);
  requireIndependentKeys(env, keys);
  const { ring, active, legacy } = keys;
  if (active && envelopeOn(env)) {
    const dek = crypto.randomBytes(32);
    const wrapped = seal(ring.get(active), dek.toString('base64'), kekAad(active));
    return `e${active}.` + wrapped.join('.') + '.' + seal(dek, plain, ctxAad(context)).join('.');
  }
  if (active) return `v${active}.` + seal(ring.get(active), plain).join('.');
  if (!legacy) throw new Error('No encryption key is configured');
  return seal(legacy, plain).join('.');
}

function unwrapDek(parts, ring) {
  const key = ring.get(parts[0].slice(1));
  if (!key) throw new Error('Unknown key version'); // never echo anything about the data or the keys
  return Buffer.from(open(key, parts[1], parts[2], parts[3], kekAad(parts[0].slice(1))), 'base64');
}

function decrypt(blob, env = process.env, context = '') {
  const { ring, legacy } = loadKeyring(env);
  const parts = String(blob || '').split('.');
  if (parts.length === 7 && ENVELOPE.test(parts[0])) return open(unwrapDek(parts, ring), parts[4], parts[5], parts[6], ctxAad(context));
  if (parts.length === 4 && /^v\d{1,4}$/.test(parts[0])) {
    const key = ring.get(parts[0].slice(1));
    if (!key) throw new Error('Unknown key version');
    return open(key, parts[1], parts[2], parts[3]);
  }
  if (parts.length === 3) {
    if (!legacy) throw new Error('No key is available for this value');
    return open(legacy, parts[0], parts[1], parts[2]);
  }
  throw new Error('Unrecognised encrypted value');
}

// True when a stored value should be rewritten: it is not in the current write format under the active key.
function needsReencrypt(blob, env = process.env) {
  const { active } = loadKeyring(env);
  if (!active) return false;
  const parts = String(blob || '').split('.');
  if (envelopeOn(env)) return !(parts.length === 7 && parts[0] === `e${active}`);
  return !(parts.length === 4 && parts[0] === `v${active}`);
}

// Moves an envelope value to the active key by re-wrapping its data key. The plaintext is never produced, and the value's own
// ciphertext is untouched. Anything else (legacy, versioned) is returned as null: use decrypt() + encrypt() for those.
function rewrap(blob, env = process.env) {
  const { ring, active } = loadKeyring(env);
  const parts = String(blob || '').split('.');
  if (!active || !(parts.length === 7 && ENVELOPE.test(parts[0]))) return null;
  if (parts[0] === `e${active}`) return blob;
  const dek = unwrapDek(parts, ring);
  return `e${active}.` + seal(ring.get(active), dek.toString('base64'), kekAad(active)).join('.') + '.' + parts.slice(4).join('.');
}

// ----- signed state for OAuth round trips ------------------------------------------------------------------------------------
// A separate key for signing: STATE_SIGNING_KEY if set, else derived from the active encryption key, else the legacy key.
function signingKey(env = process.env) {
  if (env.STATE_SIGNING_KEY) {
    const k = Buffer.from(env.STATE_SIGNING_KEY, 'base64');
    if (k.length < 32) throw new Error('STATE_SIGNING_KEY must be at least 32 bytes, base64 encoded');
    return k;
  }
  const { ring, active, legacy } = loadKeyring(env);
  if (active) return sha('state:' + ring.get(active).toString('base64'));
  if (isProduction(env)) throw new Error('STATE_SIGNING_KEY or TOKEN_ENC_KEYS is required in production');
  if (!legacy) throw new Error('No signing key is configured');
  return legacy;
}

function signState(payload, env = process.env, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: now + 15 * 60 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', signingKey(env)).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readState(state, env = process.env, now = Date.now()) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', signingKey(env)).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > now ? p : null;
  } catch { return null; }
}

module.exports = { encrypt, decrypt, needsReencrypt, rewrap, signState, readState, loadKeyring, cryptoReady, isProduction };
