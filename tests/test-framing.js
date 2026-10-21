'use strict';
/*
 * Control-stream framing (little-endian u32 length prefix), following the
 * cases in the SDK's tests/test_link_client.py MessageDecoder tests.
 */
const assert = require('assert');
const { loadModules, test } = require('./helpers');

const MG = loadModules();
const u = MG.util;
const controlFraming = MG.controlFraming;
const framing = MG.framing;

test('framing: round trip of a single message', () => {
  const dec = new controlFraming.MessageDecoder();
  const msgs = dec.feed(controlFraming.encodeMessage({ hello: 'world', n: 42 }));
  assert.strictEqual(msgs.length, 1);
  assert.deepStrictEqual(msgs[0], { hello: 'world', n: 42 });
});

test('framing: batched messages and a keepalive in one buffer', () => {
  const data = u.concatBytes(
    controlFraming.encodeMessage({ a: 1 }),
    controlFraming.encodeMessage({ b: 2 }),
    new Uint8Array(4) // zero length = keepalive
  );
  const dec = new controlFraming.MessageDecoder();
  const msgs = dec.feed(data);
  assert.deepStrictEqual(msgs, [{ a: 1 }, { b: 2 }]);
});

test('framing: a message split across feeds arrives whole', () => {
  const data = controlFraming.encodeMessage({ split: 'across chunks', pad: 'x'.repeat(500) });
  const dec = new controlFraming.MessageDecoder();
  let msgs = [];
  for (let i = 0; i < data.length; i += 7) {
    msgs = msgs.concat(dec.feed(data.subarray(i, i + 7)));
  }
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].pad.length, 500);
});

test('framing: oversize announced length is rejected', () => {
  const dec = new controlFraming.MessageDecoder();
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, controlFraming.MAX_INBOUND_MESSAGE + 1, true);
  assert.throws(() => dec.feed(header), /too large/);
});

test('framing: non-UTF8 garbage is dropped, later messages survive', () => {
  const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x9f]);
  const good = controlFraming.encodeMessage({ b: 2 });
  const framed = new Uint8Array(4 + garbage.length);
  new DataView(framed.buffer).setUint32(0, garbage.length, true);
  framed.set(garbage, 4);
  let malformed = 0;
  const dec = new controlFraming.MessageDecoder(() => { malformed++; });
  const msgs = dec.feed(u.concatBytes(framed, good));
  assert.strictEqual(malformed, 1);
  assert.deepStrictEqual(msgs, [{ b: 2 }]);
});

test('framing: non-object JSON payloads are dropped like the SDK drops them', () => {
  const payload = u.utf8Encode('[1,2,3]');
  const framed = new Uint8Array(4 + payload.length);
  new DataView(framed.buffer).setUint32(0, payload.length, true);
  framed.set(payload, 4);
  const dec = new controlFraming.MessageDecoder();
  assert.deepStrictEqual(dec.feed(framed), []);
});

test('framing: noise chunk decoder rejects a duplicate chunk and poisons', () => {
  const data = u.randomBytes(framing.MAX_CHUNK_PAYLOAD + 10);
  const frames = framing.encodeNoiseFrames(data, 7n);
  assert.strictEqual(frames.length, 2);
  const dec = new framing.NoiseFrameDecoder();
  assert.strictEqual(dec.decode(frames[0]), null);
  assert.throws(() => dec.decode(frames[0]), /duplicate chunkIndex/);
  assert.throws(() => dec.decode(frames[1]), /poisoned/);
});

test('framing: noise chunk decoder enforces chunk payload size', () => {
  const frame = framing.encodeNoiseFrame({
    chunkId: 1n, chunkIndex: 0, totalChunks: 1,
    payload: new Uint8Array(framing.MAX_CHUNK_PAYLOAD + 1),
  });
  const dec = new framing.NoiseFrameDecoder();
  assert.throws(() => dec.decode(frame), /payload too large/);
});
