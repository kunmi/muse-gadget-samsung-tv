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
 * Web login (pairing transfer): how a gadget with no Bluetooth logs in to
 * Muse over the web alone. This is the flow the community PSP port
 * established (wobsoriano/muse-gadget-psp: README "Pair it with Muse",
 * tools/pair.py, src/store.rs), built entirely from Muse Gadget SDK file
 * formats:
 *
 *   - A completed pairing is two small files in a gadget client's state
 *     directory (/var/lib/musegadget by default; SDK config.py):
 *       identity.json  {"mac": "aa:bb:cc:dd:ee:ff"}
 *       pairing.json   {access_token, refresh_token, token_type: "device",
 *                       username, api_url, api_url_v2, noise_host,
 *                       access_token_saved_at, sdk_token_hint}
 *     (the record pair.py's _verify_and_save saves after provisioning).
 *   - The identity is just the MAC: every client derives the node id
 *     ("homelink-" + last 6 hex digits) from it, and that node id is what
 *     registration and token refresh present (SDK identity.py, service.py;
 *     PSP src/store.rs). Tokens therefore belong to the identity in
 *     identity.json — importing them without it strands them on the wrong
 *     node id, which is why this login adopts the MAC along with the pair.
 *   - One BLE-capable client (e.g. the SDK's Linux client) runs the
 *     Bluetooth pairing conversation with the Muse app once; the user
 *     copies the two files to this TV and pastes them here. The helper
 *     client must then stay off: only one device can use an identity at a
 *     time, and every token rotation replaces the pair (PSP README).
 *   - The TV verifies the credentials before saving anything — the SDK's
 *     own gate (pair.py): GET /fetch_vms with the access token must lease
 *     at least one VM. From then on the TV's whole login life is HTTPS:
 *     fetch_vms for sessions and POST /device_token/refresh for rotation
 *     (muse-api.js, service.js). No Bluetooth is involved on the TV.
 *
 * There is no browser/device-code sign-in for gadgets anywhere in the SDK
 * or the community ports: the initial device credentials are only ever
 * minted by the backend for the Muse app, which delivers them over BLE
 * (provision_v2; the ESP32 firmware's POST /device_token/mint likewise
 * only exchanges a user/session token the app handed it during that same
 * provisioning). See PROTOCOL.md, gap 1.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  // The MAC shape tools/pair.py enforces on identity.json.
  var MAC_RE = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
  // The fields a pairing must carry (tools/pair.py's PAIRING_FIELDS).
  var PAIRING_FIELDS = ['access_token', 'refresh_token'];

  function parseJsonFile(text, name) {
    var data;
    try {
      data = JSON.parse(String(text == null ? '' : text).trim());
    } catch (err) {
      throw new Error(name + ' is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(name + ' does not hold a JSON object');
    }
    return data;
  }

  // identity.json -> the MAC, lowercased (the SDK stores lowercase; the
  // node id is derived from these digits, so case must not drift).
  function parseIdentityJson(text) {
    var identity = parseJsonFile(text, 'identity.json');
    var mac = identity.mac;
    if (typeof mac !== 'string' || !MAC_RE.test(mac.trim())) {
      throw new Error('identity.json has no usable "mac"');
    }
    return mac.trim().toLowerCase();
  }

  // pairing.json -> the credentials verify-and-save consumes, in the shape
  // ble_setup.py's provision_v2 carries and pair.py saves. Unknown fields
  // are not carried into the saved record (the SDK's record shape is fixed;
  // store.js documents it).
  function parsePairingJson(text) {
    var pairing = parseJsonFile(text, 'pairing.json');
    var missing = PAIRING_FIELDS.filter(function (field) {
      return typeof pairing[field] !== 'string' || !pairing[field];
    });
    if (missing.length) {
      throw new Error('pairing.json is missing: ' + missing.join(', ') +
        '. Has that device finished pairing?');
    }
    function field(key) {
      return typeof pairing[key] === 'string' ? pairing[key] : '';
    }
    return {
      access_token: pairing.access_token,
      refresh_token: pairing.refresh_token,
      username: field('username'),
      api_url: field('api_url'),
      api_url_v2: field('api_url_v2'),
      noise_host: field('noise_host'),
    };
  }

  function parseTransfer(identityText, pairingText) {
    return {
      mac: parseIdentityJson(identityText),
      credentials: parsePairingJson(pairingText),
    };
  }

  function nodeIdForMac(mac) {
    return 'homelink-' + mac.replace(/:/g, '').slice(-6);
  }

  // deps: {fetchVms, apiRoot, store, sdkToken, nowSeconds, adoptIdentity}
  // adoptIdentity(mac) persists the identity and returns the adopted
  // Identity (MG.identity.adoptMac). It runs inside the verify-and-save
  // commit — after fetch_vms has accepted the credentials and in the same
  // step that saves the pairing — so a rejected transfer changes nothing
  // on the TV: no pairing saved, identity untouched. Resolves
  // {record, mac, nodeId}; rejects with the parse error or pair.py's
  // ProvisionFailed (status "auth_failed" when the API leases no VM).
  function login(deps, identityText, pairingText) {
    var transfer = parseTransfer(identityText, pairingText);
    var mac = transfer.mac;
    function commit(save) {
      var ok = save();
      if (ok) deps.adoptIdentity(mac);
      return ok;
    }
    return MG.pairing.verifyAndSaveProvisioning(transfer.credentials, commit, deps)
      .then(function (record) {
        return { record: record, mac: mac, nodeId: nodeIdForMac(mac) };
      });
  }

  MG.webLogin = {
    MAC_RE: MAC_RE,
    PAIRING_FIELDS: PAIRING_FIELDS,
    parseIdentityJson: parseIdentityJson,
    parsePairingJson: parsePairingJson,
    parseTransfer: parseTransfer,
    nodeIdForMac: nodeIdForMac,
    login: login,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.webLogin;
})(typeof globalThis !== 'undefined' ? globalThis : this);
