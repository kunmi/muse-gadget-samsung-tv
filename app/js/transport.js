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
 * Port of the Muse Gadget SDK's linux/src/musegadget/noise/transport.py.
 *
 * After the Noise XX handshake, each WebSocket binary frame is one
 * Noise-encrypted NoiseTransportFrame protobuf. Decrypted and reassembled,
 * device-to-VM payloads are ServiceRequest envelopes and VM-to-device
 * payloads are ServiceResponse envelopes, each wrapping a ServiceFrame.
 * Any failure poisons the transport, exactly as in the SDK.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var envelope = MG.envelope;
  var framing = MG.framing;
  var noise = MG.noise;

  var EMPTY_AD = new Uint8Array(0);

  var SERVICE_MAP = {
    daemon: envelope.ServiceType.SERVICE_DAEMON,
    sentinel: envelope.ServiceType.SERVICE_SENTINEL,
    vault: envelope.ServiceType.SERVICE_VAULT,
    authd: envelope.ServiceType.SERVICE_AUTHD,
  };

  function coerceService(service) {
    if (typeof service === 'number') return service;
    if (Object.prototype.hasOwnProperty.call(SERVICE_MAP, service)) return SERVICE_MAP[service];
    throw noise.NoiseProtocolError('unknown noise service: ' + service);
  }

  function NoiseTransport(sendCipher, recvCipher) {
    this._send = sendCipher;
    this._recv = recvCipher;
    this._decoder = new framing.NoiseFrameDecoder();
    this._nextStreamId = 1;
    this._dead = false;
  }

  NoiseTransport.prototype._assertAlive = function () {
    if (this._dead) throw noise.NoiseProtocolError('NoiseTransport: dead after prior failure');
  };

  // Returns {streamId, frames}: a complete request with its body, end_body set.
  NoiseTransport.prototype.encryptHttpRequest = function (method, path, body, service, headers) {
    return this._sendApplicationRequest({
      method: method, path: path, body: body || new Uint8Array(0),
      service: service === undefined ? 'daemon' : service,
      headers: headers || [], endBody: true,
    });
  };

  // Returns {streamId, frames}: a request whose body stays open for chunks.
  NoiseTransport.prototype.startStreamRequest = function (method, path, service, headers) {
    return this._sendApplicationRequest({
      method: method, path: path, body: new Uint8Array(0),
      service: service === undefined ? 'daemon' : service,
      headers: headers || [], endBody: false,
    });
  };

  NoiseTransport.prototype._sendApplicationRequest = function (opts) {
    this._assertAlive();
    try {
      var streamId = this._nextStreamId;
      this._nextStreamId += 1;
      var request = {
        verb: opts.method, path: opts.path, headers: opts.headers,
        body: opts.body, endBody: opts.endBody,
      };
      var frame = { streamId: streamId, kind: 'request', value: request };
      var frames = this._encryptRequest(coerceService(opts.service), frame);
      return { streamId: streamId, frames: frames };
    } catch (err) {
      this._dead = true;
      throw err;
    }
  };

  NoiseTransport.prototype.encryptBodyChunk = function (streamId, data, service, endBody) {
    this._assertAlive();
    try {
      var frame = {
        streamId: streamId, kind: 'body_chunk',
        value: { data: new Uint8Array(data), endBody: !!endBody },
      };
      return this._encryptRequest(
        coerceService(service === undefined ? 'daemon' : service), frame);
    } catch (err) {
      this._dead = true;
      throw err;
    }
  };

  NoiseTransport.prototype.encryptReset = function (streamId, service, reason, code) {
    this._assertAlive();
    try {
      var frame = {
        streamId: streamId, kind: 'reset',
        value: { code: code === undefined ? envelope.ResetCode.CANCELLED : code, reason: reason || '' },
      };
      return this._encryptRequest(
        coerceService(service === undefined ? 'daemon' : service), frame);
    } catch (err) {
      this._dead = true;
      throw err;
    }
  };

  // Returns {kind, streamId, value} or null while a message is incomplete.
  NoiseTransport.prototype.decryptFrame = function (ciphertext) {
    this._assertAlive();
    try {
      var plainFrame = this._recv.decryptWithAd(EMPTY_AD, ciphertext);
      var reassembled = this._decoder.decode(plainFrame);
      if (reassembled === null) return null;

      var response = envelope.decodeServiceResponse(reassembled);
      if (response.payload.length === 0) {
        throw noise.NoiseProtocolError('empty ServiceResponse payload');
      }
      var frame = envelope.decodeServiceFrame(response.payload);
      if (frame.kind === 'response' || frame.kind === 'body_chunk' || frame.kind === 'reset') {
        return { kind: frame.kind, streamId: frame.streamId, value: frame.value };
      }
      if (frame.kind === 'request') {
        throw noise.NoiseProtocolError('NoiseTransport: unexpected request frame from server');
      }
      return null;
    } catch (err) {
      this._dead = true;
      throw err;
    }
  };

  NoiseTransport.prototype._encryptRequest = function (service, frame) {
    var frameBytes = envelope.encodeServiceFrame(frame);
    var requestBytes = envelope.encodeServiceRequest({ service: service, payload: frameBytes });
    var protoFrames = framing.encodeNoiseFrames(requestBytes);
    var send = this._send;
    return protoFrames.map(function (pf) { return send.encryptWithAd(EMPTY_AD, pf); });
  };

  MG.transport = {
    NoiseTransport: NoiseTransport,
    // Helpers the SDK exposes for tests/tools, mirrored for the test suite.
    decodeRequestEnvelope: function (data) {
      var request = envelope.decodeServiceRequest(data);
      return envelope.decodeServiceFrame(request.payload);
    },
    encodeResponseEnvelope: function (frame) {
      return envelope.encodeServiceResponse({
        payload: envelope.encodeServiceFrame(frame),
      });
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.transport;
})(typeof globalThis !== 'undefined' ? globalThis : this);
