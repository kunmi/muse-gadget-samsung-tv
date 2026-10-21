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
 * Port of the Muse Gadget SDK's linux/src/musegadget/muse_api.py: the Muse
 * device API client.
 *
 *   GET  /fetch_vms           Authorization: Bearer <device access token>,
 *                             X-API-Version: 1.0.0
 *   POST /device_token/refresh
 *                             Authorization: Bearer hatch_refresh:<token>,
 *                             body {"device_id": ..., "sdk_token": ...?}
 *
 * The refresh presents ONLY the refresh token, never the access token, and
 * strips an existing "hatch_refresh:" prefix (the raw token is whatever
 * follows the last ":"). A 401 from refresh means the pairing is revoked.
 *
 * Deviation: browsers forbid setting the User-Agent header from page code,
 * so on the TV the request carries the web runtime's own User-Agent. The
 * header is set wherever the platform allows it (it is observable in the
 * Node test suite). See PROTOCOL.md.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  var API_BASE = 'https://api.muse.ai';
  var FETCH_PATH = '/fetch_vms';
  var REFRESH_PATH = '/device_token/refresh';
  var API_VERSION = '1.0.0';
  var TIMEOUT_MS = 15000;
  var VERSION = '0.1.0'; // mirrors the SDK's musegadget __version__ lineage

  function apiRoot(apiUrlV2) {
    return (apiUrlV2 || API_BASE).replace(/\/+$/, '');
  }

  function userAgent() {
    return 'musegadget/' + VERSION + ' (Samsung TV; Tizen) JavaScript';
  }

  function fetchWithTimeout(url, options) {
    options = options || {};
    if (typeof AbortController !== 'undefined' && !options.signal) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
      options.signal = controller.signal;
      return fetch(url, options).then(
        function (resp) { clearTimeout(timer); return resp; },
        function (err) { clearTimeout(timer); throw err; }
      );
    }
    return fetch(url, options);
  }

  // Returns Promise<{vms: Array, status: number|null}> like
  // fetch_vms_with_status: status is null when no HTTP response arrived;
  // 401 means the device token was rejected.
  function fetchVms(accessToken, rootUrl) {
    var url = apiRoot(rootUrl) + FETCH_PATH;
    return fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'X-API-Version': API_VERSION,
        'User-Agent': userAgent(),
      },
    }).then(function (resp) {
      var status = resp.status;
      return resp.text().then(function (text) {
        if (status < 200 || status >= 300) return { vms: [], status: status };
        var data;
        try {
          data = JSON.parse(text);
        } catch (err) {
          return { vms: [], status: status };
        }
        return { vms: parseVmList(data), status: status };
      });
    }).catch(function () {
      return { vms: [], status: null };
    });
  }

  function parseVmList(data) {
    if (!data || typeof data !== 'object') return [];
    if (data.error_title || data.backend_error_code) return [];
    var vmList = data.vm_list;
    if (!Array.isArray(vmList)) return [];
    var vms = [];
    vmList.forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      var vmUrl = entry.vm_ws_url || entry.vm_url;
      var vmToken = entry.vm_auth_token;
      if (vmUrl && vmToken) {
        vms.push({
          vm_url: vmUrl,
          vm_auth_token: vmToken,
          vm_name: entry.vm_name || '',
          vm_id: entry.vm_id || '',
          is_default: !!entry['default'],
        });
      }
    });
    return vms;
  }

  // Returns Promise<{tokens: {access_token, refresh_token}|null, status}>.
  // Mirrors refresh_device_token: the access token is never presented.
  function refreshDeviceToken(refreshToken, deviceId, rootUrl, sdkToken) {
    var rawRefresh = String(refreshToken).split(':').pop();
    var body = { device_id: deviceId };
    if (sdkToken) body.sdk_token = sdkToken;
    var url = apiRoot(rootUrl) + REFRESH_PATH;
    return fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer hatch_refresh:' + rawRefresh,
        'Content-Type': 'application/json',
        'User-Agent': userAgent(),
      },
      body: JSON.stringify(body),
    }).then(function (resp) {
      var status = resp.status;
      return resp.text().then(function (text) {
        if (status < 200 || status >= 300) return { tokens: null, status: status };
        var data;
        try {
          data = JSON.parse(text);
        } catch (err) {
          return { tokens: null, status: status };
        }
        if (data && typeof data === 'object' &&
            data.payload && typeof data.payload === 'object') {
          data = data.payload;
        }
        if (data && data.access_token && data.refresh_token) {
          return {
            tokens: { access_token: data.access_token, refresh_token: data.refresh_token },
            status: 200,
          };
        }
        return { tokens: null, status: status };
      });
    }).catch(function () {
      return { tokens: null, status: null };
    });
  }

  MG.museApi = {
    API_BASE: API_BASE,
    VERSION: VERSION,
    apiRoot: apiRoot,
    userAgent: userAgent,
    fetchVms: fetchVms,
    refreshDeviceToken: refreshDeviceToken,
    parseVmList: parseVmList,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.museApi;
})(typeof globalThis !== 'undefined' ? globalThis : this);
