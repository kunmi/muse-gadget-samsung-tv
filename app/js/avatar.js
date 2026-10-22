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
 * Bloop, the ambient avatar: an original little bubble-bot who lives on
 * the ambient screen and shows, at a glance, what the gadget is doing.
 * The character, name and artwork are this project's own, drawn here as
 * inline SVG — no image assets, and no third-party character art. (The
 * Muse Gadget SDK's mascot artwork is not covered by that project's
 * Apache license and is deliberately not used; see NOTICE.)
 *
 * The module is split like the rest of the codebase:
 *
 *   create(deps)  — a pure state machine (no DOM). It tracks connection,
 *     work-in-progress and speech, and resolves them into one visible
 *     state. Timers and the clock are injected so tests can drive it.
 *   buildMarkup() — the character as an SVG string.
 *   mount(el, machine) — puts the SVG into a container and mirrors the
 *     machine's state onto it as a data-state attribute; every animation
 *     itself lives in style.css, keyed off that attribute, and animates
 *     transform/opacity only (cheap on a TV web runtime).
 *
 * Visible states, highest priority first:
 *
 *   speaking — the TV is talking (speech.js is mid-utterance): the mouth
 *     lip-flaps. Driven by setSpeaking, wired to the speech module's
 *     onSpeakingChange hook.
 *   busy — Muse is working: a composer message is in flight or a link
 *     command is executing. Focused eyes, typing arms, bouncing progress
 *     dots, a pulsing antenna orb. beginWork/endWork nest; a minimum
 *     on-screen time (MIN_BUSY_MS) keeps quick commands from flickering.
 *   wave — a greeting, a few seconds: on every fresh connection to Muse
 *     and whenever a display.* card arrives. wave() calls made while
 *     busy or speaking are remembered and played once the coast is clear.
 *   idle — connected and calm: gentle bobbing, blinking, the occasional
 *     look around.
 *   sleep — not connected (unpaired, reconnecting, stopped): dimmed,
 *     eyes closed, a drifting "Z".
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  var NAME = 'Bloop';
  var WAVE_MS = 2600;    // how long a greeting wave lasts
  var MIN_BUSY_MS = 900; // busy never flashes for less than this

  var DISPLAY_COMMANDS = {
    'display.text': true,
    'display.image': true,
    'display.briefing': true,
  };

  // deps: {setTimeout, clearTimeout, now} — injectable for tests; all
  // default to the platform's.
  function create(deps) {
    deps = deps || {};
    var setTimer = deps.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = deps.clearTimeout || function (id) { clearTimeout(id); };
    var now = deps.now || function () { return Date.now(); };

    var connected = false;
    var work = 0;          // nesting depth of beginWork()
    var workSince = 0;     // when the current busy spell began
    var speaking = false;
    var waving = false;
    var pendingWave = false;
    var waveTimer = null;
    var busyTimer = null;  // pending end of the minimum busy spell
    var listeners = [];
    var current = 'sleep';

    function effective() {
      if (speaking) return 'speaking';
      if (work > 0 || busyTimer !== null) return 'busy';
      if (waving) return 'wave';
      return connected ? 'idle' : 'sleep';
    }

    function emit() {
      var next = effective();
      if (next === current) return;
      var prev = current;
      current = next;
      listeners.slice().forEach(function (fn) { fn(next, prev); });
    }

    function startWave() {
      waving = true;
      if (waveTimer !== null) clearTimer(waveTimer);
      waveTimer = setTimer(function () {
        waveTimer = null;
        waving = false;
        emit();
      }, WAVE_MS);
      emit();
    }

    // A remembered wave plays as soon as the machine is calm and idle.
    function playPendingWave() {
      if (!pendingWave) return;
      if (effective() !== 'idle') return;
      pendingWave = false;
      startWave();
    }

    function wave() {
      if (!connected) return false;
      if (effective() !== 'idle' && effective() !== 'wave') {
        pendingWave = true; // busy or speaking: greet when it clears
        return false;
      }
      startWave();
      return true;
    }

    function setConnected(value) {
      value = !!value;
      if (value === connected) { emit(); return; }
      connected = value;
      if (!connected) {
        // The session is gone: work and greetings belonging to it end.
        work = 0;
        pendingWave = false;
        waving = false;
        if (waveTimer !== null) { clearTimer(waveTimer); waveTimer = null; }
        if (busyTimer !== null) { clearTimer(busyTimer); busyTimer = null; }
        emit();
        return;
      }
      // Greet on every fresh connection — as part of this same
      // transition, so listeners never see a spurious idle first.
      if (!wave()) emit();
    }

    // Maps the gadget service's state vocabulary (service.js onState)
    // onto the connection flag: only 'registered' is truly connected.
    function serviceState(state) {
      if (state === 'registered') setConnected(true);
      else if (state === 'unpaired' || state === 'waiting' ||
               state === 'connecting' || state === 'stopped') setConnected(false);
    }

    function beginWork() {
      if (work === 0) {
        workSince = now();
        if (busyTimer !== null) { clearTimer(busyTimer); busyTimer = null; }
      }
      work += 1;
      emit();
    }

    function endWork() {
      if (work === 0) return; // unbalanced call: nothing to end
      work -= 1;
      if (work > 0) return;
      var remaining = MIN_BUSY_MS - (now() - workSince);
      if (remaining <= 0) {
        emit();
        playPendingWave();
        return;
      }
      // Hold the busy face until the minimum spell has elapsed.
      if (busyTimer !== null) clearTimer(busyTimer);
      busyTimer = setTimer(function () {
        busyTimer = null;
        emit();
        playPendingWave();
      }, remaining);
      emit();
    }

    function commandStarted(/* command */) {
      beginWork();
    }

    function commandFinished(command) {
      if (DISPLAY_COMMANDS[command] && connected) pendingWave = true;
      endWork();
      playPendingWave();
    }

    function setSpeaking(value) {
      speaking = !!value;
      emit();
      if (!speaking) playPendingWave();
    }

    function onChange(fn) {
      listeners.push(fn);
      return function () {
        var idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }

    function destroy() {
      if (waveTimer !== null) { clearTimer(waveTimer); waveTimer = null; }
      if (busyTimer !== null) { clearTimer(busyTimer); busyTimer = null; }
      listeners = [];
    }

    return {
      getState: function () { return current; },
      isConnected: function () { return connected; },
      onChange: onChange,
      setConnected: setConnected,
      serviceState: serviceState,
      beginWork: beginWork,
      endWork: endWork,
      commandStarted: commandStarted,
      commandFinished: commandFinished,
      setSpeaking: setSpeaking,
      wave: wave,
      destroy: destroy,
    };
  }

  /* ---------- the character (original inline SVG, no assets) ---------- */

  function buildMarkup() {
    return '' +
    '<svg class="bloop" viewBox="0 0 260 260" role="img" aria-label="' + NAME + ', the Muse Gadget TV companion">' +
      '<defs>' +
        '<linearGradient id="bloop-body-grad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#7fd9ef"/>' +
          '<stop offset="1" stop-color="#2e9bb8"/>' +
        '</linearGradient>' +
        '<linearGradient id="bloop-face-grad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#1a2c4e"/>' +
          '<stop offset="1" stop-color="#0e1830"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<ellipse class="bloop-shadow" cx="130" cy="235" rx="64" ry="10" fill="#000000" opacity="0.28"/>' +
      '<g class="bloop-float">' +
        // antenna + orb
        '<path d="M130 44 L130 26" stroke="#2e9bb8" stroke-width="6" stroke-linecap="round" fill="none"/>' +
        '<circle class="bloop-orb-halo" cx="130" cy="18" r="15" fill="#ffc95e" opacity="0.22"/>' +
        '<circle class="bloop-orb" cx="130" cy="18" r="8.5" fill="#ffc95e"/>' +
        // arms (behind the body)
        '<path class="bloop-arm bloop-arm-left" d="M52 148 Q27 156 23 181" stroke="#2e9bb8" stroke-width="15" stroke-linecap="round" fill="none"/>' +
        '<path class="bloop-arm bloop-arm-right" d="M208 148 Q233 156 237 181" stroke="#2e9bb8" stroke-width="15" stroke-linecap="round" fill="none"/>' +
        // body: a round bubble-bot egg
        '<path class="bloop-body" d="M130 40 C184 40 212 88 212 140 C212 198 176 230 130 230 C84 230 48 198 48 140 C48 88 76 40 130 40 Z" fill="url(#bloop-body-grad)"/>' +
        '<ellipse cx="93" cy="82" rx="26" ry="16" fill="#ffffff" opacity="0.16"/>' +
        // face screen
        '<rect class="bloop-face" x="76" y="92" width="108" height="88" rx="38" fill="url(#bloop-face-grad)"/>' +
        '<g class="bloop-eyes-open">' +
          '<g class="bloop-blink">' +
            '<g class="bloop-pupils">' +
              '<ellipse cx="107" cy="126" rx="9.5" ry="14" fill="#b5f4ff"/>' +
              '<ellipse cx="153" cy="126" rx="9.5" ry="14" fill="#b5f4ff"/>' +
              '<circle cx="104" cy="121" r="3" fill="#ffffff" opacity="0.9"/>' +
              '<circle cx="150" cy="121" r="3" fill="#ffffff" opacity="0.9"/>' +
            '</g>' +
          '</g>' +
        '</g>' +
        '<g class="bloop-eyes-closed" opacity="0">' +
          '<path d="M96 126 Q107 134 118 126" stroke="#b5f4ff" stroke-width="4" stroke-linecap="round" fill="none"/>' +
          '<path d="M142 126 Q153 134 164 126" stroke="#b5f4ff" stroke-width="4" stroke-linecap="round" fill="none"/>' +
        '</g>' +
        '<path class="bloop-mouth-smile" d="M117 154 Q130 164 143 154" stroke="#b5f4ff" stroke-width="4" stroke-linecap="round" fill="none"/>' +
        '<ellipse class="bloop-mouth-talk" cx="130" cy="156" rx="7" ry="5" fill="#b5f4ff" opacity="0"/>' +
        '<circle cx="89" cy="151" r="6" fill="#ff9db0" opacity="0.45"/>' +
        '<circle cx="171" cy="151" r="6" fill="#ff9db0" opacity="0.45"/>' +
        // busy progress dots
        '<g class="bloop-dots" opacity="0">' +
          '<circle class="bloop-dot bloop-dot-1" cx="194" cy="56" r="6" fill="#ffc95e"/>' +
          '<circle class="bloop-dot bloop-dot-2" cx="214" cy="56" r="6" fill="#ffc95e"/>' +
          '<circle class="bloop-dot bloop-dot-3" cx="234" cy="56" r="6" fill="#ffc95e"/>' +
        '</g>' +
        // sleep "Z"s
        '<text class="bloop-zzz bloop-zzz-1" x="192" y="72" font-size="30" fill="#8fb0e8" opacity="0">Z</text>' +
        '<text class="bloop-zzz bloop-zzz-2" x="214" y="50" font-size="20" fill="#8fb0e8" opacity="0">Z</text>' +
      '</g>' +
    '</svg>';
  }

  /* ---------- DOM mount ---------- */

  // Puts the character into `container` and mirrors the machine's state
  // onto it as data-state; style.css animates from there. Returns an
  // unmount handle, or null when there is no DOM to mount into.
  function mount(container, machine) {
    if (!container || typeof container !== 'object' ||
        typeof container.innerHTML !== 'string' || !machine) {
      return null;
    }
    container.innerHTML = buildMarkup();
    function apply(state) {
      if (typeof container.setAttribute === 'function') {
        container.setAttribute('data-state', state);
      }
    }
    apply(machine.getState());
    var off = machine.onChange(apply);
    return {
      unmount: function () {
        off();
        container.innerHTML = '';
      },
    };
  }

  MG.avatar = {
    NAME: NAME,
    WAVE_MS: WAVE_MS,
    MIN_BUSY_MS: MIN_BUSY_MS,
    create: create,
    buildMarkup: buildMarkup,
    mount: mount,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.avatar;
})(typeof globalThis !== 'undefined' ? globalThis : this);
