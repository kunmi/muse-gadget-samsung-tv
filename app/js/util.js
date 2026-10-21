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
 * Byte/string helpers shared by every module. No dependencies.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function concatBytes() {
    var total = 0;
    for (var i = 0; i < arguments.length; i++) total += arguments[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < arguments.length; j++) {
      out.set(arguments[j], off);
      off += arguments[j].length;
    }
    return out;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return s;
  }

  function fromHex(hex) {
    if (hex.length % 2 !== 0) throw new Error('odd hex length');
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  var B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var B64URL_LOOKUP = {};
  for (var bi = 0; bi < B64URL_ALPHABET.length; bi++) {
    B64URL_LOOKUP[B64URL_ALPHABET[bi]] = bi;
  }

  // Unpadded base64url, as the SDK uses on the pairing wire.
  function b64urlEncode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64URL_ALPHABET[b0 >> 2];
      out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      if (i + 1 < bytes.length) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
      if (i + 2 < bytes.length) out += B64URL_ALPHABET[b2 & 0x3f];
    }
    return out;
  }

  // Strict decoder mirroring pairing.py b64url_decode: unpadded base64url
  // only, length % 4 must not be 1, optional max length in characters.
  function b64urlDecode(text, maxChars) {
    var limit = maxChars || 4096;
    if (typeof text !== 'string' || text.length === 0 || text.length > limit) {
      throw new Error('invalid base64url length');
    }
    if (text.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(text)) {
      throw new Error('invalid base64url');
    }
    var out = [];
    var acc = 0;
    var bits = 0;
    for (var i = 0; i < text.length; i++) {
      acc = (acc << 6) | B64URL_LOOKUP[text[i]];
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    var cryptoObj = root.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
      throw new Error('no CSPRNG available (crypto.getRandomValues missing)');
    }
    // getRandomValues is limited to 65536 bytes per call; fill in chunks.
    for (var off = 0; off < n; off += 65536) {
      cryptoObj.getRandomValues(out.subarray(off, Math.min(off + 65536, n)));
    }
    return out;
  }

  function uuidv4() {
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = toHex(b);
    return (
      h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
      h.slice(16, 20) + '-' + h.slice(20)
    );
  }

  // Matches JavaScript's encodeURIComponent, as link_client.py's quote does:
  // Python urllib.parse.quote(value, safe="-_.!~*'()").
  function quoteUriComponent(value) {
    return encodeURIComponent(value);
  }

  MG.util = {
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    concatBytes: concatBytes,
    bytesEqual: bytesEqual,
    toHex: toHex,
    fromHex: fromHex,
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    randomBytes: randomBytes,
    uuidv4: uuidv4,
    quoteUriComponent: quoteUriComponent,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.util;
})(typeof globalThis !== 'undefined' ? globalThis : this);
