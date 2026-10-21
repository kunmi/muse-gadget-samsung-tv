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
 * Port of the Muse Gadget SDK's linux/src/musegadget/link_client.py: one
 * control session with a Muse VM.
 *
 *   wss://<noise_host>/v1/noise?vm_id=<vm_id>
 *   -> Noise XX handshake (the VM bearer authenticates at the upgrade)
 *   -> POST /link-control stream, left open; both directions carry JSON
 *      messages prefixed with a little-endian u32 length
 *   -> device sends link.register, then a link.result per link.invoke
 *   -> VM sends the register reply, link.invoke requests, and events such
 *      as link.unpaired
 *   -> chat goes as separate POST /chat/stream requests on the same session
 *
 * PLATFORM GAP (see PROTOCOL.md): a browser/Tizen WebSocket cannot set the
 * "Authorization: Bearer <vm_auth_token>" header the SDK sends on the
 * upgrade, and cannot read the upgrade's HTTP status. The connection is
 * therefore attempted without the header; a close during the handshake is
 * reported as AUTH_REJECTED (the closest observable equivalent). Whether
 * the production edge accepts the TV's upgrade is unverified — there is no
 * TV hardware or live token to test with.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;
  var noise = MG.noise;
  var transportModule = MG.transport;
  var controlFraming = MG.controlFraming;

  var NOISE_PATH = '/v1/noise';
  var CONTROL_PATH = '/link-control';
  var CHAT_PATH = '/chat/stream';
  var APP_ID = 'musegadget';
  var REQUEST_TIMEOUT_S = 60;
  var HANDSHAKE_TIMEOUT_S = 20;
  var MAX_CONCURRENT_INVOKES = 4;
  var MAX_RESPONSE_BYTES = 1024 * 1024;
  var REQUEST_CHUNK_BYTES = 16 * 1024;
  var MAX_INLINE_REQUEST_BYTES = 64 * 1024;

  var Outcome = {
    CLOSED: 'closed',
    AUTH_REJECTED: 'auth_rejected',
    FORBIDDEN: 'forbidden',
    UNPAIRED: 'unpaired',
    STOPPED: 'stopped',
  };

  function noiseUrl(noiseHost, vmId) {
    return 'wss://' + noiseHost + NOISE_PATH + '?vm_id=' + util.quoteUriComponent(vmId);
  }

  function DeviceDescription(opts) {
    this.nodeId = opts.nodeId;
    this.displayName = opts.displayName;
    this.version = opts.version;
    this.commands = opts.commands;
  }

  // Register params. platform/model_id are the TV adaptation (the Linux SDK
  // sends "linux"/"linux"); device_family stays "homehub" — never "link",
  // and device.ota is never advertised (the server pushes ESP32 firmware to
  // "link" devices). See PROTOCOL.md.
  DeviceDescription.prototype.registerParams = function () {
    return {
      node_id: this.nodeId,
      display_name: this.displayName,
      platform: 'tizen',
      version: this.version,
      device_family: 'homehub',
      model_id: 'samsung-tv',
      is_wakeup_supported: false,
      commands_v2: this.commands,
    };
  };

  function _Request() {
    var self = this;
    this.status = 0;
    this._chunks = [];
    this._bodyLen = 0;
    this.done = new Promise(function (resolve, reject) {
      self._resolve = resolve;
      self._reject = reject;
    });
    this.settled = false;
  }

  _Request.prototype.onFrame = function (frame) {
    if (this.settled) return;
    if (frame.kind === 'reset') {
      this._fail(new Error('stream reset: ' + frame.value.reason));
      return;
    }
    var data, ended;
    if (frame.kind === 'response') {
      this.status = frame.value.status;
      data = frame.value.body;
      ended = frame.value.endBody;
    } else {
      data = frame.value.data;
      ended = frame.value.endBody;
    }
    if (data && data.length) {
      this._chunks.push(data);
      this._bodyLen += data.length;
    }
    if (this._bodyLen > MAX_RESPONSE_BYTES) {
      this._fail(new Error('response too large'));
    } else if (ended) {
      this.settled = true;
      this._resolve({ status: this.status, body: util.concatBytes.apply(null, this._chunks) });
    }
  };

  _Request.prototype._fail = function (err) {
    if (this.settled) return;
    this.settled = true;
    this._reject(err);
  };

  function Semaphore(max) {
    this._max = max;
    this._active = 0;
    this._waiters = [];
  }

  Semaphore.prototype.acquire = function () {
    var self = this;
    if (this._active < this._max) {
      this._active += 1;
      return Promise.resolve();
    }
    return new Promise(function (resolve) { self._waiters.push(resolve); });
  };

  Semaphore.prototype.release = function () {
    var next = this._waiters.shift();
    if (next) next();
    else this._active -= 1;
  };

  // opts: {noiseHost, vmId, vmAuthToken, device, runCommand, wsFactory?, log?}
  // wsFactory(url, headers) must return a WebSocket-like object with
  // addEventListener, send and close. The headers argument records what the
  // SDK would send; browser WebSockets cannot apply it (see header note).
  function LinkSession(opts) {
    this._url = noiseUrl(opts.noiseHost, opts.vmId);
    this._token = opts.vmAuthToken;
    this._device = opts.device;
    this._runCommand = opts.runCommand;
    this._wsFactory = opts.wsFactory || null;
    this._log = opts.log || function () {};
    this._invokes = new Semaphore(MAX_CONCURRENT_INVOKES);
    this._requests = new Map();
    this._streamId = 0;
    this._registerId = '';
    this._running = false;
    this._finished = false;
    this.registeredAt = null; // seconds (monotonic-ish clock below)
    this.wasRegisteredAt = null; // registeredAt as it stood when the session ended
    this._now = opts.nowFn || function () { return Date.now() / 1000; };
  }

  LinkSession.prototype.isRegistered = function () {
    return this.registeredAt !== null;
  };

  // Runs until the session ends; resolves with an Outcome string.
  LinkSession.prototype.run = function () {
    var self = this;
    this._outcomePromise = new Promise(function (resolve) { self._resolveOutcome = resolve; });
    this._open()
      .then(function (ws) {
        self._ws = ws;
        return self._handshake(ws);
      })
      .then(function (transport) {
        self._transport = transport;
        self._running = true;
        self._attachReader();
        self._openControlStream();
      })
      .catch(function (err) {
        if (err && err.name === 'UpgradeRejected') {
          self._finish(err.status === 401 || err.status === null
            ? Outcome.AUTH_REJECTED : Outcome.FORBIDDEN);
        } else {
          self._log('session setup failed: ' + (err && err.message));
          self._finish(Outcome.CLOSED);
        }
      });
    return this._outcomePromise;
  };

  LinkSession.prototype.stop = function () {
    this._finish(Outcome.STOPPED);
  };

  LinkSession.prototype._finish = function (outcome) {
    if (this._finished) return;
    this._finished = true;
    this._running = false;
    this.wasRegisteredAt = this.registeredAt;
    this.registeredAt = null;
    this._requests.forEach(function (req) {
      req._fail(new Error('session ended'));
    });
    this._requests.clear();
    if (this._ws) {
      try { this._ws.close(); } catch (err) { /* ignore */ }
    }
    if (this._resolveOutcome) this._resolveOutcome(outcome);
  };

  /* -- Connection setup -------------------------------------------------- */

  LinkSession.prototype._open = function () {
    var self = this;
    var headers = { Authorization: 'Bearer ' + this._token };
    return new Promise(function (resolve, reject) {
      var ws;
      try {
        ws = self._wsFactory
          ? self._wsFactory(self._url, headers)
          : new WebSocket(self._url); // eslint-disable-line no-undef
      } catch (err) {
        reject(err);
        return;
      }
      ws.binaryType = 'arraybuffer';
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          try { ws.close(); } catch (err) { /* ignore */ }
          reject(new Error('WebSocket open timed out'));
        }
      }, HANDSHAKE_TIMEOUT_S * 1000);
      ws.addEventListener('open', function () {
        if (!settled) { settled = true; clearTimeout(timer); resolve(ws); }
      });
      function earlyClose() {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          // Browsers expose no HTTP status for a failed upgrade; the SDK
          // maps 401/403 here. Report null -> AUTH_REJECTED upstream.
          var err = new Error('upgrade rejected');
          err.name = 'UpgradeRejected';
          err.status = null;
          reject(err);
        }
      }
      ws.addEventListener('close', earlyClose);
      ws.addEventListener('error', earlyClose);
    });
  };

  LinkSession.prototype._handshake = function (ws) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var initiator = new noise.NoiseXXInitiator();
      initiator.initialize();
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('Noise handshake timed out'));
      }, HANDSHAKE_TIMEOUT_S * 1000);
      function onMessage(event) {
        var data = event.data;
        if (typeof data === 'string') {
          cleanup();
          reject(new Error('Noise handshake got a text frame'));
          return;
        }
        cleanup();
        try {
          var msg2 = new Uint8Array(data);
          initiator.readMessage2(msg2);
          // The bearer authenticated us at the upgrade; message 3 carries
          // an empty payload.
          ws.send(initiator.writeMessage3());
          var pair = initiator.split();
          self._log('Noise session established');
          resolve(new transportModule.NoiseTransport(pair[0], pair[1]));
        } catch (err) {
          reject(err);
        }
      }
      function onClose() {
        cleanup();
        reject(new Error('connection closed during handshake'));
      }
      function cleanup() {
        clearTimeout(timer);
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
      }
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.send(initiator.writeMessage1());
    });
  };

  LinkSession.prototype._openControlStream = function () {
    var encrypted = this._transport.startStreamRequest('POST', CONTROL_PATH);
    this._streamId = encrypted.streamId;
    this._sendFrames(encrypted.frames);
    this._registerId = util.uuidv4();
    this.send({
      type: 'req',
      id: this._registerId,
      method: 'link.register',
      params: this._device.registerParams(),
    });
    this._log('sent link.register as ' + this._device.nodeId);
  };

  /* -- Sending ------------------------------------------------------------- */

  // All frames of one batch are encrypted first (advancing the Noise nonce)
  // and then written out together, so a batch can never interleave with
  // another sender and leave a nonce gap.
  LinkSession.prototype._sendFrames = function (frames) {
    for (var i = 0; i < frames.length; i++) {
      this._ws.send(frames[i]);
    }
  };

  LinkSession.prototype.send = function (message) {
    var frames = this._transport.encryptBodyChunk(
      this._streamId, controlFraming.encodeMessage(message));
    this._sendFrames(frames);
  };

  /* -- Device-originated chat ---------------------------------------------- */

  LinkSession.prototype.sendChat = function (message, sessionId, outputModality) {
    var body = {
      message: message,
      output_modality: outputModality || 'text',
      device_id: this._device.nodeId,
    };
    if (sessionId) body.session_id = sessionId;
    return this._postChat(body);
  };

  LinkSession.prototype._httpHeaders = function (headers) {
    return headers.concat([
      { key: 'x-request-id', value: util.uuidv4() },
      { key: 'x-app-id', value: APP_ID },
    ]);
  };

  LinkSession.prototype._postChat = function (requestBody) {
    var self = this;
    if (!this._running) {
      return Promise.reject(new Error('Muse session is not connected'));
    }
    var body = util.utf8Encode(JSON.stringify(requestBody));
    var headers = this._httpHeaders([{ key: 'Content-Type', value: 'application/json' }]);
    var uploadInParts = body.length > MAX_INLINE_REQUEST_BYTES;
    var encrypted = uploadInParts
      ? this._transport.startStreamRequest('POST', CHAT_PATH, 'daemon', headers)
      : this._transport.encryptHttpRequest('POST', CHAT_PATH, body, 'daemon', headers);
    var request = new _Request();
    this._requests.set(encrypted.streamId, request);

    this._sendFrames(encrypted.frames);
    if (uploadInParts) {
      for (var offset = 0; offset < body.length; offset += REQUEST_CHUNK_BYTES) {
        var part = body.subarray(offset, offset + REQUEST_CHUNK_BYTES);
        var frames = this._transport.encryptBodyChunk(
          encrypted.streamId, part, 'daemon', offset + part.length === body.length);
        this._sendFrames(frames);
      }
    }

    var timeout = new Promise(function (resolve, reject) {
      setTimeout(function () { reject(new Error('chat request timed out')); },
        REQUEST_TIMEOUT_S * 1000);
    });
    return Promise.race([request.done, timeout])
      .then(function (result) {
        self._requests.delete(encrypted.streamId);
        var decoded = null;
        if (result.body.length) {
          try {
            decoded = JSON.parse(util.utf8Decode(result.body));
          } catch (err) {
            decoded = util.utf8Decode(result.body).slice(0, 2000);
          }
        }
        return { ok: result.status >= 200 && result.status < 300, status: result.status, response: decoded };
      })
      .catch(function (err) {
        self._requests.delete(encrypted.streamId);
        self._resetStream(encrypted.streamId);
        throw err;
      });
  };

  LinkSession.prototype._resetStream = function (streamId) {
    if (!this._running) return;
    try {
      this._sendFrames(this._transport.encryptReset(streamId, 'daemon', 'consumer closed'));
    } catch (err) {
      // Best effort, as in the SDK.
    }
  };

  /* -- Receiving ------------------------------------------------------------- */

  LinkSession.prototype._attachReader = function () {
    var self = this;
    var decoder = new controlFraming.MessageDecoder(function (length) {
      self._log('dropping malformed control message (' + length + ' bytes)');
    });
    this._ws.addEventListener('message', function (event) {
      if (self._finished) return;
      var raw = event.data;
      if (typeof raw === 'string') {
        self._log('ignoring text frame on Noise connection');
        return;
      }
      var frame;
      try {
        frame = self._transport.decryptFrame(new Uint8Array(raw));
      } catch (err) {
        self._log('transport failed: ' + err.message);
        self._finish(Outcome.CLOSED);
        return;
      }
      if (frame === null) return;
      if (frame.streamId !== self._streamId) {
        var request = self._requests.get(frame.streamId);
        if (request) request.onFrame(frame);
        return;
      }
      if (frame.kind === 'reset') {
        self._log('control stream reset: ' + frame.value.reason);
        self._finish(Outcome.CLOSED);
        return;
      }
      var data, ended;
      if (frame.kind === 'response') {
        if (frame.value.status >= 400) {
          self._log('/link-control refused: HTTP ' + frame.value.status);
          self._finish(frame.value.status === 403 ? Outcome.FORBIDDEN : Outcome.CLOSED);
          return;
        }
        data = frame.value.body;
        ended = frame.value.endBody;
      } else {
        data = frame.value.data;
        ended = frame.value.endBody;
      }
      var messages;
      try {
        messages = decoder.feed(data);
      } catch (err) {
        self._log('control stream framing failed: ' + err.message);
        self._finish(Outcome.CLOSED);
        return;
      }
      for (var i = 0; i < messages.length; i++) {
        var outcome = self._handle(messages[i]);
        if (outcome) {
          self._finish(outcome);
          return;
        }
      }
      if (ended) {
        self._log('control stream ended by VM');
        self._finish(Outcome.CLOSED);
      }
    });
    this._ws.addEventListener('close', function () {
      if (!self._finished) self._finish(Outcome.CLOSED);
    });
    this._ws.addEventListener('error', function () {
      if (!self._finished) self._finish(Outcome.CLOSED);
    });
  };

  // Returns an Outcome string when the session must end, else null.
  LinkSession.prototype._handle = function (message) {
    if (message.id === this._registerId && (message.method === undefined || message.method === null)) {
      if (message.error || message.ok === false) {
        this._log('link.register rejected');
        return Outcome.FORBIDDEN;
      }
      this.registeredAt = this._now();
      this._log('registered with the Muse');
      if (this._onRegistered) this._onRegistered();
      return null;
    }
    var event = message.event;
    if (event === 'link.unpaired' || event === 'node.unpaired') {
      this._log('the Muse removed this device');
      return Outcome.UNPAIRED;
    }
    if (message.method === 'link.invoke') {
      this._invoke(message);
    }
    return null;
  };

  LinkSession.prototype._invoke = function (message) {
    var self = this;
    var invokeId = message.id;
    var command = typeof message.command === 'string' ? message.command : '';
    var params = (message.params && typeof message.params === 'object' && !Array.isArray(message.params))
      ? message.params : {};
    var timeoutMs = message.timeout_ms || null;
    if (!invokeId) return;
    this._invokes.acquire().then(function () {
      var started = Date.now();
      var resultPromise;
      try {
        resultPromise = Promise.resolve(self._runCommand(command, params, timeoutMs));
      } catch (err) {
        resultPromise = Promise.reject(err);
      }
      return resultPromise
        .catch(function (err) {
          return { ok: false, error: String((err && err.message) || err) };
        })
        .then(function (result) {
          self._invokes.release();
          self._log('invoke ' + command + ' -> ' + (result && result.ok ? 'ok' : 'failed') +
            ' in ' + (Date.now() - started) + ' ms');
          if (self._finished) return;
          var reply = { method: 'link.result', id: invokeId };
          Object.keys(result || {}).forEach(function (k) { reply[k] = result[k]; });
          try {
            self.send(reply);
          } catch (err) {
            self._log('could not send link.result: ' + err.message);
          }
        });
    });
  };

  MG.linkSession = {
    LinkSession: LinkSession,
    DeviceDescription: DeviceDescription,
    Outcome: Outcome,
    noiseUrl: noiseUrl,
    CONTROL_PATH: CONTROL_PATH,
    CHAT_PATH: CHAT_PATH,
    APP_ID: APP_ID,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.linkSession;
})(typeof globalThis !== 'undefined' ? globalThis : this);
