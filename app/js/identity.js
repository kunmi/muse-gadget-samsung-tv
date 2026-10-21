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
 * Port of the Muse Gadget SDK's linux/src/musegadget/identity.py.
 *
 * The identity is a random, locally administered MAC-shaped value generated
 * once and kept across unpairing. It is never read from a network interface,
 * so it never exposes the TV's real hardware address. Derived names follow
 * the conventions the Muse apps expect:
 *
 *   node_id      "homelink-" + last 6 hex digits of the MAC
 *   device_id    "hatch-link:" + MAC        (protocol constant, keep as-is)
 *   ble_name     "MuseGadget" + 6 hex UPPERCASE (no separator)
 *   display_name "MuseGadgetTV" + 6 hex UPPERCASE (what this TV registers)
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var util = MG.util;

  var NODE_ID_PREFIX = 'homelink-';
  var BLE_NAME_PREFIX = 'MuseGadget';
  var DISPLAY_NAME_PREFIX = 'MuseGadgetTV';
  var MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
  // The MAC shape tools/pair.py in the community PSP port accepts in an
  // identity.json (either case; the SDK stores lowercase).
  var MAC_RE_ANY_CASE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
  var STORAGE_KEY = 'museGadgetTv.identity';

  function generateMac() {
    var octets = util.randomBytes(6);
    octets[0] = (octets[0] & 0xfc) | 0x02; // unicast, locally administered
    var parts = [];
    for (var i = 0; i < 6; i++) parts.push(('0' + octets[i].toString(16)).slice(-2));
    return parts.join(':');
  }

  function Identity(mac) {
    this.mac = mac;
  }

  Object.defineProperties(Identity.prototype, {
    suffix: {
      get: function () { return this.mac.replace(/:/g, '').slice(-6); },
    },
    nodeId: {
      get: function () { return NODE_ID_PREFIX + this.suffix; },
    },
    deviceId: {
      get: function () { return 'hatch-link:' + this.mac; },
    },
    bleName: {
      get: function () { return BLE_NAME_PREFIX + this.suffix.toUpperCase(); },
    },
    displayName: {
      get: function () { return DISPLAY_NAME_PREFIX + this.suffix.toUpperCase(); },
    },
  });

  // storage is a localStorage-like object ({getItem, setItem}); injected so
  // the module is testable in Node.
  function loadOrCreate(storage) {
    var mac = null;
    try {
      var raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.mac === 'string' && MAC_RE.test(parsed.mac)) {
          mac = parsed.mac;
        }
      }
    } catch (err) {
      mac = null;
    }
    if (mac) return new Identity(mac);
    var identity = new Identity(generateMac());
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ mac: identity.mac }));
    } catch (err) {
      // Storage unavailable (private mode etc.): the identity lives for this
      // run only. The pairing record would not survive either, so the app
      // surfaces "not paired" again next launch rather than faking state.
    }
    return identity;
  }

  // Adopts the identity from a completed pairing's identity.json — the
  // web-login (pairing transfer) path in web-login.js. A pairing's device
  // tokens belong to the identity they were issued to: the SDK's clients
  // derive the node id used at registration and at token refresh from this
  // MAC (linux/src/musegadget/identity.py; the PSP port's src/store.rs), so
  // importing tokens without their identity would leave the TV registering
  // and refreshing as the wrong device. The MAC is validated with the same
  // shape the PSP port's tools/pair.py enforces and stored lowercase, in
  // the SDK's own file format ({"mac": ...}), under the same storage key
  // loadOrCreate reads. Returns the adopted Identity.
  function adoptMac(storage, mac) {
    if (typeof mac !== 'string' || !MAC_RE_ANY_CASE.test(mac.trim())) {
      throw new Error('identity.json has no usable "mac"');
    }
    var normalized = mac.trim().toLowerCase();
    var identity = new Identity(normalized);
    storage.setItem(STORAGE_KEY, JSON.stringify({ mac: normalized }));
    return identity;
  }

  MG.identity = {
    Identity: Identity,
    generateMac: generateMac,
    loadOrCreate: loadOrCreate,
    adoptMac: adoptMac,
    MAC_RE: MAC_RE,
    MAC_RE_ANY_CASE: MAC_RE_ANY_CASE,
    STORAGE_KEY: STORAGE_KEY,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.identity;
})(typeof globalThis !== 'undefined' ? globalThis : this);
