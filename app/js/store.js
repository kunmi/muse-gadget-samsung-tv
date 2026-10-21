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
 * Persistent state in localStorage, mirroring the SDK's state directory
 * (linux/src/musegadget/config.py):
 *
 *   sdk token   -> the mgst_… token from gadgets.muse.ai (validated with
 *                  the same shape config.py enforces)
 *   pairing     -> the pairing record saved by a completed provisioning:
 *                  {access_token, refresh_token, token_type: "device",
 *                   username, api_url, api_url_v2, noise_host,
 *                   access_token_saved_at, sdk_token_hint}
 *
 * Nothing here ever invents a pairing: a record exists only after the
 * provisioning path saved one (see pairing.js and PROTOCOL.md).
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  // mgst_ plus 43 canonical base64url characters, as issued by
  // gadgets.muse.ai (config.py's _SDK_TOKEN).
  var SDK_TOKEN_RE = /^mgst_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

  var KEY_SDK_TOKEN = 'museGadgetTv.sdkToken';
  var KEY_PAIRING = 'museGadgetTv.pairing';

  function isValidSdkToken(token) {
    return typeof token === 'string' && SDK_TOKEN_RE.test(token.trim());
  }

  // The part of an SDK token gadgets.muse.ai shows, or "none".
  function sdkTokenHint(token) {
    return token ? token.slice(0, 12) : 'none';
  }

  function Store(storage) {
    this._storage = storage;
  }

  Store.prototype.getSdkToken = function () {
    var token = null;
    try {
      token = this._storage.getItem(KEY_SDK_TOKEN);
    } catch (err) {
      return null;
    }
    if (!token) return null;
    token = String(token).trim();
    if (!token) return null;
    if (!isValidSdkToken(token)) {
      throw new Error('the SDK token is not valid; copy it again from gadgets.muse.ai');
    }
    return token;
  };

  Store.prototype.setSdkToken = function (token) {
    token = String(token || '').trim();
    if (!isValidSdkToken(token)) {
      throw new Error('the SDK token is not valid; copy it again from gadgets.muse.ai');
    }
    this._storage.setItem(KEY_SDK_TOKEN, token);
    return token;
  };

  Store.prototype.clearSdkToken = function () {
    try { this._storage.removeItem(KEY_SDK_TOKEN); } catch (err) { /* ignore */ }
  };

  Store.prototype.getPairing = function () {
    try {
      var raw = this._storage.getItem(KEY_PAIRING);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' &&
          typeof parsed.access_token === 'string' &&
          typeof parsed.refresh_token === 'string') {
        return parsed;
      }
      return null;
    } catch (err) {
      return null;
    }
  };

  Store.prototype.setPairing = function (record) {
    this._storage.setItem(KEY_PAIRING, JSON.stringify(record));
  };

  Store.prototype.clearPairing = function () {
    try { this._storage.removeItem(KEY_PAIRING); } catch (err) { /* ignore */ }
  };

  MG.store = {
    Store: Store,
    isValidSdkToken: isValidSdkToken,
    sdkTokenHint: sdkTokenHint,
    SDK_TOKEN_RE: SDK_TOKEN_RE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
