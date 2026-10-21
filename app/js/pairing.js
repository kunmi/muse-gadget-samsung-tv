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
 * Port of the Muse Gadget SDK's device-side pairing, protocol version 5:
 *   linux/src/musegadget/pairing.py    (transcript, keys, record crypto)
 *   linux/src/musegadget/ble_setup.py  (setup command dispatch, provisioning)
 *   linux/src/musegadget/ble_framing.py (0xFE chunk framing)
 *   linux/src/musegadget/pair.py       (verify-and-save provisioning)
 *   linux/src/musegadget/ble_server.py (GATT UUIDs, below)
 *
 * Community mode only: pairing_auth "none", epoch 0, policy "confirm_app".
 * Crypto: P-256 ECDH, HKDF-SHA256, AES-256-GCM records. Verified byte-for-byte
 * against the SDK's published vectors in tests/fixtures/link_pairing_v5.json
 * (see tests/test-pairing.js).
 *
 * TRANSPORT GAP: this module is transport-agnostic — it consumes and
 * produces BLE packets through an injected transport, exactly like the SDK's
 * SetupController. A Tizen *web app* has no BLE GATT server (peripheral)
 * API: Samsung's Tizen web Bluetooth API is central-only, so nothing in a
 * .wgt can advertise the service below or accept the Muse app's writes.
 * The app therefore cannot complete on-TV BLE pairing; see PROTOCOL.md for
 * the full gap analysis and the provisioning path the app uses instead.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;
  var crypto = MG.crypto;
  var p256 = MG.p256;

  // GATT identifiers from ble_server.py (protocol constants, keep as-is).
  var SERVICE_UUID = '7fdd3d1c-38ea-46cf-8b46-314ecf5f240c';
  var RX_UUID = '4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01'; // write / write-without-response
  var TX_UUID = 'd75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c'; // read / notify

  var PAIRING_VERSION = 5;
  var PAIRING_MODEL = 'hatch_link';
  var PAIRING_SUITE = 'p256-hkdf-sha256-aes-gcm-v1';
  var POLICY_BUTTON = 'confirm_press';
  var POLICY_APP = 'confirm_app';
  var AUTH_OFFICIAL = 'fleet_ecdsa_p256_v1';
  var AUTH_COMMUNITY = 'none';
  var BUTTON_CONFIRM_TIMEOUT_S = 60;

  var RECORD_LABEL = 'hatch-link ble setup v1';
  var SESSION_ID_LABEL = util.utf8Encode('hatch-link session id v1');

  var CLIENT_FINISHED_TIMEOUT_S = 60;
  var CONFIRMED_TIMEOUT_S = 120;
  var PROVISIONING_TIMEOUT_S = 120;
  var SETUP_WINDOW_S = 600;

  var ERROR_INVALID_HELLO = 'error_pairing_invalid_hello';
  var ERROR_DECRYPT = 'error_pairing_decrypt';

  var P256_POINT_BYTES = 65;
  var NONCE_BYTES = 16;
  var SESSION_ID_BYTES = 16;
  var TAG_BYTES = 16;
  var MAX_B64_CHARS = 4096;
  var MAX_CIPHERTEXT_B64_CHARS = 16384;
  var TO_DEVICE = 0;
  var FROM_DEVICE = 1;

  function PairingError(status) {
    var err = new Error(status);
    err.name = 'PairingError';
    err.status = status;
    return err;
  }

  function ProvisionFailed(status) {
    var err = new Error(status);
    err.name = 'ProvisionFailed';
    err.status = status;
    return err;
  }

  function parseCounter(text) {
    if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) {
      throw new Error('invalid counter');
    }
    var value = BigInt(text);
    if (value >= (1n << 64n)) throw new Error('counter overflow');
    return Number(value);
  }

  // Canonical v5 transcript; SHA-256 of it is the transcript_hash.
  function buildTranscript(opts) {
    var button = opts.policy === POLICY_BUTTON;
    if (!(button || (opts.community && opts.policy === POLICY_APP))) {
      throw new Error('unsupported pairing policy: ' + opts.policy);
    }
    if (opts.community ? opts.authEpoch !== 0 : opts.authEpoch <= 0) {
      throw new Error('invalid auth epoch: ' + opts.authEpoch);
    }
    var fields = [opts.deviceId, opts.nodeId, opts.mac, opts.firmwareVersion,
      opts.mobilePub, opts.devicePub, opts.mobileNonce, opts.deviceNonce];
    for (var i = 0; i < fields.length; i++) {
      if (!fields[i]) throw new Error('transcript fields must be non-empty');
    }
    return [
      'hatch-link-pairing-v' + PAIRING_VERSION,
      'version=' + PAIRING_VERSION,
      'initiator_role=mobile',
      'responder_role=link',
      'device_id=' + opts.deviceId,
      'node_id=' + opts.nodeId,
      'mac=' + opts.mac,
      'model=' + PAIRING_MODEL,
      'firmware_version=' + opts.firmwareVersion,
      'selected_cipher_suite=' + PAIRING_SUITE,
      'pairing_auth=' + (opts.community ? AUTH_COMMUNITY : AUTH_OFFICIAL),
      'pairing_auth_epoch=' + opts.authEpoch,
      'pairing_policy=' + opts.policy,
      'confirm_timeout_seconds=' + (button ? BUTTON_CONFIRM_TIMEOUT_S : 0),
      'mobile_pub=' + opts.mobilePub,
      'device_pub=' + opts.devicePub,
      'mobile_nonce=' + opts.mobileNonce,
      'device_nonce=' + opts.deviceNonce,
    ].join('\n');
  }

  // Returns {mobileTxKey, mobileRxKey, sessionId}: mobileTxKey decrypts
  // records the device receives; mobileRxKey encrypts records it sends.
  function deriveSessionKeys(ecdhSecret, mobileNonce, deviceNonce, transcriptHash) {
    var salt = crypto.sha256(util.concatBytes(mobileNonce, deviceNonce, transcriptHash));
    var sessionSecret = crypto.hkdfSha256(
      ecdhSecret, salt, util.utf8Encode(RECORD_LABEL), 32);
    var mobileTx = crypto.hkdfExpandSha256(
      sessionSecret, util.utf8Encode('mobile->device'), 32);
    var mobileRx = crypto.hkdfExpandSha256(
      sessionSecret, util.utf8Encode('device->mobile'), 32);
    var sessionId = crypto.sha256(
      util.concatBytes(SESSION_ID_LABEL, transcriptHash, ecdhSecret)).subarray(0, SESSION_ID_BYTES);
    return { mobileTxKey: mobileTx, mobileRxKey: mobileRx, sessionId: sessionId, sessionSecret: sessionSecret };
  }

  function recordNonce(direction, counter) {
    var nonce = new Uint8Array(12);
    nonce[0] = direction;
    var v = BigInt(counter);
    for (var i = 11; i >= 4; i--) {
      nonce[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return nonce;
  }

  function recordAad(sessionIdB64, direction, counter) {
    var arrow = direction === TO_DEVICE ? 'm2d' : 'd2m';
    return util.utf8Encode(RECORD_LABEL + '|' + sessionIdB64 + '|' + arrow + '|' + counter);
  }

  var PairingState = {
    IDLE: 'idle',
    WAIT_CLIENT_FINISHED: 'wait_client_finished',
    READY: 'ready',
    PROVISIONING: 'provisioning',
  };

  /* ---------------- PairingSession (pairing.py) ---------------- */

  function PairingSession(opts) {
    this._nodeId = opts.nodeId;
    this._sdkToken = opts.sdkToken || null;
    this._deviceId = opts.deviceId;
    this._mac = opts.mac;
    this._firmwareVersion = opts.firmwareVersion || 'unknown';
    this._clock = opts.clock || function () { return Date.now() / 1000; };
    this._generateScalar = opts.generateScalar || p256.generatePrivateScalar;
    this._randomBytes = opts.randomBytes || util.randomBytes;
    this._generation = 0;
    this._resetLocked();
  }

  PairingSession.prototype.deviceInfo = function () {
    return {
      device_id: this._deviceId,
      mac: this._mac,
      model: PAIRING_MODEL,
      pairing_protocol: PAIRING_VERSION,
      pairing_auth: AUTH_COMMUNITY,
      pairing_auth_epoch: 0,
      pairing_policy: POLICY_APP,
    };
  };

  Object.defineProperties(PairingSession.prototype, {
    state: {
      get: function () {
        this._expireLocked();
        return this._state;
      },
    },
    confirmed: {
      get: function () {
        var s = this.state;
        return s === PairingState.READY || s === PairingState.PROVISIONING;
      },
    },
  });

  PairingSession.prototype.isCurrent = function (generation) {
    return generation !== 0 && generation === this._generation;
  };

  PairingSession.prototype.reset = function () {
    this._resetLocked();
  };

  PairingSession.prototype.handleHello = function (message) {
    var version = message ? message.version : undefined;
    if (
      typeof version === 'boolean' ||
      typeof version !== 'number' ||
      version !== PAIRING_VERSION ||
      message.pairing_auth !== AUTH_COMMUNITY ||
      message.pairing_policy !== POLICY_APP
    ) {
      throw PairingError(ERROR_INVALID_HELLO);
    }

    this._resetLocked();
    var mobilePub, mobileNonce;
    try {
      mobilePub = util.b64urlDecode(message.mobile_pub);
      mobileNonce = util.b64urlDecode(message.mobile_nonce);
      if (mobilePub.length !== P256_POINT_BYTES || mobilePub[0] !== 0x04 ||
          mobileNonce.length !== NONCE_BYTES) {
        throw new Error('invalid hello key material');
      }
      p256.decodePoint(mobilePub); // validates the point, as from_encoded_point does
    } catch (err) {
      this._resetLocked();
      throw PairingError(ERROR_INVALID_HELLO);
    }

    var deviceScalar = this._generateScalar();
    var devicePub = p256.publicKeyFromPrivate(deviceScalar);
    var deviceNonce = this._randomBytes(NONCE_BYTES);
    var transcript = buildTranscript({
      community: true,
      authEpoch: 0,
      policy: POLICY_APP,
      deviceId: this._deviceId,
      nodeId: this._nodeId,
      mac: this._mac,
      firmwareVersion: this._firmwareVersion,
      mobilePub: util.b64urlEncode(mobilePub),
      devicePub: util.b64urlEncode(devicePub),
      mobileNonce: util.b64urlEncode(mobileNonce),
      deviceNonce: util.b64urlEncode(deviceNonce),
    });
    var transcriptHash = crypto.sha256(util.utf8Encode(transcript));
    var ecdhSecret = p256.ecdh(deviceScalar, mobilePub);
    var keys = deriveSessionKeys(ecdhSecret, mobileNonce, deviceNonce, transcriptHash);

    this._rxKey = keys.mobileTxKey;
    this._txKey = keys.mobileRxKey;
    this._sessionIdB64 = util.b64urlEncode(keys.sessionId);
    this._rxCounter = 0;
    this._txCounter = 0;
    this._state = PairingState.WAIT_CLIENT_FINISHED;
    this._deadline = this._clock() + CLIENT_FINISHED_TIMEOUT_S;
    return {
      type: 'pairing_ready',
      version: PAIRING_VERSION,
      device_id: this._deviceId,
      node_id: this._nodeId,
      mac: this._mac,
      model: PAIRING_MODEL,
      firmware_version: this._firmwareVersion,
      pairing_auth: AUTH_COMMUNITY,
      pairing_auth_epoch: 0,
      pairing_policy: POLICY_APP,
      device_pub: util.b64urlEncode(devicePub),
      device_nonce: util.b64urlEncode(deviceNonce),
      transcript_hash: util.b64urlEncode(transcriptHash),
      session_id: this._sessionIdB64,
    };
  };

  // Opens one mobile-to-device pairing_encrypted record. Any failure clears
  // the session, as the firmware does. Returns the plaintext string.
  PairingSession.prototype.decrypt = function (envelope) {
    if (this._expireLocked() || this._state === PairingState.IDLE) {
      this._resetLocked();
      throw PairingError(ERROR_DECRYPT);
    }
    try {
      if (!envelope || envelope.session_id !== this._sessionIdB64) {
        throw new Error('wrong session');
      }
      var counter = parseCounter(envelope.counter);
      if (counter !== this._rxCounter) throw new Error('unexpected counter');
      var ciphertext = util.b64urlDecode(envelope.ciphertext, MAX_CIPHERTEXT_B64_CHARS);
      var tag = util.b64urlDecode(envelope.tag);
      if (tag.length !== TAG_BYTES) throw new Error('invalid tag length');
      var plaintext = crypto.aesGcmDecrypt(
        this._rxKey,
        recordNonce(TO_DEVICE, counter),
        util.concatBytes(ciphertext, tag),
        recordAad(this._sessionIdB64, TO_DEVICE, counter)
      );
      var text = util.utf8Decode(plaintext);
      this._rxCounter += 1;
      return text;
    } catch (err) {
      this._resetLocked();
      throw PairingError(ERROR_DECRYPT);
    }
  };

  // Confirms the session after the first decrypted record, which must be
  // exactly {"action": "pairing_client_finished"}. Returns the new
  // generation, or 0 (after clearing the session) when invalid.
  PairingSession.prototype.handleClientFinished = function (command) {
    var keys = command && typeof command === 'object' ? Object.keys(command) : [];
    var ok = (
      keys.length === 1 && command.action === 'pairing_client_finished' &&
      !this._expireLocked() &&
      this._state === PairingState.WAIT_CLIENT_FINISHED &&
      this._rxCounter === 1
    );
    if (!ok) {
      this._resetLocked();
      return 0;
    }
    this._advanceGenerationLocked();
    this._state = PairingState.READY;
    this._deadline = this._clock() + CONFIRMED_TIMEOUT_S;
    return this._generation;
  };

  PairingSession.prototype.markProvisioning = function () {
    if (!this._expireLocked() && this._state === PairingState.READY) {
      this._advanceGenerationLocked();
      this._state = PairingState.PROVISIONING;
      this._deadline = this._clock() + PROVISIONING_TIMEOUT_S;
    }
    if (this._state === PairingState.PROVISIONING) return this._generation;
    return 0;
  };

  PairingSession.prototype.extendProvisioning = function (generation) {
    var valid = this._provisioningLocked(generation);
    if (valid) this._deadline = this._clock() + PROVISIONING_TIMEOUT_S;
    return valid;
  };

  PairingSession.prototype.commitProvisioning = function (generation, commit) {
    return this._provisioningLocked(generation) && !!commit();
  };

  // Seals a device-to-mobile record; null when there is no live session or a
  // nonzero generation is stale.
  PairingSession.prototype.encryptJson = function (plaintext, generation) {
    generation = generation || 0;
    if (
      (generation && generation !== this._generation) ||
      this._expireLocked() ||
      this._state === PairingState.IDLE
    ) {
      return null;
    }
    var counter = this._txCounter;
    var sealed = crypto.aesGcmEncrypt(
      this._txKey,
      recordNonce(FROM_DEVICE, counter),
      util.utf8Encode(plaintext),
      recordAad(this._sessionIdB64, FROM_DEVICE, counter)
    );
    this._txCounter += 1;
    return {
      type: 'pairing_encrypted',
      session_id: this._sessionIdB64,
      counter: String(counter),
      ciphertext: util.b64urlEncode(sealed.subarray(0, sealed.length - TAG_BYTES)),
      tag: util.b64urlEncode(sealed.subarray(sealed.length - TAG_BYTES)),
    };
  };

  PairingSession.prototype.encryptStatus = function (status, generation) {
    var message = { type: 'status', status: status };
    // Apps read only type and status, so older ones ignore the token.
    if (this._sdkToken && status === 'pairing_confirmed') {
      message.sdk_token = this._sdkToken;
    }
    return this.encryptJson(JSON.stringify(message), generation || 0);
  };

  PairingSession.prototype._provisioningLocked = function (generation) {
    return (
      generation !== 0 &&
      generation === this._generation &&
      !this._expireLocked() &&
      this._state === PairingState.PROVISIONING
    );
  };

  PairingSession.prototype._advanceGenerationLocked = function () {
    this._generation += 1;
  };

  PairingSession.prototype._resetLocked = function () {
    this._advanceGenerationLocked();
    this._clearLocked();
  };

  PairingSession.prototype._clearLocked = function () {
    this._state = PairingState.IDLE;
    this._deadline = 0;
    this._rxKey = null;
    this._txKey = null;
    this._sessionIdB64 = '';
    this._rxCounter = 0;
    this._txCounter = 0;
  };

  PairingSession.prototype._expireLocked = function () {
    if (this._state === PairingState.IDLE || this._clock() <= this._deadline) return false;
    this._clearLocked();
    return true;
  };

  /* ---------------- BLE chunk framing (ble_framing.py) ---------------- */

  var CHUNK_MAGIC = 0xfe;
  var HEADER_BYTES = 3;
  var MAX_PACKET_BYTES = 160;
  var MAX_CHUNKS = 255;
  var MAX_MESSAGE_BYTES = 8192;
  var DEFAULT_ATT_MTU = 23;

  function encodeChunks(data, mtu) {
    var useMtu = mtu === undefined ? DEFAULT_ATT_MTU : mtu;
    var notifyMax = Math.min(useMtu > 3 ? useMtu - 3 : 20, MAX_PACKET_BYTES);
    var usable = notifyMax - HEADER_BYTES;
    var fragments = [];
    for (var i = 0; i < data.length; i += usable) {
      fragments.push(data.subarray(i, i + usable));
    }
    if (fragments.length === 0) fragments.push(new Uint8Array(0));
    if (fragments.length > MAX_CHUNKS) {
      throw new Error('message needs ' + fragments.length + ' chunks (max ' + MAX_CHUNKS + ')');
    }
    var total = fragments.length;
    return fragments.map(function (frag, index) {
      return util.concatBytes(new Uint8Array([CHUNK_MAGIC, index, total]), frag);
    });
  }

  function ChunkAssembler(maxBytes) {
    this._maxBytes = maxBytes || MAX_MESSAGE_BYTES;
    this.reset();
  }

  ChunkAssembler.prototype.reset = function () {
    this._buf = new Uint8Array(0);
    this._total = 0;
    this._next = 0;
  };

  // Adds one write; returns a complete message once one is available.
  ChunkAssembler.prototype.feed = function (packet) {
    packet = new Uint8Array(packet);
    if (packet.length < HEADER_BYTES || packet[0] !== CHUNK_MAGIC) {
      return packet; // a packet without the magic is a complete message
    }
    var index = packet[1];
    var total = packet[2];
    var fragment = packet.subarray(HEADER_BYTES);
    if (total === 0) {
      this.reset();
      return null;
    }
    if (index === 0 || total !== this._total) {
      this.reset();
      this._total = total;
    }
    if (index !== this._next || index >= this._total) {
      this.reset();
      return null;
    }
    if (this._buf.length + fragment.length > this._maxBytes) {
      this.reset();
      return null;
    }
    this._buf = util.concatBytes(this._buf, fragment);
    this._next = index + 1;
    if (this._next < this._total) return null;
    var message = this._buf;
    this.reset();
    return message;
  };

  /* ---------------- SetupController (ble_setup.py) ---------------- */

  var SENSITIVE_ACTIONS = new Set([
    'provision', 'provision_v2', 'wifi_scan', 'ota', 'device.ota', 'unpair', 'set_wifi', 'set_auth',
  ]);
  var PLAINTEXT_STATUSES = new Set([
    'error_encryption_required',
    'error_pairing_invalid_hello',
    'error_pairing_unavailable',
    'error_pairing_decrypt',
  ]);
  var DISCONNECT_AFTER_ERROR_S = 0.3;

  function compact(obj) {
    return JSON.stringify(obj);
  }

  // transport: {sendPackets(packets), mtu(), disconnect(delaySeconds)}
  // network:   {isOnline(), currentConnectionEntry()}
  // provision: function(credentials, commit) -> Promise; throws ProvisionFailed
  function SetupController(opts) {
    this._pairing = opts.pairing;
    this._identity = opts.identity; // {nodeId}
    this._version = opts.version;
    this._transport = opts.transport;
    this._network = opts.network;
    this._provision = opts.provision;
    this._onComplete = opts.onComplete || function () {};
    this._assembler = new ChunkAssembler();
    this._plaintextBlocked = false;
    this._provisioning = false;
    this._queue = Promise.resolve();
  }

  SetupController.prototype.onWrite = function (packet) {
    var message = this._assembler.feed(packet);
    if (message !== null) {
      var self = this;
      // Handle messages one at a time, in arrival order, as the SDK does.
      this._queue = this._queue.then(function () {
        return self.handleMessage(message, false);
      }).catch(function () { /* a failed command must not jam the queue */ });
    }
  };

  SetupController.prototype.onDisconnect = function () {
    this._assembler.reset();
    this._plaintextBlocked = false;
    this._pairing.reset();
  };

  // Returns a Promise; the dispatch mirrors ble_setup.py's branch order.
  SetupController.prototype.handleMessage = function (raw, decrypted) {
    var self = this;
    var command;
    try {
      command = JSON.parse(util.utf8Decode(raw));
    } catch (err) {
      this.sendStatus('error_invalid_command');
      return Promise.resolve();
    }
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      this.sendStatus('error_invalid_command');
      return Promise.resolve();
    }
    var action = typeof command.action === 'string' ? command.action : '';

    if (!decrypted && action === 'pairing_client_hello') {
      this._handleHello(command);
    } else if (!decrypted && action === 'pairing_encrypted') {
      this._handleRecord(command);
    } else if (action === 'get_device_info') {
      this.sendJson(this.deviceInfo());
    } else if (!decrypted && this._plaintextBlocked) {
      // Plaintext is ignored once pairing has started.
    } else if (!decrypted && SENSITIVE_ACTIONS.has(action)) {
      this.sendStatus('error_encryption_required');
    } else if (decrypted && action === 'pairing_client_finished') {
      this._handleClientFinished(command);
    } else if (decrypted && SENSITIVE_ACTIONS.has(action) && !this._pairing.confirmed) {
      this.sendStatus('error_pairing_confirm_required');
    } else if (decrypted && action === 'wifi_scan') {
      this._handleWifiScan();
    } else if (decrypted && action === 'provision_v2') {
      return this._handleProvision(command);
    } else {
      this.sendStatus('error_unknown_action');
    }
    return Promise.resolve();
  };

  SetupController.prototype.deviceInfo = function () {
    var info = {
      type: 'device_info',
      node_id: this._identity.nodeId,
      version: this._version,
    };
    var pairingInfo = this._pairing.deviceInfo();
    Object.keys(pairingInfo).forEach(function (k) { info[k] = pairingInfo[k]; });
    info.build_sha = '';
    info.network_ready = this._network.isOnline();
    return info;
  };

  SetupController.prototype._handleHello = function (command) {
    var ready;
    try {
      // ble_setup pairs action "pairing_client_hello" with the message
      // fields pairing.py reads (it passes the whole command along).
      ready = this._pairing.handleHello(command);
    } catch (err) {
      if (err && err.status) this.sendStatus(err.status);
      else this.sendStatus(ERROR_INVALID_HELLO);
      return;
    }
    this._plaintextBlocked = true;
    this.sendJson(ready);
  };

  SetupController.prototype._handleRecord = function (envelope) {
    var plaintext;
    try {
      plaintext = this._pairing.decrypt(envelope);
    } catch (err) {
      this.sendStatus(err && err.status ? err.status : ERROR_DECRYPT);
      this._transport.disconnect(DISCONNECT_AFTER_ERROR_S);
      return;
    }
    return this.handleMessage(util.utf8Encode(plaintext), true);
  };

  SetupController.prototype._handleClientFinished = function (command) {
    var generation = this._pairing.handleClientFinished(command);
    if (!generation) {
      this.sendStatus(ERROR_DECRYPT);
      this._transport.disconnect(DISCONNECT_AFTER_ERROR_S);
      return;
    }
    this.sendStatus('pairing_confirmed', generation);
  };

  SetupController.prototype._handleWifiScan = function () {
    var networks = this._network.isOnline() ? [this._network.currentConnectionEntry()] : [];
    this.sendEncryptedJson({ type: 'wifi_scan_result', networks: networks });
  };

  SetupController.prototype._handleProvision = function (command) {
    var self = this;
    function text(key) {
      var value = command[key];
      return typeof value === 'string' ? value : '';
    }
    if (
      typeof command.ssid !== 'string' ||
      typeof command.password !== 'string' ||
      !text('access_token') ||
      !text('refresh_token') ||
      text('token_type') !== 'device'
    ) {
      this.sendStatus('error_missing_credentials');
      return Promise.resolve();
    }
    if (this._provisioning) {
      this.sendStatus('error_operation_in_progress');
      return Promise.resolve();
    }
    var generation = this._pairing.markProvisioning();
    if (!generation) {
      this.sendStatus('error_pairing_confirm_required');
      return Promise.resolve();
    }
    this._provisioning = true;
    // The Wi-Fi fields are deliberately dropped: this device only sets up
    // when it is already online (it is a TV on the home network).
    var credentials = {
      access_token: text('access_token'),
      refresh_token: text('refresh_token'),
      username: text('username'),
      api_url: text('api_url'),
      api_url_v2: text('api_url_v2'),
      noise_host: text('noise_host'),
    };
    return this._runProvision(credentials, generation).then(function () {
      self._provisioning = false;
    }, function () {
      self._provisioning = false;
    });
  };

  SetupController.prototype._runProvision = function (credentials, generation) {
    var self = this;
    this.sendStatus('wifi_connecting', generation);
    if (!this._network.isOnline()) {
      // Stay in provisioning so the app can retry, as the firmware does.
      this._pairing.extendProvisioning(generation);
      this.sendStatus('wifi_failed', generation);
      return Promise.resolve();
    }
    this.sendStatus('wifi_connected', generation);

    function commit(save) {
      return self._pairing.commitProvisioning(generation, save);
    }

    return Promise.resolve()
      .then(function () { return self._provision(credentials, commit); })
      .then(function () {
        self.sendStatus('auth_ok', generation);
        self._onComplete();
      })
      .catch(function (err) {
        var status = err && err.status ? err.status : 'auth_failed';
        self.sendStatus(status, generation);
        self._transport.disconnect(0.5);
      });
  };

  /* Sending (single-threaded here; the SDK serialises with a lock). */

  SetupController.prototype.sendStatus = function (status, generation) {
    generation = generation || 0;
    var envelope = this._pairing.encryptStatus(status, generation);
    if (envelope !== null) {
      this._sendText(compact(envelope));
      return;
    }
    if (generation || this._plaintextBlocked || !PLAINTEXT_STATUSES.has(status)) {
      return; // suppressed, as in ble_setup.py
    }
    this._transport.sendPackets([util.utf8Encode(status)]);
  };

  SetupController.prototype.sendJson = function (obj) {
    this._sendText(compact(obj));
  };

  SetupController.prototype.sendEncryptedJson = function (obj, generation) {
    var envelope = this._pairing.encryptJson(compact(obj), generation || 0);
    if (envelope === null) return;
    this._sendText(compact(envelope));
  };

  SetupController.prototype._sendText = function (text) {
    var packets = encodeChunks(util.utf8Encode(text), this._transport.mtu());
    this._transport.sendPackets(packets);
  };

  /* ---------------- verify-and-save (pair.py) ---------------- */

  // Port of pair.py's _verify_and_save: verify the provisioned credentials
  // against the device API before saving; the save itself runs through the
  // pairing session's commit gate. deps: {fetchVms, apiRoot, store, sdkToken,
  // nowSeconds()}
  function verifyAndSaveProvisioning(credentials, commit, deps) {
    var apiUrl = typeof credentials.api_url === 'string' &&
      credentials.api_url.indexOf('https://') === 0 ? credentials.api_url : '';
    var apiUrlV2 = typeof credentials.api_url_v2 === 'string' &&
      credentials.api_url_v2.indexOf('https://') === 0 ? credentials.api_url_v2 : '';
    return deps.fetchVms(credentials.access_token, deps.apiRoot(apiUrlV2))
      .then(function (result) {
        if (!result.vms || result.vms.length === 0) {
          throw ProvisionFailed('auth_failed');
        }
        var record = {
          access_token: credentials.access_token,
          refresh_token: credentials.refresh_token,
          token_type: 'device',
          username: credentials.username || '',
          api_url: apiUrl,
          api_url_v2: apiUrlV2,
          noise_host: credentials.noise_host || '',
          access_token_saved_at: Math.floor(deps.nowSeconds()),
          sdk_token_hint: MG.store ? MG.store.sdkTokenHint(deps.sdkToken || null) : 'none',
        };
        function save() {
          deps.store.setPairing(record);
          return true;
        }
        if (!commit(save)) throw ProvisionFailed('error_storage');
        return record;
      });
  }

  MG.pairing = {
    SERVICE_UUID: SERVICE_UUID,
    RX_UUID: RX_UUID,
    TX_UUID: TX_UUID,
    PAIRING_VERSION: PAIRING_VERSION,
    PAIRING_MODEL: PAIRING_MODEL,
    SETUP_WINDOW_S: SETUP_WINDOW_S,
    PairingError: PairingError,
    ProvisionFailed: ProvisionFailed,
    buildTranscript: buildTranscript,
    deriveSessionKeys: deriveSessionKeys,
    recordNonce: recordNonce,
    recordAad: recordAad,
    PairingSession: PairingSession,
    PairingState: PairingState,
    encodeChunks: encodeChunks,
    ChunkAssembler: ChunkAssembler,
    SetupController: SetupController,
    verifyAndSaveProvisioning: verifyAndSaveProvisioning,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.pairing;
})(typeof globalThis !== 'undefined' ? globalThis : this);
