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
 * Port of the control-stream message framing from the Muse Gadget SDK's
 * linux/src/musegadget/link_client.py (encode_message / MessageDecoder):
 * every JSON message on the /link-control stream is prefixed with its
 * length as a little-endian u32. A zero length is a keepalive; malformed
 * JSON is dropped, never fatal; an announced length over 4 MiB is an error.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;

  var MAX_INBOUND_MESSAGE = 4 * 1024 * 1024;

  function encodeMessage(obj) {
    var data = util.utf8Encode(JSON.stringify(obj));
    var out = new Uint8Array(4 + data.length);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length, true); // little-endian
    out.set(data, 4);
    return out;
  }

  function MessageDecoder(onMalformed) {
    this._buf = new Uint8Array(0);
    this._onMalformed = onMalformed || function () {};
  }

  // Feeds bytes; returns the list of complete message objects.
  MessageDecoder.prototype.feed = function (data) {
    this._buf = util.concatBytes(this._buf, new Uint8Array(data));
    var messages = [];
    while (this._buf.length >= 4) {
      var dv = new DataView(this._buf.buffer, this._buf.byteOffset, this._buf.byteLength);
      var length = dv.getUint32(0, true);
      if (length > MAX_INBOUND_MESSAGE) {
        throw new Error('inbound message too large: ' + length);
      }
      if (this._buf.length < 4 + length) break;
      var raw = this._buf.subarray(4, 4 + length);
      this._buf = this._buf.subarray(4 + length);
      if (raw.length === 0) continue; // keepalive
      var message;
      try {
        message = JSON.parse(util.utf8Decode(raw));
      } catch (err) {
        this._onMalformed(length);
        continue;
      }
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        messages.push(message);
      }
    }
    return messages;
  };

  MG.controlFraming = {
    MAX_INBOUND_MESSAGE: MAX_INBOUND_MESSAGE,
    encodeMessage: encodeMessage,
    MessageDecoder: MessageDecoder,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.controlFraming;
})(typeof globalThis !== 'undefined' ? globalThis : this);
