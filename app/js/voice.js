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
 * Voice input — AN EXPERIMENT, labelled as one everywhere it appears.
 *
 * The precedent: on modern Samsung TVs the YouTube app takes free-form
 * dictated search text. Samsung's support flow for that is: grant the
 * app microphone permission, and the platform's speech recognition
 * delivers the query to the app. The public surface for this is the
 * Samsung Product API `webapis.voiceinteraction` (public privilege
 * http://developer.samsung.com/privilege/voicecontrol, since TV 6.0;
 * title selection since 6.5): the app registers callbacks with
 * setCallback(), the TV's voice assistant (Bixby or another) calls
 * onupdatestate() before every utterance to learn what the app is
 * doing, and utterances are routed back as structured callbacks.
 *
 * What is NOT known — and cannot be known without a real TV — is
 * whether a *sideloaded* app like this one actually gets anything:
 * whether the runtime exposes webapis at all (under TizenBrew the host
 * app's manifest and privileges decide, not ours), whether the
 * voicecontrol privilege is granted to a developer-signed package,
 * and whether utterances in the "Search" state ever deliver free text
 * to an app that is not a platform partner. So this module is built as
 * a probe, not a promise:
 *
 *   - Everything is feature-detected. No webapis.voiceinteraction →
 *     the controller reports "unavailable" and every method is a safe
 *     no-op. Nothing is faked: no simulated dictation, ever.
 *   - Every platform call is wrapped; errors (a SecurityError is the
 *     expected failure when the privilege is not granted) are caught
 *     and surfaced, never thrown into app code or back at the platform.
 *   - Every voice event is reported verbatim-ish through deps.onStatus
 *     and kept as lastStatus()/lastHeard(), so the setup screen and the
 *     composer status line show exactly what the platform granted.
 *
 * The text channel, if any: ontitleselection(title) is documented as
 * receiving "the string input via voice" for "Select {title}"
 * utterances, and onrequestcontentcontext() is how an app offers the
 * assistant its on-screen titles for ASR matching. This app offers one
 * title — the composer ("Message to Muse") — and treats any string
 * the platform delivers, through title selection or an app-state
 * change into "Search", as dictated text: it is placed into the
 * composer as a DRAFT via deps.setDraft. It is never auto-sent; the
 * user reviews and presses Send, exactly like typed text.
 *
 * The other callbacks (navigation, selection) are surfaced in the
 * status line so the experiment shows what arrived, but return false:
 * the app does not consume them, and returning false lets the TV do
 * its default thing (e.g. generate remote key events) instead.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  // The composer's content-context title, offered to the assistant for
  // ASR matching in onrequestcontentcontext.
  var COMPOSER_TITLE = 'Message to Muse';
  var COMPOSER_ALIASES = ['message', 'ask Muse', 'search', 'question for Muse'];

  // Maps the app's own context onto the platform's VoiceApplicationState
  // vocabulary: the composer being the focus of attention is the app's
  // "search" moment (a text query is being composed), the setup screen
  // is "Setting", the ambient screen is "Home".
  function appStateFor(context) {
    if (!context) return 'None';
    if (context.composerFocused) return 'Search';
    if (context.screen === 'setup') return 'Setting';
    if (context.screen === 'main') return 'Home';
    return 'None';
  }

  function errorText(err) {
    if (!err) return 'unknown error';
    var name = err.name || 'Error';
    return err.message ? name + ': ' + err.message : name;
  }

  // deps: {webapis, getContext, setDraft, onStatus}
  //   webapis    — window.webapis (Samsung Product API root); may be null.
  //   getContext — () => {screen, composerFocused} for onupdatestate.
  //   setDraft   — (text) => place text in the composer as an unsent draft.
  //   onStatus   — (text) => surface a voice event in the UI.
  function create(deps) {
    deps = deps || {};
    var vi = null;
    try {
      vi = (deps.webapis && deps.webapis.voiceinteraction) || null;
    } catch (err) {
      vi = null;
    }
    var getContext = typeof deps.getContext === 'function' ? deps.getContext : null;
    var setDraft = typeof deps.setDraft === 'function' ? deps.setDraft : function () {};
    var onStatus = typeof deps.onStatus === 'function' ? deps.onStatus : function () {};

    var registered = false;
    var registerError = null;
    var versionCache; // undefined = not probed yet
    var status = '';
    var heard = null; // {text, via} of the last delivered string

    function isAvailable() {
      return !!(vi && typeof vi.setCallback === 'function' &&
        typeof vi.listen === 'function');
    }

    function report(text) {
      status = text;
      try { onStatus(text); } catch (err) { /* the UI's problem */ }
    }

    function version() {
      if (versionCache !== undefined) return versionCache;
      versionCache = null;
      if (vi && typeof vi.getVersion === 'function') {
        try { versionCache = String(vi.getVersion()); } catch (err) { versionCache = null; }
      }
      return versionCache;
    }

    function describe() {
      return {
        available: isAvailable(),
        registered: registered,
        version: version(),
        error: registerError,
      };
    }

    function currentState() {
      var context = null;
      try { context = getContext ? getContext() : null; } catch (err) { context = null; }
      return appStateFor(context);
    }

    function composerFocusedNow() {
      try {
        var context = getContext ? getContext() : null;
        return !!(context && context.composerFocused);
      } catch (err) {
        return false;
      }
    }

    // A string arrived from the platform: route it into the composer as
    // a draft (never a send) and say so, verbatim, in the status line.
    function deliverText(text, via) {
      var cleaned = typeof text === 'string' ? text.trim() : '';
      if (!cleaned) return false;
      heard = { text: cleaned, via: via };
      try { setDraft(cleaned); } catch (err) { /* the UI's problem */ }
      report('Voice heard: "' + cleaned + '" (via ' + via + ') — placed in ' +
        'the message box as a draft, not sent.');
      return true;
    }

    var callbacks = {
      // Called right before every utterance: report the app's state.
      onupdatestate: function () {
        return currentState();
      },
      // Called at the beginning of every utterance: offer the composer
      // as the app's one piece of voice-addressable content.
      onrequestcontentcontext: function () {
        if (!vi || typeof vi.buildVoiceInteractionContentContextResponse !== 'function') {
          return undefined;
        }
        try {
          var item;
          if (typeof vi.buildVoiceInteractionContentContextItem === 'function') {
            item = vi.buildVoiceInteractionContentContextItem(
              0, 0, COMPOSER_TITLE, COMPOSER_ALIASES.slice(), composerFocusedNow());
          } else {
            item = {
              positionX: 0, positionY: 0, title: COMPOSER_TITLE,
              alias: COMPOSER_ALIASES.slice(), bFocused: composerFocusedNow(),
            };
          }
          return vi.buildVoiceInteractionContentContextResponse([item]);
        } catch (err) {
          return undefined;
        }
      },
      // The documented free-text channel: "the string input via voice".
      ontitleselection: function (title) {
        return deliverText(title, 'title selection');
      },
      onchangeappstate: function (state) {
        report('Voice: the assistant set the app state to "' + String(state) + '".');
        return true;
      },
      // Surfaced for the experiment, not consumed: returning false lets
      // the TV apply its default behaviour (e.g. remote key events).
      onnavigation: function (voiceNavigation) {
        report('Voice: navigation "' + String(voiceNavigation) + '" (not handled by the app).');
        return false;
      },
      onselection: function (voiceSelection) {
        report('Voice: selection ' + String(voiceSelection) + ' (not handled by the app).');
        return false;
      },
    };

    // Registers the callbacks once. Returns whether the app is now
    // registered; any platform refusal is kept in describe().error and
    // shown in the status line — that refusal IS the experiment result.
    function start() {
      if (!isAvailable()) {
        report('Voice input unavailable: the VoiceInteraction API is not ' +
          'present in this runtime.');
        return false;
      }
      if (registered) return true;
      try {
        vi.setCallback(callbacks);
        registered = true;
        registerError = null;
        report('Voice input registered with the TV voice assistant' +
          (version() ? ' (VoiceInteraction ' + version() + ')' : '') + '.');
        return true;
      } catch (err) {
        registered = false;
        registerError = errorText(err);
        report('Voice input registration failed: ' + registerError + '.');
        return false;
      }
    }

    // Asks the assistant to listen (the in-app equivalent of the
    // remote's microphone button, per the API). Returns whether the
    // call itself was accepted; what arrives afterwards lands in the
    // callbacks above and in the status line.
    function listen() {
      if (!isAvailable()) {
        report('Voice input unavailable: the VoiceInteraction API is not ' +
          'present in this runtime.');
        return false;
      }
      try {
        vi.listen();
        report('Voice: listening — speak now.');
        return true;
      } catch (err) {
        report('Voice: listen() failed: ' + errorText(err) + '.');
        return false;
      }
    }

    return {
      isAvailable: isAvailable,
      describe: describe,
      start: start,
      listen: listen,
      callbacks: callbacks,
      lastStatus: function () { return status; },
      lastHeard: function () { return heard; },
    };
  }

  MG.voice = {
    create: create,
    appStateFor: appStateFor,
    COMPOSER_TITLE: COMPOSER_TITLE,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.voice;
})(typeof globalThis !== 'undefined' ? globalThis : this);
