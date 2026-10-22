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

  /* ---------- Bloop, the ambient avatar ---------- */
  // The state machine is pure (avatar.js); app.js feeds it the app's
  // events — service state, command execution, composer sends, speech —
  // and mount() mirrors the resolved state onto the ambient screen.
  var avatarCtl = MG.avatar.create();

  /* ---------- speech (text-to-speech) ---------- */
  // Feature-detected by MG.speech: a TV whose runtime exposes no
  // synthesiser or no voices simply stays silent.
  var speechCtl = MG.speech.create({
    synthesis: typeof window.speechSynthesis !== 'undefined' ? window.speechSynthesis : null,
    Utterance: typeof window.SpeechSynthesisUtterance !== 'undefined'
      ? window.SpeechSynthesisUtterance : null,
    storage: storage,
    onSpeakingChange: function (speakingNow) { avatarCtl.setSpeaking(speakingNow); },
  });

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

  /* ---------- service + status UI ---------- */
  var pill = el('status-pill');
  function setPill(text, cls) {
    pill.textContent = text;
    pill.className = 'status-pill ' + cls;
  }

  // Executor + service are rebuilt (not just restarted) when a web login
  // adopts a transferred pairing's identity: both capture the identity's
  // node id, so the old objects would keep speaking for the wrong device.
  var executor = null;
  var service = null;
  // Bloop works while a link command executes: display.* arrivals also
  // earn a wave once the command completes (avatar.js decides).
  function runCommandTracked(command, params, timeoutMs) {
    avatarCtl.commandStarted(command);
    function done() { avatarCtl.commandFinished(command); }
    try {
      var result = executor.run(command, params, timeoutMs);
      if (result && typeof result.then === 'function') {
        return result.then(
          function (value) { done(); return value; },
          function (err) { done(); throw err; }
        );
      }
      done();
      return result;
    } catch (err) {
      done();
      throw err;
    }
  }
  function buildRuntime() {
    executor = MG.executor.createExecutor(ui, {
      startedAt: startedAt,
      nodeId: identity.nodeId,
      version: version,
      speech: speechCtl,
    });
    service = new MG.service.GadgetService({
      identity: identity,
      store: store,
      runCommand: runCommandTracked,
      commands: MG.executor.COMMAND_SPECS,
      version: version,
      log: function (msg) {
        if (window.console) console.log('[musegadget] ' + msg);
      },
      onState: function (state, detail) {
        avatarCtl.serviceState(state);
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
  }
  function restartRuntime() {
    if (service) service.stop();
    buildRuntime();
    service.start();
  }
  buildRuntime();
  MG.avatar.mount(el('avatar'), avatarCtl);

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
  function isTextField(node) {
    return node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA');
  }
  function focusables() {
    var screen = currentScreen === 'main' ? el('screen-main') : el('screen-setup');
    var nodes = screen.querySelectorAll('button, input, textarea');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].offsetParent !== null) out.push(nodes[i]);
    }
    return out;
  }
  var focusedEl = null;
  // Visual/spatial focus only (the .focused ring + scroll into view);
  // setFocus adds the DOM-focus management on top.
  function paintFocus(node) {
    if (focusedEl) focusedEl.classList.remove('focused');
    focusedEl = node;
    if (node) {
      node.classList.add('focused');
      if (node.scrollIntoView) {
        try { node.scrollIntoView({ block: 'nearest' }); } catch (err) { /* older runtimes */ }
      }
    }
  }
  function setFocus(node) {
    paintFocus(node);
    if (node) {
      if (isTextField(node)) node.focus();
      else if (isTextField(document.activeElement)) {
        document.activeElement.blur();
      }
    }
  }
  function focusStep(delta) {
    var list = focusables();
    if (!list.length) return;
    var idx = list.indexOf(focusedEl);
    if (idx < 0) idx = delta > 0 ? -1 : 0;
    setFocus(list[(idx + delta + list.length) % list.length]);
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

  /* ---------- key handling: remote + hardware keyboard ---------- */
  // All key decisions live in MG.keyboard.planKey (pure, unit-tested):
  // remote keys and a paired Bluetooth/USB keyboard arrive as the same
  // DOM key events. While a text field has DOM focus, editing keys pass
  // through to the field untouched (text lands exactly once); every
  // action this handler takes itself is preventDefaulted, which also
  // suppresses the browser's own Enter activation of a focused button.
  var FIELD_SUBMIT = {
    'sdk-token-input': 'sdk-token-save',
    'helper-address': 'helper-fetch',
    'helper-code': 'helper-fetch',
    'login-identity': 'login-save',
    'login-pairing': 'login-save',
    'import-access': 'import-save',
    'import-refresh': 'import-save',
    'import-noise-host': 'import-save',
  };
  function submitField(field) {
    if (field.id === 'chat-input') { sendChat(); return; }
    var target = FIELD_SUBMIT[field.id];
    if (target && el(target)) el(target).click();
    else field.blur();
  }

  document.addEventListener('keydown', function (event) {
    var active = document.activeElement;
    var editing = isTextField(active);
    var plan = MG.keyboard.planKey(
      { key: event.key, keyCode: event.keyCode, shiftKey: event.shiftKey },
      {
        cardVisible: !el('card-overlay').classList.contains('hidden'),
        editing: editing,
        multiline: editing && active.tagName === 'TEXTAREA',
        focusedButton: !!(focusedEl && focusedEl.tagName === 'BUTTON'),
        focusedField: !!focusedEl && isTextField(focusedEl),
      }
    );
    switch (plan.action) {
      case 'dismiss':
        hideCard();
        event.preventDefault();
        break;
      case 'nav':
        moveFocus(plan.direction);
        event.preventDefault();
        break;
      case 'focus-next':
        focusStep(1);
        event.preventDefault();
        break;
      case 'focus-prev':
        focusStep(-1);
        event.preventDefault();
        break;
      case 'activate':
        if (focusedEl) focusedEl.click();
        event.preventDefault();
        break;
      case 'edit':
        if (focusedEl) focusedEl.focus();
        event.preventDefault();
        break;
      case 'submit':
        submitField(active);
        event.preventDefault();
        break;
      case 'exit-editing':
        // Leave the field (this also closes the TV's on-screen IME) but
        // stay on the screen; spatial focus stays on the field, so the
        // next Escape/Return goes back.
        active.blur();
        paintFocus(active);
        event.preventDefault();
        break;
      case 'back':
        if (currentScreen === 'setup') showScreen('main');
        event.preventDefault();
        break;
      case 'ignore':
        event.preventDefault();
        break;
      case 'passthrough':
        break; // the field and the platform IME own this key
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
  function renderIdentity() {
    el('id-display-name').textContent = identity.displayName;
    el('id-node-id').textContent = identity.nodeId;
    el('id-ble-name').textContent = identity.bleName;
    el('identity-line').textContent =
      identity.displayName + ' · ' + identity.nodeId;
  }
  renderIdentity();

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

  /* ---------- web login (pairing transfer) ---------- */
  // The primary onboarding path, in two transports that land on the same
  // gate in web-login.js: fetch the pairing files from the pairing helper
  // (tools/pairing-helper) running on the pairing machine, or paste the
  // files. Either way the credentials are verified with the device API,
  // the pairing's identity is adopted and only then is anything saved;
  // the runtime is rebuilt so the service registers and rotates tokens as
  // the adopted identity, not the TV's previous one.

  // web-login.js's HTTP client for the helper fetch: resolves
  // {status, body}. Reaching the helper is a plain LAN request; a failure
  // to connect at all gets a message written for someone holding a remote.
  function httpGetText(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 20000;
      xhr.onload = function () {
        resolve({ status: xhr.status, body: xhr.responseText });
      };
      xhr.onerror = function () {
        reject(new Error('Could not reach the helper. Check the address, ' +
          'and that the TV and the computer are on the same network.'));
      };
      xhr.ontimeout = function () {
        reject(new Error('The helper did not answer in time. Is it still running?'));
      };
      xhr.send();
    });
  }

  function loginDeps() {
    var sdkToken = null;
    try { sdkToken = store.getSdkToken(); } catch (err) { sdkToken = null; }
    return {
      fetchVms: MG.museApi.fetchVms,
      apiRoot: MG.museApi.apiRoot,
      store: store,
      sdkToken: sdkToken,
      nowSeconds: function () { return Date.now() / 1000; },
      httpGet: httpGetText,
      adoptIdentity: function (mac) {
        identity = MG.identity.adoptMac(storage, mac);
        return identity;
      },
    };
  }

  function onLoginSuccess(state, result) {
    state.textContent = 'Logged in as ' + result.nodeId +
      '. The TV now connects to Muse by itself.';
    state.classList.remove('error');
    renderIdentity();
    renderPairingState();
    restartRuntime();
    showScreen('main');
  }

  function onLoginFailure(state, err) {
    state.textContent = 'Login failed: ' + (err && err.status ? err.status : err.message) +
      '. Nothing was saved.';
    state.classList.add('error');
  }

  el('helper-fetch').addEventListener('click', function () {
    var state = el('helper-state');
    state.textContent = 'Fetching the pairing from the helper, then checking it with Muse…';
    state.classList.remove('error');
    Promise.resolve().then(function () {
      return MG.webLogin.loginFromHelper(
        loginDeps(),
        el('helper-address').value,
        el('helper-code').value
      );
    }).then(function (result) {
      el('helper-code').value = '';
      onLoginSuccess(state, result);
    }).catch(function (err) {
      onLoginFailure(state, err);
    });
  });

  el('login-save').addEventListener('click', function () {
    var state = el('login-state');
    state.textContent = 'Checking the credentials with Muse…';
    state.classList.remove('error');
    Promise.resolve().then(function () {
      return MG.webLogin.login(
        loginDeps(),
        el('login-identity').value,
        el('login-pairing').value
      );
    }).then(function (result) {
      el('login-identity').value = '';
      el('login-pairing').value = '';
      onLoginSuccess(state, result);
    }).catch(function (err) {
      onLoginFailure(state, err);
    });
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
    el('login-state').textContent = 'Unpaired. Device credentials were removed from this TV.';
    el('login-state').classList.remove('error');
  });

  /* ---------- voice settings ---------- */
  function renderSpeechState() {
    el('speech-toggle').textContent =
      'Read messages aloud: ' + (speechCtl.isEnabled() ? 'on' : 'off');
    var state = el('speech-state');
    if (!speechCtl.isSupported()) {
      state.textContent = 'This TV’s web runtime has no speech synthesis; messages will stay silent.';
    } else if (speechCtl.voiceCount() === 0) {
      state.textContent = 'Speech synthesis is present, but this TV exposes no voices; messages will stay silent.';
    } else {
      var count = speechCtl.voiceCount();
      state.textContent = 'Speech is available (' + count + (count === 1 ? ' voice' : ' voices') + ').';
    }
  }
  el('speech-toggle').addEventListener('click', function () {
    speechCtl.setEnabled(!speechCtl.isEnabled());
    renderSpeechState();
  });
  el('speech-test').addEventListener('click', function () {
    var said = speechCtl.say('Muse Gadget TV can read messages aloud.');
    toast(said ? 'Speaking…' : 'This TV did not speak — speech synthesis is unavailable here.');
  });

  el('open-settings').addEventListener('click', function () {
    renderSdkTokenState();
    renderPairingState();
    renderSpeechState();
    showScreen('setup');
  });
  el('setup-back').addEventListener('click', function () { showScreen('main'); });

  /* ---------- chat composer ---------- */
  function sendChat() {
    var input = el('chat-input');
    var text = input.value.trim();
    if (!text) return;
    // Bloop shows "busy" from the send until the send's result returns.
    avatarCtl.beginWork();
    service.sendChat(text).then(function (result) {
      avatarCtl.endWork();
      if (result.ok) {
        input.value = '';
        toast('Sent to Muse.');
      } else {
        toast('Muse refused the message (HTTP ' + result.status + ').');
      }
    }).catch(function (err) {
      avatarCtl.endWork();
      toast(err.message || 'Not connected to Muse.');
    });
  }
  el('chat-send').addEventListener('click', sendChat);
  // No per-field key handler for the composer: the central planner maps
  // Enter inside the field to submitField → sendChat, and lets every
  // other editing key through to the field.

  /* ---------- boot ---------- */
  renderSdkTokenState();
  renderPairingState();
  renderSpeechState();
  showScreen(store.getPairing() ? 'main' : 'setup');
  service.start();
})();
