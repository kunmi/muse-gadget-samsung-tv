/*
 * Copyright (c) 2026 Muse Gadget TV contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Self-contained cryptographic primitives in pure JavaScript.
 *
 * Why pure JS: Tizen's Chromium cannot be relied on for X25519 in WebCrypto,
 * and the Noise stack in the Muse Gadget SDK (noise/noise_xx.py) is
 * synchronous. Implementing SHA-256, HMAC, HKDF, X25519 and AES-256-GCM
 * directly keeps the port synchronous, identical in behaviour on the TV and
 * in Node, and byte-for-byte testable against the SDK's test vectors.
 *
 * Everything here is a textbook implementation of a public standard:
 *   SHA-256            FIPS 180-4
 *   HMAC / HKDF        RFC 2104 / RFC 5869 (and the Noise HKDF variant)
 *   X25519             RFC 7748
 *   AES-256            FIPS 197 (encrypt direction only; GCM needs no more)
 *   AES-GCM            NIST SP 800-38D
 *
 * These implementations are NOT constant-time. That matches the threat model
 * of a TV gadget port verified for interoperability; see PROTOCOL.md.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;

  /* ---------------- SHA-256 (FIPS 180-4) ---------------- */

  var SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(data) {
    var H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    var len = data.length;
    var total = Math.ceil((len + 9) / 64) * 64;
    var msg = new Uint8Array(total);
    msg.set(data);
    msg[len] = 0x80;
    var dv = new DataView(msg.buffer);
    var bitLen = len * 8;
    dv.setUint32(total - 4, bitLen >>> 0);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
    var w = new Uint32Array(64);
    for (var block = 0; block < total; block += 64) {
      for (var t = 0; t < 16; t++) w[t] = dv.getUint32(block + t * 4);
      for (t = 16; t < 64; t++) {
        var s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
        var s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + temp1) | 0;
        d = c; c = b; b = a; a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (var i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  /* ---------------- HMAC-SHA256 (RFC 2104) ---------------- */

  function hmacSha256(key, data) {
    var k = key;
    if (k.length > 64) k = sha256(k);
    var inner = new Uint8Array(64 + data.length);
    var outer = new Uint8Array(64 + 32);
    for (var i = 0; i < 64; i++) {
      var kb = i < k.length ? k[i] : 0;
      inner[i] = kb ^ 0x36;
      outer[i] = kb ^ 0x5c;
    }
    inner.set(data, 64);
    outer.set(sha256(inner), 64);
    return sha256(outer);
  }

  /* ---------------- HKDF variants ---------------- */

  // The Noise protocol's HKDF (noise_xx.py `_hkdf`): the chaining key is the
  // HMAC key for the "extract" step; outputs chain as in RFC 5869 expand with
  // empty info.
  function hkdfNoise(chainingKey, inputKeyMaterial, numOutputs) {
    if (numOutputs !== 2 && numOutputs !== 3) {
      throw new Error('hkdfNoise supports 2 or 3 outputs');
    }
    var tempKey = hmacSha256(chainingKey, inputKeyMaterial);
    var output1 = hmacSha256(tempKey, new Uint8Array([0x01]));
    var output2 = hmacSha256(tempKey, util.concatBytes(output1, new Uint8Array([0x02])));
    if (numOutputs === 2) return [output1, output2];
    var output3 = hmacSha256(tempKey, util.concatBytes(output2, new Uint8Array([0x03])));
    return [output1, output2, output3];
  }

  // RFC 5869 HKDF-SHA256 extract+expand, as pairing.py uses via HKDF(...).
  function hkdfSha256(ikm, salt, info, length) {
    var prk = hmacSha256(salt, ikm);
    return hkdfExpandSha256(prk, info, length);
  }

  // RFC 5869 expand only, as pairing.py uses via HKDFExpand(...).
  function hkdfExpandSha256(prk, info, length) {
    var out = new Uint8Array(0);
    var prev = new Uint8Array(0);
    var counter = 1;
    while (out.length < length) {
      prev = hmacSha256(prk, util.concatBytes(prev, info, new Uint8Array([counter])));
      out = util.concatBytes(out, prev);
      counter++;
    }
    return out.slice(0, length);
  }

  /* ---------------- X25519 (RFC 7748, BigInt) ---------------- */

  var X25519_P = (1n << 255n) - 19n;

  function modPow(base, exp, mod) {
    var result = 1n;
    var b = base % mod;
    var e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      b = (b * b) % mod;
      e >>= 1n;
    }
    return result;
  }

  function leToBigInt(bytes) {
    var v = 0n;
    for (var i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  }

  function bigIntToLe(v, length) {
    var out = new Uint8Array(length);
    var x = v;
    for (var i = 0; i < length; i++) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }

  // RFC 7748 section 5 Montgomery ladder for Curve25519 (a24 = 121665).
  function x25519(scalarBytes, uBytes) {
    if (scalarBytes.length !== 32 || uBytes.length !== 32) {
      throw new Error('x25519: inputs must be 32 bytes');
    }
    var k = new Uint8Array(scalarBytes);
    k[0] &= 248;
    k[31] &= 127;
    k[31] |= 64;
    var scalar = leToBigInt(k);
    var u = new Uint8Array(uBytes);
    u[31] &= 0x7f; // decodeUCoordinate masks the top bit for X25519
    var x1 = leToBigInt(u) % X25519_P;
    var x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n;
    var swap = 0n;
    var A24 = 121665n;
    function cswap(a, b, bit) {
      // Not constant-time; adequate for this port (see header note).
      return bit === 1 ? [b, a] : [a, b];
    }
    for (var t = 254; t >= 0; t--) {
      var kt = (scalar >> BigInt(t)) & 1n;
      swap ^= kt;
      var r;
      r = cswap(x2, x3, Number(swap)); x2 = r[0]; x3 = r[1];
      r = cswap(z2, z3, Number(swap)); z2 = r[0]; z3 = r[1];
      swap = kt;
      var A = (x2 + z2) % X25519_P;
      var AA = (A * A) % X25519_P;
      var B = (x2 - z2 + X25519_P) % X25519_P;
      var BB = (B * B) % X25519_P;
      var E = (AA - BB + X25519_P) % X25519_P;
      var C = (x3 + z3) % X25519_P;
      var D = (x3 - z3 + X25519_P) % X25519_P;
      var DA = (D * A) % X25519_P;
      var CB = (C * B) % X25519_P;
      var daPlusCb = (DA + CB) % X25519_P;
      var daMinusCb = (DA - CB + X25519_P) % X25519_P;
      x3 = (daPlusCb * daPlusCb) % X25519_P;
      z3 = (x1 * daMinusCb * daMinusCb) % X25519_P;
      x2 = (AA * BB) % X25519_P;
      z2 = (E * ((AA + A24 * E) % X25519_P)) % X25519_P;
    }
    var r2;
    r2 = cswap(x2, x3, Number(swap)); x2 = r2[0];
    r2 = cswap(z2, z3, Number(swap)); z2 = r2[0];
    var result = (x2 * modPow(z2, X25519_P - 2n, X25519_P)) % X25519_P;
    return bigIntToLe(result, 32);
  }

  var X25519_BASEPOINT = new Uint8Array(32);
  X25519_BASEPOINT[0] = 9;

  function x25519GenerateKeyPair() {
    var privateKey = util.randomBytes(32);
    return { privateKey: privateKey, publicKey: x25519(privateKey, X25519_BASEPOINT) };
  }

  // The low-order public keys rejected by noise_xx.py, copied from the SDK.
  var X25519_LOW_ORDER_POINTS = [
    '0000000000000000000000000000000000000000000000000000000000000000',
    '0100000000000000000000000000000000000000000000000000000000000000',
    'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
    '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  ].map(function (h) { return util.fromHex(h); });

  var ALL_ZEROS_32 = new Uint8Array(32);

  function x25519Dh(privateKey, publicKeyBytes) {
    if (publicKeyBytes.length !== 32) throw new Error('x25519: invalid public key length');
    for (var i = 0; i < X25519_LOW_ORDER_POINTS.length; i++) {
      if (util.bytesEqual(publicKeyBytes, X25519_LOW_ORDER_POINTS[i])) {
        throw new Error('x25519: rejected low-order public key');
      }
    }
    var shared = x25519(privateKey, publicKeyBytes);
    if (util.bytesEqual(shared, ALL_ZEROS_32)) {
      throw new Error('x25519: DH produced all-zeros output');
    }
    return shared;
  }

  /* ---------------- AES-256 (FIPS 197, encrypt only) ---------------- */

  var AES_SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
  ]);
  var AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36, 0x6c, 0xd8, 0xab, 0x4d];

  function aes256ExpandKey(key) {
    if (key.length !== 32) throw new Error('AES-256 key must be 32 bytes');
    var Nk = 8, Nr = 14;
    var w = new Uint8Array(16 * (Nr + 1));
    w.set(key);
    var temp = new Uint8Array(4);
    for (var i = Nk; i < 4 * (Nr + 1); i++) {
      temp[0] = w[(i - 1) * 4]; temp[1] = w[(i - 1) * 4 + 1];
      temp[2] = w[(i - 1) * 4 + 2]; temp[3] = w[(i - 1) * 4 + 3];
      if (i % Nk === 0) {
        var t = temp[0];
        temp[0] = AES_SBOX[temp[1]] ^ AES_RCON[i / Nk - 1];
        temp[1] = AES_SBOX[temp[2]];
        temp[2] = AES_SBOX[temp[3]];
        temp[3] = AES_SBOX[t];
      } else if (i % Nk === 4) {
        temp[0] = AES_SBOX[temp[0]]; temp[1] = AES_SBOX[temp[1]];
        temp[2] = AES_SBOX[temp[2]]; temp[3] = AES_SBOX[temp[3]];
      }
      for (var j = 0; j < 4; j++) w[i * 4 + j] = w[(i - Nk) * 4 + j] ^ temp[j];
    }
    return w;
  }

  function aesEncryptBlock(roundKeys, block) {
    var state = new Uint8Array(block);
    function addRoundKey(round) {
      for (var i = 0; i < 16; i++) state[i] ^= roundKeys[round * 16 + i];
    }
    function subBytes() {
      for (var i = 0; i < 16; i++) state[i] = AES_SBOX[state[i]];
    }
    function shiftRows() {
      var t;
      // state is column-major: index = row + 4*col (FIPS 197 layout)
      t = state[1]; state[1] = state[5]; state[5] = state[9]; state[9] = state[13]; state[13] = t;
      t = state[2]; state[2] = state[10]; state[10] = t;
      t = state[6]; state[6] = state[14]; state[14] = t;
      t = state[15]; state[15] = state[11]; state[11] = state[7]; state[7] = state[3]; state[3] = t;
    }
    function xtime(x) { return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0x00)) & 0xff; }
    function mixColumns() {
      for (var c = 0; c < 4; c++) {
        var i = c * 4;
        var a0 = state[i], a1 = state[i + 1], a2 = state[i + 2], a3 = state[i + 3];
        state[i] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        state[i + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        state[i + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        state[i + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
      }
    }
    addRoundKey(0);
    for (var round = 1; round < 14; round++) {
      subBytes(); shiftRows(); mixColumns(); addRoundKey(round);
    }
    subBytes(); shiftRows(); addRoundKey(14);
    return state;
  }

  /* ---------------- AES-256-GCM (NIST SP 800-38D) ---------------- */

  var GHASH_R = 0xe1n << 120n;

  function bytesToBigInt128(bytes, offset) {
    var v = 0n;
    for (var i = 0; i < 16; i++) v = (v << 8n) | BigInt(bytes[offset + i]);
    return v;
  }

  function bigInt128ToBytes(v) {
    var out = new Uint8Array(16);
    var x = v;
    for (var i = 15; i >= 0; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }

  // GF(2^128) multiplication as defined for GHASH (bit-reflected polynomial).
  function ghashMultiply(x, y) {
    var z = 0n;
    var v = y;
    for (var i = 0; i < 128; i++) {
      if ((x >> BigInt(127 - i)) & 1n) z ^= v;
      if (v & 1n) v = (v >> 1n) ^ GHASH_R;
      else v >>= 1n;
    }
    return z;
  }

  function ghash(h, aad, ciphertext) {
    var y = 0n;
    var block;
    var i;
    function absorb(data) {
      for (var off = 0; off < data.length; off += 16) {
        block = new Uint8Array(16);
        block.set(data.subarray(off, Math.min(off + 16, data.length)));
        y = ghashMultiply(y ^ bytesToBigInt128(block, 0), h);
      }
    }
    absorb(aad);
    absorb(ciphertext);
    var lenBlock = new Uint8Array(16);
    var dv = new DataView(lenBlock.buffer);
    var aadBits = aad.length * 8;
    var ctBits = ciphertext.length * 8;
    dv.setUint32(0, Math.floor(aadBits / 0x100000000));
    dv.setUint32(4, aadBits >>> 0);
    dv.setUint32(8, Math.floor(ctBits / 0x100000000));
    dv.setUint32(12, ctBits >>> 0);
    y = ghashMultiply(y ^ bytesToBigInt128(lenBlock, 0), h);
    return bigInt128ToBytes(y);
  }

  function inc32(block) {
    var out = new Uint8Array(block);
    var dv = new DataView(out.buffer);
    dv.setUint32(12, (dv.getUint32(12) + 1) >>> 0);
    return out;
  }

  function gctr(roundKeys, icb, data) {
    var out = new Uint8Array(data.length);
    var cb = icb;
    for (var off = 0; off < data.length; off += 16) {
      var keyStream = aesEncryptBlock(roundKeys, cb);
      var n = Math.min(16, data.length - off);
      for (var i = 0; i < n; i++) out[off + i] = data[off + i] ^ keyStream[i];
      cb = inc32(cb);
    }
    return out;
  }

  // Encrypts with a 12-byte nonce; returns ciphertext || 16-byte tag,
  // matching the layout of Python cryptography's AESGCM.encrypt.
  function aesGcmEncrypt(key, nonce, plaintext, aad) {
    if (nonce.length !== 12) throw new Error('AES-GCM nonce must be 12 bytes');
    var roundKeys = aes256ExpandKey(key);
    var H = aesEncryptBlock(roundKeys, new Uint8Array(16));
    var hInt = bytesToBigInt128(H, 0);
    var J0 = new Uint8Array(16);
    J0.set(nonce);
    J0[15] = 1;
    var ciphertext = gctr(roundKeys, inc32(J0), plaintext);
    var S = ghash(hInt, aad || new Uint8Array(0), ciphertext);
    var tagMask = aesEncryptBlock(roundKeys, J0);
    var tag = new Uint8Array(16);
    for (var i = 0; i < 16; i++) tag[i] = S[i] ^ tagMask[i];
    return util.concatBytes(ciphertext, tag);
  }

  // Decrypts ciphertext || tag; throws on tag mismatch.
  function aesGcmDecrypt(key, nonce, ciphertextAndTag, aad) {
    if (nonce.length !== 12) throw new Error('AES-GCM nonce must be 12 bytes');
    if (ciphertextAndTag.length < 16) throw new Error('AES-GCM input too short');
    var ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
    var tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
    var roundKeys = aes256ExpandKey(key);
    var H = aesEncryptBlock(roundKeys, new Uint8Array(16));
    var hInt = bytesToBigInt128(H, 0);
    var J0 = new Uint8Array(16);
    J0.set(nonce);
    J0[15] = 1;
    var S = ghash(hInt, aad || new Uint8Array(0), ciphertext);
    var tagMask = aesEncryptBlock(roundKeys, J0);
    var expected = new Uint8Array(16);
    for (var i = 0; i < 16; i++) expected[i] = S[i] ^ tagMask[i];
    if (!util.bytesEqual(expected, new Uint8Array(tag))) {
      throw new Error('AES-GCM: tag verification failed');
    }
    return gctr(roundKeys, inc32(J0), ciphertext);
  }

  MG.crypto = {
    sha256: sha256,
    hmacSha256: hmacSha256,
    hkdfNoise: hkdfNoise,
    hkdfSha256: hkdfSha256,
    hkdfExpandSha256: hkdfExpandSha256,
    x25519: x25519,
    x25519GenerateKeyPair: x25519GenerateKeyPair,
    x25519Dh: x25519Dh,
    aes256ExpandKey: aes256ExpandKey,
    aesEncryptBlock: aesEncryptBlock,
    aesGcmEncrypt: aesGcmEncrypt,
    aesGcmDecrypt: aesGcmDecrypt,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.crypto;
})(typeof globalThis !== 'undefined' ? globalThis : this);
