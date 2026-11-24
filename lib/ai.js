// The one place that talks to Claude. Validates the response shape, turns failures into errors the queue can classify,
// and can reuse an answer for an identical prompt (supabase/migrations/0006: ai_cache) so the same question is not paid for twice.
const crypto = require('node:crypto');

const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-5-5';

const keyOf = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

async function rpc(db, fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// Returns the model's text. Throws an Error with .status for HTTP problems and .permanent for missing configuration.
async function askClaude({ prompt, system, model = DEFAULT_MODEL, maxTokens = 800, db, cacheTtlSeconds = 0, fetchFn, signal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('AI is not configured'); e.permanent = true; e.code = 'no-ai-key'; throw e; }
  const key = db && cacheTtlSeconds > 0 ? keyOf({ model, system: system || '', prompt, maxTokens }) : null;
  if (key) { try { const hit = await rpc(db, 'get_ai_cache', { p_key: key }); if (typeof hit === 'string' && hit) return hit; } catch {} } // a cache problem must never block the call

  const doFetch = fetchFn || globalThis.fetch;
  const res = await doFetch(URL_MESSAGES, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: 'user', content: prompt }] }),
    signal, // aborted when the owning job loses its lease
  });
  if (!res.ok) { const e = new Error(`Claude ${res.status}`); e.status = res.status; throw e; }
  let j;
  try { j = await res.json(); } catch { throw new Error('Claude returned something that is not JSON'); }
  const parts = Array.isArray(j && j.content) ? j.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text) : [];
  const text = parts.join('');
  if (!text.trim()) throw new Error('Claude returned an empty answer');
  if (key) { try { await rpc(db, 'put_ai_cache', { p_key: key, p_value: text, p_ttl_seconds: cacheTtlSeconds }); } catch {} }
  return text;
}

// The first JSON object in a model answer, or throws.
function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in the answer');
  const v = JSON.parse(m[0]);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Unexpected JSON shape');
  return v;
}

module.exports = { askClaude, extractJson, keyOf, DEFAULT_MODEL };
