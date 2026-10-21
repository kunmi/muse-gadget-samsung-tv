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
 * UI wiring for Muse Gadget TV: the ambient screen, the setup/onboarding
 * screen, the display-card overlay, remote-friendly spatial navigation, and
 * the gadget service lifecycle. All protocol work lives in the MG modules;
 * this file is presentation and glue only.
 */
(function () {
  'use strict';
  var MG = window.MG;

  /* ---------- storage (with an in-memory fallback) ---------- */
  function memoryStorage() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; },
    };
  }
  var storage;
  try {
    storage = window.localStorage;
    storage.setItem('museGadgetTv.probe', '1');
    storage.removeItem('museGadgetTv.probe');
  } catch (err) {
    storage = memoryStorage();
  }

  /* ---------- core objects ---------- */
  var startedAt = Date.now();
  var identity = MG.identity.loadOrCreate(storage);
  var store = new MG.store.Store(storage);
  var version = MG.museApi.VERSION;

  function el(id) { return document.getElementById(id); }

  /* ---------- display-card overlay (executor UI hooks) ---------- */
  var cardTimer = null;
  function showCard() {
    el('card-overlay').classList.remove('hidden');
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = setTimeout(hideCard, 120000);
  }
  function hideCard() {
    el('card-overlay').classList.add('hidden');
    if (cardTimer) { clearTimeout(cardTimer); cardTimer = null; }
  }
  function resetCard() {
    el('card-title').classList.add('hidden');
    el('card-text').classList.add('hidden');
    el('card-image').classList.add('hidden');
    el('card-lines').classList.add('hidden');
    el('card-caption').classList.add('hidden');
  }
  var ui = {
    showText: function (card) {
      resetCard();
      if (card.title) {
        el('card-title').textContent = card.title;
        el('card-title').classList.remove('hidden');
      }
      el('card-text').textContent = card.text;
      el('card-text').classList.remove('hidden');
      showCard();
    },
    showImage: function (card) {
      resetCard();
      var img = el('card-image');
      img.src = card.url;
      img.classList.remove('hidden');
      if (card.caption) {
        el('card-caption').textContent = card.caption;
        el('card-caption').classList.remove('hidden');
      }
      showCard();
    },
    showBriefing: function (card) {
      resetCard();
      el('card-title').textContent = card.title;
      el('card-title').classList.remove('hidden');
      var list = el('card-lines');
      list.innerHTML = '';
      card.lines.forEach(function (line) {
        var li = document.createElement('li');
        li.textContent = line;
        list.appendChild(li);
      });
      list.classList.remove('hidden');
      showCard();
    },
  };

  var executor = MG.executor.createExecutor(ui, {
    startedAt: startedAt,
    nodeId: identity.nodeId,
    version: version,
  });

  /* ---------- service + status UI ---------- */
  var pill = el('status-pill');
  function setPill(text, cls) {
    pill.textContent = text;
    pill.className = 'status-pill ' + cls;
  }

  var service = new MG.service.GadgetService({
    identity: identity,
    store: store,
    runCommand: executor.run,
    commands: MG.executor.COMMAND_SPECS,
    version: version,
    log: function (msg) {
      if (window.console) console.log('[musegadget] ' + msg);
    },
    onState: function (state, detail) {
      if (state === 'unpaired') {
        setPill('Not paired', 'status-warn');
        renderPairingState();
      } else if (state === 'connecting') {
        setPill('Connecting to Muse…', 'status-idle');
      } else if (state === 'registered') {
        setPill('Connected to Muse', 'status-ok');
      } else if (state === 'waiting') {
        setPill('Reconnecting…', 'status-warn');
      } else if (state === 'stopped') {
        setPill('Stopped', 'status-idle');
      }
    },
  });

  function toast(message) {
    var t = el('toast');
    t.textContent = message;
    setTimeout(function () {
      if (t.textContent === message) t.textContent = '';
    }, 8000);
  }

  /* ---------- screens ---------- */
  var currentScreen = 'main';
  function showScreen(name) {
    currentScreen = name;
    el('screen-main').classList.toggle('hidden', name !== 'main');
    el('screen-setup').classList.toggle('hidden', name !== 'setup');
    focusFirst(name);
  }

  /* ---------- spatial navigation ---------- */
  function focusables() {
    var screen = currentScreen === 'main' ? el('screen-main') : el('screen-setup');
    var nodes = screen.querySelectorAll('button, input');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null) out.push(nodes[i]);
    }
    return out;
  }
  var focusedEl = null;
  function setFocus(node) {
    if (focusedEl) focusedEl.classList.remove('focused');
    focusedEl = node;
    if (node) {
      node.classList.add('focused');
      if (node.tagName === 'INPUT') node.focus();
      else if (document.activeElement && document.activeElement.tagName === 'INPUT') {
        document.activeElement.blur();
      }
    }
  }
  function focusFirst(screenName) {
    var list = focusables();
    if (list.length) setFocus(list[0]);
  }
  function moveFocus(direction) {
    var list = focusables();
    if (!list.length) return;
    if (!focusedEl || list.indexOf(focusedEl) < 0) {
      setFocus(list[0]);
      return;
    }
    var rect = focusedEl.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var best = null;
    var bestScore = Infinity;
    list.forEach(function (node) {
      if (node === focusedEl) return;
      var r = node.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      var dx = x - cx;
      var dy = y - cy;
      var primary, cross;
      if (direction === 'left') { if (dx >= -4) return; primary = -dx; cross = Math.abs(dy); }
      else if (direction === 'right') { if (dx <= 4) return; primary = dx; cross = Math.abs(dy); }
      else if (direction === 'up') { if (dy >= -4) return; primary = -dy; cross = Math.abs(dx); }
      else { if (dy <= 4) return; primary = dy; cross = Math.abs(dx); }
      var score = primary + cross * 2.5;
      if (score < bestScore) { bestScore = score; best = node; }
    });
    if (best) setFocus(best);
  }

  var BACK_KEYS = { XF86Back: true, GoBack: true, BrowserBack: true, Escape: true };
  document.addEventListener('keydown', function (event) {
    var key = event.key;
    if (!el('card-overlay').classList.contains('hidden')) {
      hideCard();
      event.preventDefault();
      return;
    }
    var editing = document.activeElement && document.activeElement.tagName === 'INPUT';
    if (key === 'ArrowUp') { moveFocus('up'); event.preventDefault(); }
    else if (key === 'ArrowDown') { moveFocus('down'); event.preventDefault(); }
    else if (key === 'ArrowLeft' && !editing) { moveFocus('left'); event.preventDefault(); }
    else if (key === 'ArrowRight' && !editing) { moveFocus('right'); event.preventDefault(); }
    else if (key === 'Enter') {
      if (focusedEl && focusedEl.tagName === 'BUTTON') {
        focusedEl.click();
        event.preventDefault();
      }
    } else if (BACK_KEYS[key] || event.keyCode === 10009 || event.keyCode === 461) {
      if (editing) return; // let the IME/back handling work while typing
      if (currentScreen === 'setup') showScreen('main');
      event.preventDefault();
    }
  });

  /* ---------- clock ---------- */
  function tickClock() {
    var now = new Date();
    var hh = ('0' + now.getHours()).slice(-2);
    var mm = ('0' + now.getMinutes()).slice(-2);
    el('clock').textContent = hh + ':' + mm;
    el('dateline').textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  }
  tickClock();
  setInterval(tickClock, 1000);

  /* ---------- setup screen content ---------- */
  el('id-display-name').textContent = identity.displayName;
  el('id-node-id').textContent = identity.nodeId;
  el('id-ble-name').textContent = identity.bleName;
  el('identity-line').textContent =
    identity.displayName + ' · ' + identity.nodeId;

  function renderSdkTokenState() {
    var state = el('sdk-token-state');
    var token = null;
    try {
      token = store.getSdkToken();
    } catch (err) {
      state.textContent = err.message;
      state.classList.add('error');
      return;
    }
    if (token) {
      state.textContent = 'Saved: ' + MG.store.sdkTokenHint(token) + '…';
      state.classList.remove('error');
    } else {
      state.textContent = 'No token saved yet.';
      state.classList.remove('error');
    }
  }

  function renderPairingState() {
    var pairing = store.getPairing();
    var node = el('pairing-state');
    if (pairing) {
      var when = pairing.access_token_saved_at
        ? new Date(pairing.access_token_saved_at * 1000).toLocaleString()
        : 'unknown time';
      node.textContent = 'Paired: device credentials are saved (last rotated ' + when + ').';
    } else {
      node.textContent = 'Not paired: no device credentials are saved on this TV.';
    }
  }

  el('sdk-token-save').addEventListener('click', function () {
    var state = el('sdk-token-state');
    var value = el('sdk-token-input').value;
    try {
      store.setSdkToken(value);
      el('sdk-token-input').value = '';
      renderSdkTokenState();
    } catch (err) {
      state.textContent = err.message;
      state.classList.add('error');
    }
  });

  el('import-save').addEventListener('click', function () {
    var state = el('import-state');
    var access = el('import-access').value.trim();
    var refresh = el('import-refresh').value.trim();
    var noiseHost = el('import-noise-host').value.trim();
    if (!access || !refresh) {
      state.textContent = 'Enter both device tokens.';
      state.classList.add('error');
      return;
    }
    state.textContent = 'Checking the credentials with Muse…';
    state.classList.remove('error');
    var credentials = {
      access_token: access,
      refresh_token: refresh,
      token_type: 'device',
      username: '',
      api_url: '',
      api_url_v2: '',
      noise_host: noiseHost,
      ssid: 'imported',
      password: '',
    };
    var sdkToken = null;
    try { sdkToken = store.getSdkToken(); } catch (err) { sdkToken = null; }
    MG.pairing.verifyAndSaveProvisioning(
      credentials,
      function (save) { return save(); }, // no BLE session in the import path
      {
        fetchVms: MG.museApi.fetchVms,
        apiRoot: MG.museApi.apiRoot,
        store: store,
        sdkToken: sdkToken,
        nowSeconds: function () { return Date.now() / 1000; },
      }
    ).then(function () {
      state.textContent = 'Paired. The credentials checked out and are saved.';
      el('import-access').value = '';
      el('import-refresh').value = '';
      renderPairingState();
      service.disconnectSession();
      showScreen('main');
    }).catch(function (err) {
      state.textContent = 'Pairing failed: ' + (err && err.status ? err.status : err.message) +
        '. Nothing was saved.';
      state.classList.add('error');
    });
  });

  el('unpair').addEventListener('click', function () {
    store.clearPairing();
    service.disconnectSession();
    renderPairingState();
    el('import-state').textContent = 'Unpaired. Device credentials were removed from this TV.';
    el('import-state').classList.remove('error');
  });

  el('open-settings').addEventListener('click', function () {
    renderSdkTokenState();
    renderPairingState();
    showScreen('setup');
  });
  el('setup-back').addEventListener('click', function () { showScreen('main'); });

  /* ---------- chat composer ---------- */
  function sendChat() {
    var input = el('chat-input');
    var text = input.value.trim();
    if (!text) return;
    service.sendChat(text).then(function (result) {
      if (result.ok) {
        input.value = '';
        toast('Sent to Muse.');
      } else {
        toast('Muse refused the message (HTTP ' + result.status + ').');
      }
    }).catch(function (err) {
      toast(err.message || 'Not connected to Muse.');
    });
  }
  el('chat-send').addEventListener('click', sendChat);
  el('chat-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      sendChat();
      event.preventDefault();
    }
    event.stopPropagation();
  });

  /* ---------- boot ---------- */
  renderSdkTokenState();
  renderPairingState();
  showScreen(store.getPairing() ? 'main' : 'setup');
  service.start();
})();
