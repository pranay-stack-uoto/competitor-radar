// Re-protects one stored secret with the current key settings. Pure, so it can be tested; scripts/rotate-token-keys.mjs applies it to the database.
//   envelope value under an older ring key  -> rewrap: only the small data key is re-wrapped, the plaintext is never produced for the write
//   legacy / versioned value, or envelope switched on -> decrypt and encrypt again (bound to the project)
// Before returning, the result is decrypted in memory and compared with the original, so a bad key can never replace a good value.
const { decrypt, encrypt, needsReencrypt, rewrap } = require('./crypto');

function rotateValue(blob, context, env = process.env) {
  if (!needsReencrypt(blob, env)) return { blob, how: 'skip' };
  const original = decrypt(blob, env, context);
  let next = rewrap(blob, env), how = 'rewrap';
  if (!next) { next = encrypt(original, env, context); how = 'reencrypt'; }
  if (decrypt(next, env, context) !== original) throw new Error('Rotation self-check failed; value left unchanged');
  return { blob: next, how };
}
module.exports = { rotateValue };
