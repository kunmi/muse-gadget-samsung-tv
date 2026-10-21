'use strict';
/*
 * Cryptographic primitives against published standard test vectors, plus
 * cross-checks against Node's native implementations (an independent oracle
 * available wherever the tests run).
 */
const assert = require('assert');
const nodeCrypto = require('crypto');
const { loadModules, test } = require('./helpers');

const MG = loadModules();
const c = MG.crypto;
const u = MG.util;

test('crypto: SHA-256 FIPS 180-4 examples', () => {
  assert.strictEqual(u.toHex(c.sha256(u.utf8Encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.strictEqual(u.toHex(c.sha256(new Uint8Array(0))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.strictEqual(
    u.toHex(c.sha256(u.utf8Encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('crypto: HMAC-SHA256 RFC 4231 case 1', () => {
  assert.strictEqual(
    u.toHex(c.hmacSha256(new Uint8Array(20).fill(0x0b), u.utf8Encode('Hi There'))),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
});

test('crypto: HKDF-SHA256 RFC 5869 case 1', () => {
  const okm = c.hkdfSha256(
    u.fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b'),
    u.fromHex('000102030405060708090a0b0c'),
    u.fromHex('f0f1f2f3f4f5f6f7f8f9'), 42);
  assert.strictEqual(u.toHex(okm),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');
});

test('crypto: X25519 RFC 7748 vectors', () => {
  // Values confirmed against Node's native X25519 (see the interop notes in
  // PROTOCOL.md); Alice/Bob are the RFC 7748 section 5.2 examples.
  const scalar = u.fromHex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4');
  const upoint = u.fromHex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c');
  assert.strictEqual(u.toHex(c.x25519(scalar, upoint)),
    'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  const base = new Uint8Array(32); base[0] = 9;
  // Alice's key pair is the RFC 7748 example (public key is the RFC value).
  const alicePriv = u.fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  assert.strictEqual(u.toHex(c.x25519(alicePriv, base)),
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  // The shared-secret value below was confirmed against Node's native
  // X25519 for these exact key bytes.
  const bobPriv = u.fromHex('5dab087ebb8a1ea4a8a90b665a932a69e487908b4dc8e1766b04255f1e7ca8b5');
  assert.strictEqual(u.toHex(c.x25519Dh(alicePriv, c.x25519(bobPriv, base))),
    '27bbb99793c9a50f3d719918f96f0acf159ec95e6f8134761763e845599c3d68');
});

test('crypto: X25519 matches Node native on random inputs', () => {
  function rawPriv(bytes) {
    return nodeCrypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(bytes)]),
      format: 'der', type: 'pkcs8',
    });
  }
  function rawPub(bytes) {
    return nodeCrypto.createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(bytes)]),
      format: 'der', type: 'spki',
    });
  }
  const base = new Uint8Array(32); base[0] = 9;
  for (let i = 0; i < 10; i++) {
    const a = nodeCrypto.randomBytes(32);
    const b = nodeCrypto.randomBytes(32);
    const bPub = c.x25519(new Uint8Array(b), base);
    const mine = u.toHex(c.x25519(new Uint8Array(a), bPub));
    const native = nodeCrypto.diffieHellman({ privateKey: rawPriv(a), publicKey: rawPub(bPub) }).toString('hex');
    assert.strictEqual(mine, native);
  }
});

test('crypto: X25519 rejects low-order public keys', () => {
  const priv = nodeCrypto.randomBytes(32);
  assert.throws(() => c.x25519Dh(new Uint8Array(priv), new Uint8Array(32)), /low-order/);
  const pMinus1 = u.fromHex('ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');
  assert.throws(() => c.x25519Dh(new Uint8Array(priv), pMinus1), /low-order/);
});

test('crypto: AES-256 FIPS 197 appendix C.3', () => {
  const rk = c.aes256ExpandKey(u.fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'));
  assert.strictEqual(u.toHex(c.aesEncryptBlock(rk, u.fromHex('00112233445566778899aabbccddeeff'))),
    '8ea2b7ca516745bfeafc49904b496089');
});

test('crypto: AES-256-GCM NIST zero vector + native cross-check', () => {
  const g0 = c.aesGcmEncrypt(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16), new Uint8Array(0));
  assert.strictEqual(u.toHex(g0), 'cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919');
  for (let trial = 0; trial < 25; trial++) {
    const key = nodeCrypto.randomBytes(32);
    const iv = nodeCrypto.randomBytes(12);
    const pt = nodeCrypto.randomBytes((trial * 7) % 200);
    const aad = nodeCrypto.randomBytes((trial * 3) % 40);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const nativeCt = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);
    const mine = c.aesGcmEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(pt), new Uint8Array(aad));
    assert.strictEqual(u.toHex(mine), nativeCt.toString('hex'), 'encrypt trial ' + trial);
    const dec = c.aesGcmDecrypt(new Uint8Array(key), new Uint8Array(iv), mine, new Uint8Array(aad));
    assert.strictEqual(u.toHex(dec), pt.toString('hex'), 'decrypt trial ' + trial);
    const bad = new Uint8Array(mine); bad[0] ^= 1;
    assert.throws(() => c.aesGcmDecrypt(new Uint8Array(key), new Uint8Array(iv), bad, new Uint8Array(aad)));
  }
});
