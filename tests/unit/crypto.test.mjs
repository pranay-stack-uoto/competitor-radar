import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import c from '../../lib/security/crypto.js';

const key = () => nodeCrypto.randomBytes(32).toString('base64');
// NODE_ENV 'test': the legacy key is only allowed outside production (see the production tests at the end of this file).
const ENV_LEGACY = { NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_example_service_key' };
const ENV_V1 = { ...ENV_LEGACY, TOKEN_ENC_KEYS: JSON.stringify({ 1: key() }) };

// The exact algorithm the application used before versioned keys, so existing stored tokens must still open.
function oldEncrypt(text, serviceKey) {
  const k = nodeCrypto.createHash('sha256').update('gsc:' + serviceKey).digest();
  const iv = nodeCrypto.randomBytes(12), cipher = nodeCrypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

test('with no new keys configured, behaviour is unchanged (legacy format, round trip)', () => {
  const blob = c.encrypt('refresh-token-123', ENV_LEGACY);
  assert.equal(blob.split('.').length, 3);
  assert.equal(c.decrypt(blob, ENV_LEGACY), 'refresh-token-123');
});
test('tokens stored by the old code still decrypt', () => {
  assert.equal(c.decrypt(oldEncrypt('old-token', ENV_LEGACY.SUPABASE_SERVICE_ROLE_KEY), ENV_V1), 'old-token');
});
test('with keys configured, new writes are versioned and independent of the service key', () => {
  const blob = c.encrypt('t', ENV_V1);
  assert.match(blob, /^v1\./);
  const noServiceKey = { TOKEN_ENC_KEYS: ENV_V1.TOKEN_ENC_KEYS };
  assert.equal(c.decrypt(blob, noServiceKey), 't'); // rotating the database key does not break stored tokens
});
test('rotation: a new active key writes v2, v1 data stays readable, and is flagged for re-encryption', () => {
  const k1 = JSON.parse(ENV_V1.TOKEN_ENC_KEYS)[1];
  const env2 = { ...ENV_LEGACY, TOKEN_ENC_KEYS: JSON.stringify({ 1: k1, 2: key() }) };
  const v1blob = c.encrypt('x', ENV_V1);
  assert.match(c.encrypt('y', env2), /^v2\./);
  assert.equal(c.decrypt(v1blob, env2), 'x');
  assert.equal(c.needsReencrypt(v1blob, env2), true);
  assert.equal(c.needsReencrypt(c.encrypt('z', env2), env2), false);
  assert.equal(c.needsReencrypt(oldEncrypt('q', ENV_LEGACY.SUPABASE_SERVICE_ROLE_KEY), env2), true);
  assert.equal(c.needsReencrypt('anything', ENV_LEGACY), false); // nothing to migrate to yet
});
test('TOKEN_ENC_ACTIVE can pin the version used for writes', () => {
  const env = { TOKEN_ENC_KEYS: JSON.stringify({ 1: key(), 2: key() }), TOKEN_ENC_ACTIVE: '1' };
  assert.match(c.encrypt('t', env), /^v1\./);
});
test('tampering with the ciphertext, tag or iv is detected', () => {
  const blob = c.encrypt('secret', ENV_V1).split('.');
  for (const i of [1, 2, 3]) {
    const bad = [...blob]; const raw = Buffer.from(bad[i], 'base64'); raw[0] ^= 1; bad[i] = raw.toString('base64');
    assert.throws(() => c.decrypt(bad.join('.'), ENV_V1), undefined, `part ${i}`);
  }
});
test('an unknown key version or a garbled value fails without revealing anything', () => {
  const blob = c.encrypt('secret', ENV_V1).replace(/^v1/, 'v9');
  assert.throws(() => c.decrypt(blob, ENV_V1), /Unknown key version/);
  for (const junk of ['', 'abc', 'a.b', 'v1.a.b', null, undefined]) assert.throws(() => c.decrypt(junk, ENV_V1));
  try { c.decrypt('v9.a.b.c', ENV_V1); } catch (e) { assert.doesNotMatch(e.message, /secret|sb_secret|[A-Za-z0-9+/]{40}/); }
});
test('bad key configuration is rejected loudly', () => {
  assert.throws(() => c.encrypt('x', { TOKEN_ENC_KEYS: '{not json' }), /not valid JSON/);
  assert.throws(() => c.encrypt('x', { TOKEN_ENC_KEYS: JSON.stringify({ 1: 'c2hvcnQ=' }) }), /32 bytes/);
  assert.throws(() => c.encrypt('x', { TOKEN_ENC_KEYS: JSON.stringify({ one: key() }) }), /must be a number/);
  assert.throws(() => c.encrypt('x', { TOKEN_ENC_KEYS: JSON.stringify({ 1: key() }), TOKEN_ENC_ACTIVE: '5' }), /not in TOKEN_ENC_KEYS/);
  assert.throws(() => c.encrypt('x', { NODE_ENV: 'test' }), /No encryption key/);
  assert.throws(() => c.encrypt('x', {}), /required in production/);
});
test('the same plaintext never produces the same ciphertext', () => {
  assert.notEqual(c.encrypt('same', ENV_V1), c.encrypt('same', ENV_V1));
});

// ----- OAuth state ------------------------------------------------------------------------------------------------------
test('state round trip carries the payload', () => {
  const s = c.signState({ projectId: 'p', userId: 'u' }, ENV_V1);
  const r = c.readState(s, ENV_V1);
  assert.equal(r.projectId, 'p'); assert.equal(r.userId, 'u');
});
test('state expires after 15 minutes and rejects tampering and foreign keys', () => {
  const t0 = 1_000_000;
  const s = c.signState({ projectId: 'p' }, ENV_V1, t0);
  assert.ok(c.readState(s, ENV_V1, t0 + 14 * 60_000));
  assert.equal(c.readState(s, ENV_V1, t0 + 16 * 60_000), null);
  const [body, sig] = s.split('.');
  const forged = Buffer.from(JSON.stringify({ projectId: 'other', exp: t0 + 99_999_999 })).toString('base64url');
  assert.equal(c.readState(`${forged}.${sig}`, ENV_V1, t0), null);
  assert.equal(c.readState(s, { TOKEN_ENC_KEYS: JSON.stringify({ 1: key() }) }, t0), null);
  for (const junk of [null, '', 'x', 'a.b', 'a.b.c']) assert.equal(c.readState(junk, ENV_V1), null);
});
test('a dedicated STATE_SIGNING_KEY separates signing from encryption', () => {
  const env = { ...ENV_V1, STATE_SIGNING_KEY: key() };
  const s = c.signState({ a: 1 }, env);
  assert.ok(c.readState(s, env));
  assert.equal(c.readState(s, ENV_V1), null);
  assert.throws(() => c.signState({}, { STATE_SIGNING_KEY: 'c2hvcnQ=' }), /at least 32 bytes/);
});

// ---------------- envelope encryption ----------------
import { createRequire as __cr } from 'node:module';
const __rotate = __cr(import.meta.url)('../../lib/security/rotate.js');
const ENV_E1 = { ...ENV_V1, TOKEN_ENVELOPE: '1' };
const KEY2 = key();
const ring2 = (a) => ({ TOKEN_ENC_KEYS: JSON.stringify({ 1: JSON.parse(ENV_V1.TOKEN_ENC_KEYS)['1'], 2: KEY2 }), TOKEN_ENC_ACTIVE: a, TOKEN_ENVELOPE: '1' });

test('envelope off (the default): the written format does not change, so a rollback stays safe', () => {
  assert.match(c.encrypt('t', ENV_V1), /^v1\./);
  assert.match(c.encrypt('t', ENV_V1, 'project-1'), /^v1\./);
});
test('envelope on: a random data key per value, wrapped by the ring key; round trip; every value differs', () => {
  const a = c.encrypt('refresh-token', ENV_E1, 'p1');
  assert.match(a, /^e1\.[^.]+\.[^.]+\.[^.]+\.[^.]+\.[^.]+\.[^.]+$/);
  assert.equal(c.decrypt(a, ENV_E1, 'p1'), 'refresh-token');
  const b = c.encrypt('refresh-token', ENV_E1, 'p1');
  const [ca, cb] = [a.split('.'), b.split('.')];
  assert.notEqual(ca[3], cb[3], 'different data key each time'); assert.notEqual(ca[6], cb[6]);
  assert.doesNotMatch(a, /refresh-token/);
});
test('a value is bound to its context: copied onto another project it will not decrypt', () => {
  const a = c.encrypt('secret', ENV_E1, 'project-A');
  assert.throws(() => c.decrypt(a, ENV_E1, 'project-B'));
  assert.throws(() => c.decrypt(a, ENV_E1));
  assert.equal(c.decrypt(a, ENV_E1, 'project-A'), 'secret');
});
test('every part of an envelope value is authenticated', () => {
  const parts = c.encrypt('secret', ENV_E1, 'p').split('.');
  for (let i = 1; i < parts.length; i++) {
    const bad = [...parts]; const buf = Buffer.from(bad[i], 'base64'); buf[0] ^= 1; bad[i] = buf.toString('base64');
    assert.throws(() => c.decrypt(bad.join('.'), ENV_E1, 'p'), undefined, `part ${i}`);
  }
  assert.throws(() => c.decrypt(parts.join('.').replace(/^e1/, 'e9'), ENV_E1, 'p'), /Unknown key version/);
  assert.throws(() => c.decrypt(parts.join('.').replace(/^e1/, 'e2'), ring2('2'), 'p'), undefined, 'the wrapping key version is part of what is authenticated');
});
test('all older formats stay readable when envelope is on', () => {
  assert.equal(c.decrypt(c.encrypt('v', ENV_V1), ENV_E1, 'p'), 'v');
  assert.equal(c.decrypt(oldEncrypt('old', ENV_LEGACY.SUPABASE_SERVICE_ROLE_KEY), { ...ENV_E1, SUPABASE_SERVICE_ROLE_KEY: ENV_LEGACY.SUPABASE_SERVICE_ROLE_KEY }, 'p'), 'old');
});
test('needsReencrypt follows the write format and the active key', () => {
  const v = c.encrypt('x', ENV_V1), e = c.encrypt('x', ENV_E1, 'p');
  assert.equal(c.needsReencrypt(v, ENV_V1), false); assert.equal(c.needsReencrypt(e, ENV_V1), true, 'envelope off: move back to the plain versioned format');
  assert.equal(c.needsReencrypt(v, ENV_E1), true); assert.equal(c.needsReencrypt(e, ENV_E1), false);
  assert.equal(c.needsReencrypt(e, ring2('2')), true, 'a newer active ring key');
});
test('rewrap moves a value to the new ring key without touching its ciphertext, and the old key can then be retired', () => {
  const old = c.encrypt('keep-me', ring2('1'), 'p');
  const moved = c.rewrap(old, ring2('2'));
  assert.match(moved, /^e2\./);
  assert.deepEqual(moved.split('.').slice(4), old.split('.').slice(4), 'the data ciphertext is byte-for-byte unchanged');
  assert.notEqual(moved.split('.')[3], old.split('.')[3]);
  assert.equal(c.decrypt(moved, ring2('2'), 'p'), 'keep-me');
  const onlyNew = { TOKEN_ENC_KEYS: JSON.stringify({ 2: JSON.parse(ring2('2').TOKEN_ENC_KEYS)['2'] }), TOKEN_ENC_ACTIVE: '2', TOKEN_ENVELOPE: '1' };
  assert.equal(c.decrypt(moved, onlyNew, 'p'), 'keep-me', 'ring key 1 is no longer needed');
  assert.throws(() => c.decrypt(old, onlyNew, 'p'), /Unknown key version/);
  assert.equal(c.rewrap(moved, ring2('2')), moved, 'already current');
  assert.equal(c.rewrap(c.encrypt('x', ENV_V1), ring2('2')), null, 'only envelope values are rewrapped');
});
test('rotateValue: plain, versioned and old-ring values all end up in the current format; a current value is left alone', () => {
  const ENV = ring2('2');
  const plain = oldEncrypt('legacy-token', ENV_LEGACY.SUPABASE_SERVICE_ROLE_KEY);
  const withLegacyKey = { ...ENV, SUPABASE_SERVICE_ROLE_KEY: ENV_LEGACY.SUPABASE_SERVICE_ROLE_KEY };
  let r = __rotate.rotateValue(plain, 'p', withLegacyKey); assert.equal(r.how, 'reencrypt'); assert.match(r.blob, /^e2\./); assert.equal(c.decrypt(r.blob, ENV, 'p'), 'legacy-token');
  r = __rotate.rotateValue(c.encrypt('v1-token', { ...ring2('1'), TOKEN_ENVELOPE: '0' }, 'p'), 'p', ENV); assert.equal(r.how, 'reencrypt'); assert.equal(c.decrypt(r.blob, ENV, 'p'), 'v1-token');
  r = __rotate.rotateValue(c.encrypt('e1-token', ring2('1'), 'p'), 'p', ENV); assert.equal(r.how, 'rewrap'); assert.equal(c.decrypt(r.blob, ENV, 'p'), 'e1-token');
  const cur = c.encrypt('now', ENV, 'p'); r = __rotate.rotateValue(cur, 'p', ENV); assert.equal(r.how, 'skip'); assert.equal(r.blob, cur);
  assert.throws(() => __rotate.rotateValue(c.encrypt('x', ring2('1'), 'right'), 'wrong-project', ENV), 'a mismatched context is an error, never a silent re-encryption');
});

// ---------------- production requires independent keys ----------------
const crypto2 = nodeCrypto;
const SERVICE = 'sb_secret_production_service_key';
const PROD_LEGACY = { NODE_ENV: 'production', SUPABASE_SERVICE_ROLE_KEY: SERVICE };
const derivedKey = () => crypto2.createHash('sha256').update('gsc:' + SERVICE).digest('base64'); // what the old code used
const PROD_KEYS = { ...PROD_LEGACY, TOKEN_ENC_KEYS: JSON.stringify({ 1: key() }) };

test('production without TOKEN_ENC_KEYS refuses to encrypt, even though a service-role key exists', () => {
  assert.throws(() => c.encrypt('new-token', PROD_LEGACY), /TOKEN_ENC_KEYS is required in production/);
  assert.throws(() => c.encrypt('new-token', { SUPABASE_SERVICE_ROLE_KEY: SERVICE }), /required in production/, 'an unset NODE_ENV counts as production');
  assert.throws(() => c.encrypt('new-token', { ...PROD_LEGACY, TOKEN_ENC_KEYS: '{}' }), /required in production/, 'an empty key ring is no key');
  assert.throws(() => c.encrypt('new-token', { ...PROD_LEGACY, TOKEN_ENC_KEYS: '' }), /required in production/);
});
test('production with a malformed key configuration fails closed and never falls back to the legacy key', () => {
  for (const bad of ['{not json', JSON.stringify({ 1: 'c2hvcnQ=' }), JSON.stringify({ one: key() }), JSON.stringify({ 1: 'not-base64-!!!' }), JSON.stringify([key()])]) {
    assert.throws(() => c.encrypt('x', { ...PROD_LEGACY, TOKEN_ENC_KEYS: bad }), undefined, bad);
  }
  assert.throws(() => c.encrypt('x', { ...PROD_KEYS, TOKEN_ENC_ACTIVE: '7' }), /not in TOKEN_ENC_KEYS/);
});
test('production rejects a key ring entry that is just the service-role key run through the old derivation', () => {
  assert.throws(() => c.encrypt('x', { ...PROD_LEGACY, TOKEN_ENC_KEYS: JSON.stringify({ 1: derivedKey() }) }), /must not be derived from the service-role key/);
  assert.throws(() => c.encrypt('x', { ...PROD_LEGACY, TOKEN_ENC_KEYS: JSON.stringify({ 1: key(), 2: derivedKey() }), TOKEN_ENC_ACTIVE: '1' }), /must not be derived/, 'any ring entry, not only the active one');
});
test('production with independent keys writes with them and does not depend on the service-role key at all', () => {
  const blob = c.encrypt('refresh', PROD_KEYS);
  assert.match(blob, /^v1\./);
  const noService = { NODE_ENV: 'production', TOKEN_ENC_KEYS: PROD_KEYS.TOKEN_ENC_KEYS };
  assert.equal(c.decrypt(blob, noService), 'refresh');
  assert.equal(c.decrypt(c.encrypt('r2', { ...noService, TOKEN_ENVELOPE: '1' }, 'p1'), { ...noService, TOKEN_ENVELOPE: '1' }, 'p1'), 'r2');
  const other = { ...PROD_KEYS, SUPABASE_SERVICE_ROLE_KEY: 'a-rotated-service-key' };
  assert.equal(c.decrypt(blob, other), 'refresh', 'rotating the service-role key does not touch new tokens');
});
test('LEGACY MIGRATION: old values stay readable in production, are flagged, and are rewritten with the independent key', () => {
  const legacyBlob = oldEncrypt('old-refresh-token', SERVICE);
  assert.equal(c.decrypt(legacyBlob, PROD_KEYS), 'old-refresh-token', 'reading needs no write');
  assert.equal(c.decrypt(legacyBlob, PROD_LEGACY), 'old-refresh-token', 'and works even before the keys are installed, so nothing is stranded');
  assert.equal(c.needsReencrypt(legacyBlob, PROD_KEYS), true);
  const r = __rotate.rotateValue(legacyBlob, 'project-1', PROD_KEYS);
  assert.equal(r.how, 'reencrypt'); assert.match(r.blob, /^v1\./);
  const afterRotation = { NODE_ENV: 'production', TOKEN_ENC_KEYS: PROD_KEYS.TOKEN_ENC_KEYS };
  assert.equal(c.decrypt(r.blob, afterRotation), 'old-refresh-token', 'readable with the service-role key gone');
  assert.throws(() => c.decrypt(legacyBlob, afterRotation), /No key is available/, 'the old copy no longer opens without the service key');
  assert.equal(c.needsReencrypt(r.blob, PROD_KEYS), false);
  // Without independent keys nothing is rewritten (and never as another legacy value).
  assert.deepEqual(__rotate.rotateValue(legacyBlob, 'project-1', PROD_LEGACY), { blob: legacyBlob, how: 'skip' });
});
test('ROTATION in production keeps working: new ring version, rewrap under envelope, old version retired', () => {
  const k1 = key(), k2 = key();
  const ring1 = { NODE_ENV: 'production', TOKEN_ENC_KEYS: JSON.stringify({ 1: k1 }), TOKEN_ENVELOPE: '1' };
  const ring12 = { NODE_ENV: 'production', TOKEN_ENC_KEYS: JSON.stringify({ 1: k1, 2: k2 }), TOKEN_ENC_ACTIVE: '2', TOKEN_ENVELOPE: '1' };
  const ring2 = { NODE_ENV: 'production', TOKEN_ENC_KEYS: JSON.stringify({ 2: k2 }), TOKEN_ENVELOPE: '1' };
  const stored = c.encrypt('keep', ring1, 'proj');
  assert.equal(c.decrypt(stored, ring12, 'proj'), 'keep');
  const moved = __rotate.rotateValue(stored, 'proj', ring12);
  assert.equal(moved.how, 'rewrap'); assert.match(moved.blob, /^e2\./);
  assert.equal(c.decrypt(moved.blob, ring2, 'proj'), 'keep');
});
test('the OAuth state signer also refuses legacy keys in production, but accepts a dedicated signing key', () => {
  assert.throws(() => c.signState({ a: 1 }, PROD_LEGACY), /required in production/);
  const signKey = key();
  const withSign = { ...PROD_LEGACY, STATE_SIGNING_KEY: signKey };
  assert.deepEqual({ ...c.readState(c.signState({ a: 1 }, withSign), withSign) }.a, 1);
  assert.deepEqual(c.readState(c.signState({ a: 2 }, PROD_KEYS), PROD_KEYS).a, 2);
  assert.throws(() => c.readState('x.y', PROD_LEGACY), /required in production/, 'verification fails closed too');
  assert.equal(c.readState(c.signState({ a: 1 }, { ...ENV_LEGACY }), { ...ENV_LEGACY }).a, 1, 'development keeps working locally');
});
test('cryptoReady tells the app whether Search Console may store tokens', () => {
  assert.equal(c.cryptoReady(PROD_KEYS), true);
  assert.equal(c.cryptoReady(PROD_LEGACY), false);
  assert.equal(c.cryptoReady({ ...PROD_LEGACY, TOKEN_ENC_KEYS: '{bad' }), false);
  assert.equal(c.cryptoReady({ ...PROD_LEGACY, TOKEN_ENC_KEYS: JSON.stringify({ 1: derivedKey() }) }), false);
  assert.equal(c.cryptoReady(ENV_LEGACY), true, 'development');
});
test('a key ring given as a JSON array, string or number is rejected, not read as version 0', () => {
  for (const bad of [JSON.stringify([key()]), JSON.stringify(key()), '5', 'null']) assert.throws(() => c.encrypt('x', { NODE_ENV: 'test', TOKEN_ENC_KEYS: bad }), undefined, bad);
});
