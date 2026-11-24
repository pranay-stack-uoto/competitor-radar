import { test } from 'node:test';
import assert from 'node:assert/strict';
import v from '../../lib/security/validate.js';

const { HttpError, isUuid, bearerToken, readJsonBody, needUuid, needString, safeEqual } = v;
const req = (body, headers = {}) => new Request('http://x/', { method: 'POST', body, headers });

test('isUuid accepts real UUIDs and nothing else', () => {
  assert.equal(isUuid('3b241101-e2bb-4255-8caf-4136c566a962'), true);
  assert.equal(isUuid('3B241101-E2BB-4255-8CAF-4136C566A962'), true);
  for (const x of ['', 'abc', '3b241101e2bb42558caf4136c566a962', "3b241101-e2bb-4255-8caf-4136c566a962' or 1=1", '3b241101-e2bb-4255-8caf-4136c566a96', null, 5, {}, ['3b241101-e2bb-4255-8caf-4136c566a962']]) assert.equal(isUuid(x), false, String(x));
});
test('bearerToken is strict', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi-1234567890'), 'abc.def.ghi-1234567890');
  for (const x of [null, '', 'Bearer', 'Bearer ', 'bearer abcdefghijkl', 'Basic abcdefghijkl', 'Bearer abc', 'Bearer a b c d e f g h i j', 'Bearer ' + 'a'.repeat(5000), ' Bearer abcdefghijkl']) assert.equal(bearerToken(x), null, String(x));
});
test('readJsonBody returns objects only and enforces the size cap', async () => {
  assert.deepEqual(await readJsonBody(req('{"a":1}')), { a: 1 });
  assert.deepEqual(await readJsonBody(req('')), {});
  for (const bad of ['[1]', '"x"', '5', 'null', '{bad', 'true']) await assert.rejects(readJsonBody(req(bad)), (e) => e instanceof HttpError && e.status === 400, bad);
  await assert.rejects(readJsonBody(req('{"a":"' + 'x'.repeat(20000) + '"}')), (e) => e.status === 413);
  await assert.rejects(readJsonBody(req('{}', { 'content-length': '999999' })), (e) => e.status === 413);
  assert.deepEqual(await readJsonBody(req('{"a":"' + 'x'.repeat(100) + '"}'), { maxBytes: 1000 }).then((r) => Object.keys(r)), ['a']);
});
test('needUuid and needString validate and normalise', () => {
  assert.equal(needUuid('3B241101-E2BB-4255-8CAF-4136C566A962'), '3b241101-e2bb-4255-8caf-4136c566a962');
  assert.throws(() => needUuid('nope'), (e) => e.status === 400);
  assert.equal(needString('  hi  ', { max: 10 }), 'hi');
  for (const bad of [5, null, undefined, '', '   ', 'x'.repeat(11)]) assert.throws(() => needString(bad, { max: 10 }), (e) => e.status === 400, String(bad));
});
test('safeEqual compares secrets without leaking length or short-circuiting', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual(undefined, undefined), true); // callers must check the secret is configured first
});

// ---------------- the body is bounded while it is read ----------------
const streamReq = (chunks, headers = {}, onCancel) => {
  let i = 0;
  const body = new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(typeof chunks[i] === 'string' ? new TextEncoder().encode(chunks[i++]) : chunks[i++]); else c.close(); }, cancel() { onCancel?.(); } });
  return new Request('https://x.example.com/api', { method: 'POST', body, duplex: 'half', headers });
};
test('a body without Content-Length is still capped', async () => {
  const big = streamReq(['{"a":"', 'x'.repeat(9000), 'x'.repeat(9000), '"}']);
  assert.equal(big.headers.get('content-length'), null);
  await assert.rejects(readJsonBody(big), (e) => e.status === 413);
  assert.deepEqual(await readJsonBody(streamReq(['{"a"', ':1}'])), { a: 1 }, 'a small chunked body works');
});
test('a lying Content-Length (too small) does not let a larger body through', async () => {
  await assert.rejects(readJsonBody(streamReq(['{"a":"', 'x'.repeat(40000), '"}'], { 'content-length': '10' })), (e) => e.status === 413);
});
test('a huge Content-Length is refused before reading, and the stream is cancelled', async () => {
  let cancelled = false, pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  const r = new Request('https://x.example.com/api', { method: 'POST', body, duplex: 'half', headers: { 'content-length': '99999999' } });
  await assert.rejects(readJsonBody(r), (e) => e.status === 413);
  assert.equal(cancelled, true);
  assert.ok(pulled <= 2, `read ${pulled} chunks before refusing`);
});
test('an endless stream is stopped and cancelled shortly after the limit, without buffering it', async () => {
  let cancelled = false, pulled = 0;
  const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(4096).fill(120)); }, cancel() { cancelled = true; } });
  const r = new Request('https://x.example.com/api', { method: 'POST', body, duplex: 'half' });
  await assert.rejects(readJsonBody(r, { maxBytes: 16 * 1024 }), (e) => e.status === 413);
  assert.equal(cancelled, true, 'the source was told to stop');
  assert.ok(pulled <= 8, `pulled ${pulled} chunks of 4 KiB for a 16 KiB limit`);
});
test('a non-numeric or negative Content-Length is ignored, and the real size still counts', async () => {
  for (const cl of ['abc', '-5', '', 'NaN']) {
    await assert.rejects(readJsonBody(streamReq(['x'.repeat(20000)], { 'content-length': cl })), (e) => e.status === 413, cl);
    assert.deepEqual(await readJsonBody(streamReq(['{"ok":true}'], { 'content-length': cl })), { ok: true }, cl);
  }
});
test('multi-byte characters are counted in bytes, not characters', async () => {
  await assert.rejects(readJsonBody(streamReq(['{"a":"' + 'é'.repeat(9000) + '"}'])), (e) => e.status === 413); // 18 000 bytes
  assert.deepEqual(await readJsonBody(streamReq(['{"a":"é"}'])), { a: 'é' });
});
test('invalid UTF-8 is a 400, a read error is a 400, and an exact-limit body is accepted', async () => {
  await assert.rejects(readJsonBody(streamReq([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])])), (e) => e.status === 400);
  const failing = new ReadableStream({ pull() { throw new Error('socket reset'); } });
  await assert.rejects(readJsonBody(new Request('https://x.example.com/api', { method: 'POST', body: failing, duplex: 'half' })), (e) => e.status === 400);
  const exact = '{"a":"' + 'x'.repeat(1000 - 8) + '"}';
  assert.equal(Buffer.byteLength(exact), 1000);
  assert.equal((await readJsonBody(streamReq([exact]), { maxBytes: 1000 })).a.length, 992);
  await assert.rejects(readJsonBody(streamReq([exact + ' ']), { maxBytes: 1000 }), (e) => e.status === 413);
});
test('requests without a body (GET-like) read as an empty object', async () => {
  assert.deepEqual(await readJsonBody(new Request('https://x.example.com/api')), {});
});
