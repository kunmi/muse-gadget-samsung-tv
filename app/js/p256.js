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
 * Minimal NIST P-256 (secp256r1) arithmetic with BigInt, needed for the
 * pairing v5 ECDH in pairing.js (the device side of pairing.py). Points are
 * Jacobian triples [X, Y, Z] with affine x = X / Z^2, y = Y / Z^3; the point
 * at infinity is Z = 0. Not constant-time (see crypto.js header note).
 * Parameters from FIPS 186-4 / SEC 2.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;

  var P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  var A = P - 3n;
  var B = BigInt('0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  var GX = BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
  var GY = BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');
  var N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

  function mod(x) {
    var r = x % P;
    return r >= 0n ? r : r + P;
  }

  function modPow(base, exp) {
    var result = 1n;
    var b = mod(base);
    var e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % P;
      b = (b * b) % P;
      e >>= 1n;
    }
    return result;
  }

  function modInv(x) {
    return modPow(x, P - 2n);
  }

  var INFINITY = [0n, 1n, 0n];
  var G = [GX, GY, 1n];

  function pointDouble(pt) {
    var X = pt[0], Y = pt[1], Z = pt[2];
    if (Z === 0n || Y === 0n) return INFINITY;
    var YY = mod(Y * Y);
    var S = mod(4n * X * YY);
    var ZZ = mod(Z * Z);
    var M = mod(3n * mod((X - ZZ) * (X + ZZ))); // 3(X-Z^2)(X+Z^2) = 3X^2 + aZ^4 for a = -3
    var X3 = mod(M * M - 2n * S);
    var Y3 = mod(M * mod(S - X3) - 8n * YY * YY);
    var Z3 = mod(2n * Y * Z);
    return [X3, Y3, Z3];
  }

  function pointAdd(p1, p2) {
    if (p1[2] === 0n) return p2;
    if (p2[2] === 0n) return p1;
    var X1 = p1[0], Y1 = p1[1], Z1 = p1[2];
    var X2 = p2[0], Y2 = p2[1], Z2 = p2[2];
    var Z1Z1 = mod(Z1 * Z1);
    var Z2Z2 = mod(Z2 * Z2);
    var U1 = mod(X1 * Z2Z2);
    var U2 = mod(X2 * Z1Z1);
    var S1 = mod(Y1 * Z2 * Z2Z2);
    var S2 = mod(Y2 * Z1 * Z1Z1);
    if (U1 === U2) {
      if (S1 !== S2) return INFINITY;
      return pointDouble(p1);
    }
    var H = mod(U2 - U1);
    var HH = mod(H * H);
    var HHH = mod(H * HH);
    var r = mod(S2 - S1);
    var X3 = mod(r * r - HHH - 2n * U1 * HH);
    var Y3 = mod(r * mod(U1 * HH - X3) - S1 * HHH);
    var Z3 = mod(H * Z1 * Z2);
    return [X3, Y3, Z3];
  }

  function scalarMult(k, pt) {
    var scalar = ((k % N) + N) % N;
    var result = INFINITY;
    var addend = pt || G;
    var bits = scalar.toString(2);
    for (var i = 0; i < bits.length; i++) {
      result = pointDouble(result);
      if (bits[i] === '1') result = pointAdd(result, addend);
    }
    return result;
  }

  function toAffine(pt) {
    if (pt[2] === 0n) return null;
    var zInv = modInv(pt[2]);
    var zInv2 = mod(zInv * zInv);
    return { x: mod(pt[0] * zInv2), y: mod(pt[1] * zInv2 * zInv) };
  }

  function bigIntToBytes32(v) {
    var out = new Uint8Array(32);
    var x = v;
    for (var i = 31; i >= 0; i--) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return out;
  }

  function bytesToBigInt(bytes) {
    var v = 0n;
    for (var i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  }

  // Uncompressed point encoding: 0x04 || X || Y (65 bytes), as pairing uses.
  function encodePoint(pt) {
    var affine = toAffine(pt);
    if (!affine) throw new Error('p256: point at infinity has no encoding');
    return util.concatBytes(new Uint8Array([0x04]), bigIntToBytes32(affine.x), bigIntToBytes32(affine.y));
  }

  function decodePoint(bytes) {
    if (bytes.length !== 65 || bytes[0] !== 0x04) {
      throw new Error('p256: expected a 65-byte uncompressed point');
    }
    var x = bytesToBigInt(bytes.subarray(1, 33));
    var y = bytesToBigInt(bytes.subarray(33, 65));
    if (x >= P || y >= P) throw new Error('p256: coordinate out of range');
    // On-curve check: y^2 == x^3 + a x + b (mod p)
    var lhs = mod(y * y);
    var rhs = mod(mod(x * x) * x + A * x + B);
    if (lhs !== rhs) throw new Error('p256: point not on curve');
    return [x, y, 1n];
  }

  function generatePrivateScalar() {
    for (;;) {
      var candidate = bytesToBigInt(util.randomBytes(32));
      if (candidate >= 1n && candidate < N) return candidate;
    }
  }

  function publicKeyFromPrivate(scalar) {
    return encodePoint(scalarMult(scalar, G));
  }

  // ECDH: returns the shared point's X coordinate as 32 bytes, matching
  // Python cryptography's EllipticCurvePrivateKey.exchange().
  function ecdh(privateScalar, peerPublicBytes) {
    var peer = decodePoint(peerPublicBytes);
    var shared = toAffine(scalarMult(privateScalar, peer));
    if (!shared) throw new Error('p256: ECDH produced the point at infinity');
    return bigIntToBytes32(shared.x);
  }

  MG.p256 = {
    ORDER: N,
    bytesToBigInt: bytesToBigInt,
    bigIntToBytes32: bigIntToBytes32,
    generatePrivateScalar: generatePrivateScalar,
    publicKeyFromPrivate: publicKeyFromPrivate,
    ecdh: ecdh,
    encodePoint: encodePoint,
    decodePoint: decodePoint,
    scalarMult: scalarMult,
    GENERATOR: G,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.p256;
})(typeof globalThis !== 'undefined' ? globalThis : this);
