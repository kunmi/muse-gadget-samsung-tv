'use strict';
/*
 * Golden-byte tests: expected values in this file were produced by running
 * Meta's Muse Gadget SDK Python code itself (linux/src/musegadget) and are
 * reproduced verbatim here, so the JS ports are checked against the SDK's
 * own output, byte for byte.
 */
const assert = require('assert');
const { loadModules, test } = require('./helpers');

const MG = loadModules();
const u = MG.util;
const proto = MG.proto;
const envelope = MG.envelope;
const framing = MG.framing;
const controlFraming = MG.controlFraming;
const transport = MG.transport;

test('goldens: link_client.encode_message register bytes', () => {
  const bytes = controlFraming.encodeMessage({
    type: 'req', id: 'test-id', method: 'link.register', params: { node_id: 'homelink-abcdef' },
  });
  assert.strictEqual(u.toHex(bytes),
    '5d0000007b2274797065223a22726571222c226964223a22746573742d6964222c226d6574686f64223a226c696e6b2e7265676973746572222c22706172616d73223a7b226e6f64655f6964223a22686f6d656c696e6b2d616263646566227d7d');
});

test('goldens: ServiceFrame + ServiceRequest for POST /link-control', () => {
  const frame = {
    streamId: 1, kind: 'request',
    value: { verb: 'POST', path: '/link-control', headers: [], body: new Uint8Array(0), endBody: false },
  };
  assert.strictEqual(u.toHex(envelope.encodeServiceFrame(frame)),
    '080112150a04504f5354120d2f6c696e6b2d636f6e74726f6c');
  assert.strictEqual(
    u.toHex(envelope.encodeServiceRequest({ service: 0, payload: envelope.encodeServiceFrame(frame) })),
    '1219080112150a04504f5354120d2f6c696e6b2d636f6e74726f6c');
  // And the transport produces exactly those bytes as its payload core.
  const decoded = transport.decodeRequestEnvelope(u.fromHex(
    '1219080112150a04504f5354120d2f6c696e6b2d636f6e74726f6c'));
  assert.deepStrictEqual(
    { streamId: decoded.streamId, kind: decoded.kind, verb: decoded.value.verb, path: decoded.value.path, endBody: decoded.value.endBody },
    { streamId: 1, kind: 'request', verb: 'POST', path: '/link-control', endBody: false });
});

test('goldens: chat request envelope with headers and inline body', () => {
  const frame = {
    streamId: 2, kind: 'request',
    value: {
      verb: 'POST', path: '/chat/stream',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'x-app-id', value: 'musegadget' },
      ],
      body: u.utf8Encode('{"message":"hi"}'), endBody: true,
    },
  };
  assert.strictEqual(
    u.toHex(envelope.encodeServiceRequest({ service: 0, payload: envelope.encodeServiceFrame(frame) })),
    '1266080212620a04504f5354120c2f636861742f73747265616d1a200a0c436f6e74656e742d5479706512106170706c69636174696f6e2f6a736f6e1a160a08782d6170702d6964120a6d75736567616467657422107b226d657373616765223a226869227d2801');
});

test('goldens: NoiseTransportFrame with fixed and negative chunk ids', () => {
  const fixed = framing.encodeNoiseFrame({
    chunkId: 0x0102030405060708n, chunkIndex: 0, totalChunks: 1, payload: u.utf8Encode('hello'),
  });
  assert.strictEqual(u.toHex(fixed), '08888e98a8c0e08081011801220568656c6c6f');
  const neg = framing.encodeNoiseFrame({
    chunkId: -2n, chunkIndex: 3, totalChunks: 5, payload: new Uint8Array(0),
  });
  assert.strictEqual(u.toHex(neg), '08feffffffffffffffff0110031805');
  const decoded = framing.decodeNoiseFrame(u.fromHex('08feffffffffffffffff0110031805'));
  assert.strictEqual(decoded.chunkId, -2n);
  assert.strictEqual(decoded.chunkIndex, 3);
  assert.strictEqual(decoded.totalChunks, 5);
});

test('goldens: encode_noise_frames chunking of a 70000-byte payload', () => {
  const payload = new Uint8Array(70000).fill(0x41);
  const frames = framing.encodeNoiseFrames(payload, 42n);
  assert.strictEqual(frames.length, 2);
  // First frame header bytes from the SDK: chunk_id 42, total_chunks 2,
  // payload length prefix 65489 (varint d1 ff 03).
  assert.strictEqual(u.toHex(frames[0].subarray(0, 9)), '082a180222d1ff0341');
  assert.strictEqual(frames[0].length, 9 - 1 + 65489); // header incl. first payload byte counted above
  const dec = new framing.NoiseFrameDecoder();
  assert.strictEqual(dec.decode(frames[0]), null);
  const whole = dec.decode(frames[1]);
  assert.strictEqual(whole.length, 70000);
  assert.ok(whole.every((b) => b === 0x41));
});

test('goldens: response envelope and reset frame bytes', () => {
  const resp = {
    streamId: 1, kind: 'response',
    value: { status: 200, headers: [], body: u.utf8Encode('ok'), endBody: true },
  };
  assert.strictEqual(u.toHex(transport.encodeResponseEnvelope(resp)),
    '0a0d08011a0908c8011a026f6b2001');
  const reset = {
    streamId: 7, kind: 'reset',
    value: { code: envelope.ResetCode.CANCELLED, reason: 'consumer closed' },
  };
  assert.strictEqual(u.toHex(envelope.encodeServiceFrame(reset)),
    '08072a130801120f636f6e73756d657220636c6f736564');
});

test('goldens: body-chunk frame carrying a link.result', () => {
  const data = controlFraming.encodeMessage({
    method: 'link.result', id: 'inv-1', ok: true, payload: { shown: true },
  });
  const frame = { streamId: 1, kind: 'body_chunk', value: { data: data, endBody: false } };
  assert.strictEqual(u.toHex(envelope.encodeServiceFrame(frame)),
    '0801224e0a4c480000007b226d6574686f64223a226c696e6b2e726573756c74222c226964223a22696e762d31222c226f6b223a747275652c227061796c6f6164223a7b2273686f776e223a747275657d7d');
});

test('proto: varint round trips across the u64 range', () => {
  const values = [0n, 1n, 127n, 128n, 300n, 16384n, (1n << 32n) - 1n, 1n << 32n,
    (1n << 63n) - 1n, (1n << 64n) - 1n];
  for (const v of values) {
    const encoded = proto.encodeVarint(v);
    const read = proto.readVarint(encoded, 0);
    assert.strictEqual(read.value, v);
    assert.strictEqual(read.offset, encoded.length);
  }
  assert.throws(() => proto.encodeVarint(-1n), /non-negative/);
  assert.strictEqual(proto.decodeInt64((1n << 64n) - 2n), -2n);
  // int32 values arrive sign-extended to 64 bits, as in _proto.py: the raw
  // 0xffffffff is out of range, the sign-extended form decodes to -1.
  assert.strictEqual(proto.decodeInt32((1n << 64n) - 1n), -1);
  assert.throws(() => proto.decodeInt32(0xffffffffn), /out of range/);
});
