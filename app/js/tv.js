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
 * Thin, defensive wrappers over the Samsung Tizen web APIs the gadget
 * commands need. Every entry point is feature-detected and wrapped in
 * try/catch: a TV model or runtime without an API yields {available:false}
 * or a thrown Error with a plain message, never a crash. These run only on
 * the TV; in Node (tests) everything reports unavailable.
 *
 * APIs used (Tizen web device APIs / Samsung product APIs):
 *   tizen.tvaudiocontrol   volume + mute (privilege tv.audio)
 *   webapis.tvaudiocontrol (fallback location of the same control)
 *   tizen.application      launch apps by id (privilege application.launch)
 *   webapis.productinfo    model / firmware / version strings
 *   tizen.systeminfo       build info + storage units
 *   webapis.network        active connection type
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  function tizenApi() {
    return typeof root.tizen !== 'undefined' ? root.tizen : null;
  }

  function webapisApi() {
    return typeof root.webapis !== 'undefined' ? root.webapis : null;
  }

  function audioControl() {
    var t = tizenApi();
    if (t && t.tvaudiocontrol) return t.tvaudiocontrol;
    var w = webapisApi();
    if (w && w.tvaudiocontrol) return w.tvaudiocontrol;
    return null;
  }

  var volume = {
    available: function () {
      var ac = audioControl();
      return !!(ac && typeof ac.getVolume === 'function');
    },
    get: function () {
      var ac = audioControl();
      if (!ac) throw new Error('TV audio control is not available on this device');
      return ac.getVolume(); // 0..100
    },
    set: function (level) {
      var ac = audioControl();
      if (!ac || typeof ac.setVolume !== 'function') {
        throw new Error('TV audio control is not available on this device');
      }
      if (typeof level !== 'number' || level < 0 || level > 100) {
        throw new Error('volume level must be between 0 and 100');
      }
      ac.setVolume(Math.round(level));
      return ac.getVolume();
    },
    up: function (step) {
      var ac = audioControl();
      if (!ac) throw new Error('TV audio control is not available on this device');
      if (step && typeof ac.setVolume === 'function') {
        return this.set(Math.min(100, ac.getVolume() + step));
      }
      if (typeof ac.setVolumeUp === 'function') ac.setVolumeUp();
      return ac.getVolume();
    },
    down: function (step) {
      var ac = audioControl();
      if (!ac) throw new Error('TV audio control is not available on this device');
      if (step && typeof ac.setVolume === 'function') {
        return this.set(Math.max(0, ac.getVolume() - step));
      }
      if (typeof ac.setVolumeDown === 'function') ac.setVolumeDown();
      return ac.getVolume();
    },
    isMuted: function () {
      var ac = audioControl();
      if (!ac) throw new Error('TV audio control is not available on this device');
      if (typeof ac.isMute === 'function') return !!ac.isMute();
      if (typeof ac.getMute === 'function') return !!ac.getMute();
      throw new Error('mute state is not available on this device');
    },
    setMuted: function (muted) {
      var ac = audioControl();
      if (!ac || typeof ac.setMute !== 'function') {
        throw new Error('TV audio control is not available on this device');
      }
      ac.setMute(!!muted);
      return this.isMuted();
    },
  };

  function launchApp(appId) {
    return new Promise(function (resolve, reject) {
      var t = tizenApi();
      if (!t || !t.application || typeof t.application.launch !== 'function') {
        reject(new Error('application launch is not available on this device'));
        return;
      }
      if (typeof appId !== 'string' || !appId) {
        reject(new Error('app_id is required'));
        return;
      }
      try {
        t.application.launch(
          appId,
          function () { resolve({ launched: appId }); },
          function (err) { reject(new Error('could not launch ' + appId + ': ' + (err && err.message || err))); }
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  function currentAppId() {
    try {
      var t = tizenApi();
      if (t && t.application && t.application.getCurrentApplication) {
        return t.application.getCurrentApplication().appInfo.id || null;
      }
    } catch (err) { /* ignore */ }
    return null;
  }

  function exitApp() {
    try {
      var t = tizenApi();
      if (t && t.application && t.application.getCurrentApplication) {
        t.application.getCurrentApplication().exit();
      }
    } catch (err) { /* ignore */ }
  }

  // Best-effort device facts for device.health; every field is optional.
  function deviceInfo() {
    var info = {};
    var w = webapisApi();
    if (w && w.productinfo) {
      var p = w.productinfo;
      try { if (p.getModel) info.model = p.getModel(); } catch (err) { /* ignore */ }
      try { if (p.getFirmware) info.firmware = p.getFirmware(); } catch (err) { /* ignore */ }
      try { if (p.getVersion) info.product_version = p.getVersion(); } catch (err) { /* ignore */ }
      try { if (p.getRealModel) info.real_model = p.getRealModel(); } catch (err) { /* ignore */ }
    }
    var t = tizenApi();
    if (t && t.systeminfo && typeof t.systeminfo.getCapability === 'function') {
      try {
        var version = t.systeminfo.getCapability('http://tizen.org/feature/platform.version');
        if (version) info.tizen_version = version;
      } catch (err) { /* ignore */ }
    }
    if (w && w.network && typeof w.network.getActiveConnectionType === 'function') {
      try {
        var types = ['none', 'wifi', 'cellular', 'ethernet'];
        var type = w.network.getActiveConnectionType();
        info.network = types[type] || String(type);
      } catch (err) { /* ignore */ }
    }
    return info;
  }

  // Storage units via tizen.systeminfo; resolves null when unavailable.
  function storageInfo() {
    return new Promise(function (resolve) {
      var t = tizenApi();
      if (!t || !t.systeminfo || typeof t.systeminfo.getPropertyValue !== 'function') {
        resolve(null);
        return;
      }
      var timer = setTimeout(function () { resolve(null); }, 3000);
      try {
        t.systeminfo.getPropertyValue('STORAGE', function (storage) {
          clearTimeout(timer);
          try {
            var units = (storage && storage.units) || [];
            var total = 0, available = 0;
            units.forEach(function (unit) {
              total += unit.capacity || 0;
              available += unit.availableCapacity || 0;
            });
            resolve({ total_bytes: total, available_bytes: available });
          } catch (err) {
            resolve(null);
          }
        }, function () {
          clearTimeout(timer);
          resolve(null);
        });
      } catch (err) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  MG.tv = {
    volume: volume,
    launchApp: launchApp,
    currentAppId: currentAppId,
    exitApp: exitApp,
    deviceInfo: deviceInfo,
    storageInfo: storageInfo,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.tv;
})(typeof globalThis !== 'undefined' ? globalThis : this);
