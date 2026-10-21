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
 * Port of the Muse Gadget SDK's linux/src/musegadget/noise/noise_xx.py.
 *
 * The wire protocol is Noise_XX_25519_AESGCM_SHA256: X25519 key agreement,
 * AES-256-GCM as the AEAD, SHA-256, and the Noise HKDF construction. (The
 * task brief mentioned ChaChaPoly; the SDK code is authoritative and uses
 * AESGCM — see PROTOCOL.md.) The state machines, phase checks, minimum
 * message lengths, nonce construction (4 zero bytes || u64 big-endian),
 * low-order point rejection and poison-on-failure behaviour all follow the
 * Python original.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;
  var crypto = MG.crypto;

  var PROTOCOL_NAME = util.utf8Encode('Noise_XX_25519_AESGCM_SHA256');
  var DH_KEY_LEN = 32;
  var AEAD_TAG_LEN = 16;
  var MIN_MSG2_LEN = DH_KEY_LEN + (DH_KEY_LEN + AEAD_TAG_LEN) + AEAD_TAG_LEN; // 96
  var MIN_MSG3_LEN = DH_KEY_LEN + AEAD_TAG_LEN + AEAD_TAG_LEN; // 64
  var MAX_SAFE_NONCE = (1n << 53n) - 1n;

  function NoiseProtocolError(message) {
    var err = new Error(message);
    err.name = 'NoiseProtocolError';
    return err;
  }

  function buildNonceIv(nonce) {
    // nonce is a BigInt in [0, 2^64)
    var out = new Uint8Array(12);
    var v = nonce;
    for (var i = 11; i >= 4; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  function CipherState() {
    this._key = null;
    this._nonce = 0n;
    this._poisoned = false;
  }

  CipherState.prototype._assertAlive = function () {
    if (this._poisoned) throw NoiseProtocolError('CipherState: poisoned after prior failure');
  };

  CipherState.prototype.initializeKey = function (key) {
    this._assertAlive();
    if (key.length !== 32) throw NoiseProtocolError('CipherState: AES-GCM key must be 32 bytes');
    this._key = new Uint8Array(key);
    this._nonce = 0n;
  };

  CipherState.prototype.hasKey = function () {
    return this._key !== null;
  };

  CipherState.prototype._nextNonce = function () {
    if (this._nonce >= MAX_SAFE_NONCE) {
      this._poisoned = true;
      throw NoiseProtocolError('CipherState: nonce exhausted');
    }
    var current = this._nonce;
    this._nonce += 1n;
    return current;
  };

  CipherState.prototype.encryptWithAd = function (ad, plaintext) {
    this._assertAlive();
    if (!this._key) return new Uint8Array(plaintext);
    var nonce = this._nextNonce();
    try {
      return crypto.aesGcmEncrypt(this._key, buildNonceIv(nonce), plaintext, ad);
    } catch (err) {
      this._poisoned = true;
      throw err;
    }
  };

  CipherState.prototype.decryptWithAd = function (ad, ciphertext) {
    this._assertAlive();
    if (!this._key) return new Uint8Array(ciphertext);
    var nonce = this._nextNonce();
    try {
      return crypto.aesGcmDecrypt(this._key, buildNonceIv(nonce), ciphertext, ad);
    } catch (err) {
      this._poisoned = true;
      throw NoiseProtocolError('CipherState: decrypt failed');
    }
  };

  function SymmetricState() {
    this._ck = new Uint8Array(32);
    this._h = new Uint8Array(32);
    this._cipher = new CipherState();
  }

  SymmetricState.prototype.initialize = function () {
    var padded = new Uint8Array(32);
    padded.set(PROTOCOL_NAME);
    this._h = padded;
    this._ck = new Uint8Array(padded);
    this.mixHash(new Uint8Array(0)); // empty prologue
  };

  SymmetricState.prototype.mixHash = function (data) {
    this._h = crypto.sha256(util.concatBytes(this._h, data));
  };

  SymmetricState.prototype.mixKey = function (inputKeyMaterial) {
    var outputs = crypto.hkdfNoise(this._ck, inputKeyMaterial, 2);
    this._ck = outputs[0];
    this._cipher = new CipherState();
    this._cipher.initializeKey(outputs[1]);
  };

  SymmetricState.prototype.encryptAndHash = function (plaintext) {
    var ciphertext = this._cipher.encryptWithAd(this._h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  };

  SymmetricState.prototype.decryptAndHash = function (ciphertext) {
    var plaintext = this._cipher.decryptWithAd(this._h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  };

  // Returns [CipherState, CipherState]: (initiator send, initiator recv).
  SymmetricState.prototype.split = function () {
    var outputs = crypto.hkdfNoise(this._ck, new Uint8Array(0), 2);
    this._ck = new Uint8Array(32);
    this._h = new Uint8Array(32);
    var c1 = new CipherState();
    c1.initializeKey(outputs[0]);
    var c2 = new CipherState();
    c2.initializeKey(outputs[1]);
    return [c1, c2];
  };

  SymmetricState.prototype.handshakeHash = function () {
    return new Uint8Array(this._h);
  };

  var Phase = {
    CREATED: 0, INITIALIZED: 1, MSG1_SENT: 2, MSG2_READ: 3,
    MSG3_SENT: 4, SPLIT: 5, DEAD: 6,
  };

  function requirePhase(actual, expected, method) {
    if (actual === Phase.DEAD) {
      throw NoiseProtocolError('NoiseXX: ' + method + ' called on dead handshake');
    }
    if (actual !== expected) {
      throw NoiseProtocolError(
        'NoiseXX: ' + method + ' called in wrong phase (expected ' + expected + ', got ' + actual + ')');
    }
  }

  /* ------- Initiator (the gadget side, as in the SDK) ------- */

  function NoiseXXInitiator() {
    this._ss = new SymmetricState();
    this._e = null;
    this._s = null;
    this._re = null;
    this._rs = null;
    this._phase = Phase.CREATED;
  }

  NoiseXXInitiator.prototype.initialize = function () {
    requirePhase(this._phase, Phase.CREATED, 'initialize');
    this._ss.initialize();
    this._phase = Phase.INITIALIZED;
  };

  NoiseXXInitiator.prototype.writeMessage1 = function () {
    requirePhase(this._phase, Phase.INITIALIZED, 'write_message1');
    try {
      this._e = crypto.x25519GenerateKeyPair();
      this._ss.mixHash(this._e.publicKey);
      this._ss.encryptAndHash(new Uint8Array(0));
      this._phase = Phase.MSG1_SENT;
      return new Uint8Array(this._e.publicKey);
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  };

  NoiseXXInitiator.prototype.readMessage2 = function (msg) {
    requirePhase(this._phase, Phase.MSG1_SENT, 'read_message2');
    msg = new Uint8Array(msg);
    if (msg.length < MIN_MSG2_LEN) {
      this._phase = Phase.DEAD;
      throw NoiseProtocolError('NoiseXX: message 2 too short (' + msg.length + ' < ' + MIN_MSG2_LEN + ')');
    }
    try {
      var offset = 0;
      this._re = msg.subarray(offset, offset + DH_KEY_LEN);
      this._ss.mixHash(this._re);
      offset += DH_KEY_LEN;

      if (!this._e) throw NoiseProtocolError('NoiseXX: missing initiator ephemeral key');
      var ee = crypto.x25519Dh(this._e.privateKey, this._re);
      this._ss.mixKey(ee);

      this._rs = this._ss.decryptAndHash(msg.subarray(offset, offset + DH_KEY_LEN + AEAD_TAG_LEN));
      offset += DH_KEY_LEN + AEAD_TAG_LEN;

      var es = crypto.x25519Dh(this._e.privateKey, this._rs);
      this._ss.mixKey(es);

      var payload = this._ss.decryptAndHash(msg.subarray(offset));
      this._phase = Phase.MSG2_READ;
      return payload;
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  };

  NoiseXXInitiator.prototype.writeMessage3 = function () {
    requirePhase(this._phase, Phase.MSG2_READ, 'write_message3');
    try {
      // The SDK generates a fresh static key pair per session; the bearer
      // token at the WebSocket upgrade is what authenticated the device.
      this._s = crypto.x25519GenerateKeyPair();
      var encS = this._ss.encryptAndHash(this._s.publicKey);

      if (!this._re) throw NoiseProtocolError('NoiseXX: missing responder ephemeral key');
      var se = crypto.x25519Dh(this._s.privateKey, this._re);
      this._ss.mixKey(se);

      var encPayload = this._ss.encryptAndHash(new Uint8Array(0));
      this._phase = Phase.MSG3_SENT;
      return util.concatBytes(encS, encPayload);
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  };

  // Initiator split: [send, recv].
  NoiseXXInitiator.prototype.split = function () {
    requirePhase(this._phase, Phase.MSG3_SENT, 'split');
    this._phase = Phase.SPLIT;
    var result = this._ss.split();
    this._e = this._s = this._re = this._rs = null;
    return result;
  };

  NoiseXXInitiator.prototype.destroy = function () {
    this._e = this._s = this._re = this._rs = null;
    this._phase = Phase.DEAD;
  };

  NoiseXXInitiator.prototype.remoteStaticPublicKey = function () {
    return this._rs === null ? null : new Uint8Array(this._rs);
  };

  NoiseXXInitiator.prototype.handshakeHash = function () {
    return this._ss.handshakeHash();
  };

  /* ------- Responder (test/verification use, as in the SDK) ------- */

  function NoiseXXResponder(payload) {
    this._ss = new SymmetricState();
    this._e = null;
    this._s = null;
    this._re = null;
    this._payload = payload ? new Uint8Array(payload) : new Uint8Array(0);
    this._phase = Phase.CREATED;
  }

  NoiseXXResponder.prototype.initialize = function () {
    requirePhase(this._phase, Phase.CREATED, 'initialize');
    this._ss.initialize();
    this._phase = Phase.INITIALIZED;
  };

  NoiseXXResponder.prototype.readMessage1AndWriteMessage2 = function (msg1) {
    requirePhase(this._phase, Phase.INITIALIZED, 'read_message1_and_write_message2');
    msg1 = new Uint8Array(msg1);
    if (msg1.length < DH_KEY_LEN) {
      this._phase = Phase.DEAD;
      throw NoiseProtocolError('NoiseXX: message 1 too short (' + msg1.length + ' < ' + DH_KEY_LEN + ')');
    }
    try {
      this._re = msg1.subarray(0, DH_KEY_LEN);
      this._ss.mixHash(this._re);
      this._ss.decryptAndHash(msg1.subarray(DH_KEY_LEN));

      this._e = crypto.x25519GenerateKeyPair();
      this._ss.mixHash(this._e.publicKey);

      var ee = crypto.x25519Dh(this._e.privateKey, this._re);
      this._ss.mixKey(ee);

      this._s = crypto.x25519GenerateKeyPair();
      var encS = this._ss.encryptAndHash(this._s.publicKey);

      var es = crypto.x25519Dh(this._s.privateKey, this._re);
      this._ss.mixKey(es);

      var encPayload = this._ss.encryptAndHash(this._payload);
      this._phase = Phase.MSG2_READ;
      return util.concatBytes(this._e.publicKey, encS, encPayload);
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  };

  NoiseXXResponder.prototype.readMessage3 = function (msg3) {
    requirePhase(this._phase, Phase.MSG2_READ, 'read_message3');
    msg3 = new Uint8Array(msg3);
    if (msg3.length < MIN_MSG3_LEN) {
      this._phase = Phase.DEAD;
      throw NoiseProtocolError('NoiseXX: message 3 too short (' + msg3.length + ' < ' + MIN_MSG3_LEN + ')');
    }
    try {
      var offset = 0;
      var rs = this._ss.decryptAndHash(msg3.subarray(offset, offset + DH_KEY_LEN + AEAD_TAG_LEN));
      offset += DH_KEY_LEN + AEAD_TAG_LEN;

      if (!this._e) throw NoiseProtocolError('NoiseXX: missing responder ephemeral key');
      var se = crypto.x25519Dh(this._e.privateKey, rs);
      this._ss.mixKey(se);

      this._ss.decryptAndHash(msg3.subarray(offset));
      this._phase = Phase.MSG3_SENT;
    } catch (err) {
      this._phase = Phase.DEAD;
      throw err;
    }
  };

  // Responder split returns the pair swapped, as the SDK does: [send, recv]
  // from the responder's point of view.
  NoiseXXResponder.prototype.split = function () {
    requirePhase(this._phase, Phase.MSG3_SENT, 'split');
    this._phase = Phase.SPLIT;
    var pair = this._ss.split();
    this._e = this._s = this._re = null;
    return [pair[1], pair[0]];
  };

  NoiseXXResponder.prototype.handshakeHash = function () {
    return this._ss.handshakeHash();
  };

  MG.noise = {
    PROTOCOL_NAME: 'Noise_XX_25519_AESGCM_SHA256',
    NoiseProtocolError: NoiseProtocolError,
    buildNonceIv: buildNonceIv,
    CipherState: CipherState,
    SymmetricState: SymmetricState,
    NoiseXXInitiator: NoiseXXInitiator,
    NoiseXXResponder: NoiseXXResponder,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.noise;
})(typeof globalThis !== 'undefined' ? globalThis : this);
