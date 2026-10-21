'use strict';
/*
 * Noise XX + transport loopback: the JS initiator and responder run a full
 * handshake with each other, then exchange encrypted transport frames in
 * both directions. (Byte-level interop with the SDK's own Python
 * implementation is covered separately in test-interop.js.)
 */
const assert = require('assert');
const { loadModules, test } = require('./helpers');

const MG = loadModules();
const u = MG.util;
const noise = MG.noise;
const transport = MG.transport;
const framing = MG.framing;

function handshake(responderPayload) {
  const ini = new noise.NoiseXXInitiator();
  ini.initialize();
  const res = new noise.NoiseXXResponder(responderPayload || new Uint8Array(0));
  res.initialize();
  const m1 = ini.writeMessage1();
  assert.strictEqual(m1.length, 32);
  const m2 = res.readMessage1AndWriteMessage2(m1);
  const payload = ini.readMessage2(m2);
  const m3 = ini.writeMessage3();
  assert.strictEqual(m3.length, 64);
  res.readMessage3(m3);
  assert.strictEqual(u.toHex(ini.handshakeHash()), u.toHex(res.handshakeHash()));
  assert.ok(ini.remoteStaticPublicKey());
  const [iSend, iRecv] = ini.split();
  const [rSend, rRecv] = res.split();
  return {
    payload,
    iniTransport: new transport.NoiseTransport(iSend, iRecv),
    resCiphers: { send: rSend, recv: rRecv },
  };
}

test('noise: initiator/responder loopback handshake with payload', () => {
  const { payload } = handshake(u.utf8Encode('server-hello'));
  assert.strictEqual(u.utf8Decode(payload), 'server-hello');
});

test('noise: handshake state machine rejects out-of-order calls', () => {
  const ini = new noise.NoiseXXInitiator();
  assert.throws(() => ini.writeMessage1(), /wrong phase/);
  ini.initialize();
  assert.throws(() => ini.readMessage2(new Uint8Array(96)), /wrong phase/);
  const m1 = ini.writeMessage1();
  assert.throws(() => ini.readMessage2(new Uint8Array(10)), /too short/);
  void m1;
});

test('noise: transport round trip, initiator -> responder decode', () => {
  const { iniTransport, resCiphers } = handshake();
  const enc = iniTransport.startStreamRequest('POST', '/link-control');
  assert.strictEqual(enc.streamId, 1);
  const decoder = new framing.NoiseFrameDecoder();
  let frame = null;
  for (const wire of enc.frames) {
    const plain = resCiphers.recv.decryptWithAd(new Uint8Array(0), wire);
    const msg = decoder.decode(plain);
    if (msg) frame = transport.decodeRequestEnvelope(msg);
  }
  assert.strictEqual(frame.kind, 'request');
  assert.strictEqual(frame.value.verb, 'POST');
  assert.strictEqual(frame.value.path, '/link-control');
  assert.strictEqual(frame.value.endBody, false);
});

test('noise: transport round trip, responder -> initiator decryptFrame', () => {
  const { iniTransport, resCiphers } = handshake();
  const respFrame = {
    streamId: 1, kind: 'response',
    value: { status: 200, headers: [], body: u.utf8Encode('ok'), endBody: true },
  };
  const bytes = transport.encodeResponseEnvelope(respFrame);
  let got = null;
  for (const chunk of framing.encodeNoiseFrames(bytes)) {
    const wire = resCiphers.send.encryptWithAd(new Uint8Array(0), chunk);
    const df = iniTransport.decryptFrame(wire);
    if (df) got = df;
  }
  assert.strictEqual(got.kind, 'response');
  assert.strictEqual(got.value.status, 200);
  assert.strictEqual(u.utf8Decode(got.value.body), 'ok');
  assert.strictEqual(got.value.endBody, true);
});

test('noise: multi-chunk message (200 KB) reassembles intact', () => {
  const { iniTransport, resCiphers } = handshake();
  const body = u.randomBytes(200 * 1024);
  const enc = iniTransport.encryptHttpRequest('POST', '/chat/stream', body);
  assert.ok(enc.frames.length >= 4, 'expected >= 4 frames, got ' + enc.frames.length);
  const decoder = new framing.NoiseFrameDecoder();
  let frame = null;
  for (const wire of enc.frames) {
    const plain = resCiphers.recv.decryptWithAd(new Uint8Array(0), wire);
    const msg = decoder.decode(plain);
    if (msg) frame = transport.decodeRequestEnvelope(msg);
  }
  assert.strictEqual(frame.value.body.length, body.length);
  assert.ok(u.bytesEqual(frame.value.body, body));
});

test('noise: tampered transport frame poisons the transport', () => {
  const { iniTransport, resCiphers } = handshake();
  const respFrame = {
    streamId: 1, kind: 'response',
    value: { status: 200, headers: [], body: new Uint8Array(0), endBody: true },
  };
  const bytes = transport.encodeResponseEnvelope(respFrame);
  const wire = resCiphers.send.encryptWithAd(new Uint8Array(0), framing.encodeNoiseFrames(bytes)[0]);
  const bad = new Uint8Array(wire);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => iniTransport.decryptFrame(bad));
  assert.throws(() => iniTransport.decryptFrame(wire), /dead after prior failure/);
});

test('noise: stream ids increment from 1', () => {
  const { iniTransport } = handshake();
  assert.strictEqual(iniTransport.startStreamRequest('POST', '/a').streamId, 1);
  assert.strictEqual(iniTransport.encryptHttpRequest('POST', '/b', new Uint8Array(0)).streamId, 2);
  assert.strictEqual(iniTransport.startStreamRequest('POST', '/c').streamId, 3);
});
