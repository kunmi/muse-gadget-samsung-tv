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
 * Text-to-speech for the TV, over the W3C Web Speech API's synthesis half
 * (window.speechSynthesis / SpeechSynthesisUtterance). That API is part of
 * the Tizen TV web profile: the Tizen TV W3C/HTML5 API Reference lists
 * "Web Speech (Partial)" in every release from Tizen 4.0 to 10.0, with
 * SpeechSynthesis supported behind the device feature
 * http://tizen.org/feature/speech.synthesis (declared, not required, in
 * config.xml) and no privilege. The same reference lists what is NOT
 * supported on the TV profile, and this wrapper respects all of it:
 * SpeechRecognition and SpeechSynthesisErrorEvent do not exist, and the
 * utterance pitch/volume attributes are ignored by the platform, so they
 * are never set here (rate is supported and left at 1).
 *
 * There is no Samsung-side alternative for web apps: the Samsung Product
 * API has no TTS namespace (webapis.voiceinteraction is voice *input* —
 * Bixby commands into the app), and Tizen's TTS service (Tizen.Uix.Tts /
 * native tts_*) is not reachable from the web runtime.
 *
 * Whether a given retail TV actually exposes voices depends on the model
 * and firmware shipping the speech.synthesis feature, so everything is
 * feature-detected at runtime: no synthesiser, or a synthesiser with an
 * empty voice list, means the TV stays silent and callers get `false`.
 * Nothing is faked and nothing throws.
 *
 * Two entry points, deliberately different:
 *   say(text, {interrupt})  — an explicit command (the speech.say invoke,
 *     a display command's speak:true, the settings screen's test button).
 *     Speaks regardless of the read-aloud preference.
 *   announce(text)          — automatic read-aloud for display.text /
 *     display.briefing. Speaks only when the user turned "Read messages
 *     aloud" on (persisted, default off). Returns null when it did not
 *     attempt speech, so callers can tell "not attempted" from "attempted
 *     but unavailable" (false).
 *
 * Queue discipline: at most one utterance speaks and at most one waits.
 * A new utterance while one is speaking replaces the waiting one; with
 * {interrupt:true} it cancels the current speech and starts immediately.
 * Spoken text is capped at MAX_CHARS characters.
 *
 * deps.onSpeakingChange(bool), when supplied, fires exactly on the
 * speaking/not-speaking transitions (an interrupt that swaps one
 * utterance for another is not a transition). The ambient avatar uses
 * it to lip-flap while the TV talks.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  var STORAGE_KEY = 'museGadgetTv.speechEnabled';
  var MAX_CHARS = 500;

  // deps: {synthesis, Utterance, storage, lang}
  //   synthesis — window.speechSynthesis (or a test fake); may be null.
  //   Utterance — the SpeechSynthesisUtterance constructor; may be null.
  //   storage   — localStorage-like {getItem, setItem}; may be null.
  //   lang      — preferred voice language; defaults to navigator.language
  //               or 'en-US'.
  function create(deps) {
    deps = deps || {};
    var synthesis = deps.synthesis || null;
    var Utterance = deps.Utterance || null;
    var storage = deps.storage || null;
    var lang = deps.lang ||
      (typeof root.navigator !== 'undefined' && root.navigator.language) || 'en-US';

    var enabled = false;
    try {
      enabled = !!storage && storage.getItem(STORAGE_KEY) === '1';
    } catch (err) {
      enabled = false;
    }

    var current = null; // utterance being spoken
    var pending = null; // text of the one waiting utterance, if any

    var onSpeakingChange = typeof deps.onSpeakingChange === 'function'
      ? deps.onSpeakingChange : null;
    var speakingNotified = false;
    function noteSpeaking(value) {
      if (speakingNotified === value) return;
      speakingNotified = value;
      if (onSpeakingChange) {
        try { onSpeakingChange(value); } catch (err) { /* listener's problem */ }
      }
    }

    function isSupported() {
      return !!(
        synthesis &&
        typeof synthesis.speak === 'function' &&
        typeof synthesis.cancel === 'function' &&
        typeof Utterance === 'function'
      );
    }

    function voices() {
      if (!isSupported() || typeof synthesis.getVoices !== 'function') return [];
      try {
        return synthesis.getVoices() || [];
      } catch (err) {
        return [];
      }
    }

    function voiceCount() {
      return voices().length;
    }

    // Speech is usable only with at least one voice: a synthesiser object
    // with an empty voice list is how a TV without the speech.synthesis
    // feature presents, and speaking into it would silently do nothing.
    function canSpeak() {
      return isSupported() && voices().length > 0;
    }

    function pickVoice() {
      var list = voices();
      if (!list.length) return null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].default) return list[i];
      }
      var wanted = String(lang).toLowerCase();
      for (var j = 0; j < list.length; j++) {
        if (list[j].lang && list[j].lang.toLowerCase() === wanted) return list[j];
      }
      var prefix = wanted.split('-')[0];
      for (var k = 0; k < list.length; k++) {
        if (list[k].lang && list[k].lang.toLowerCase().indexOf(prefix) === 0) return list[k];
      }
      return list[0];
    }

    function cleanText(text) {
      if (typeof text !== 'string') return '';
      var cleaned = text.replace(/\s+/g, ' ').trim();
      if (cleaned.length > MAX_CHARS) cleaned = cleaned.slice(0, MAX_CHARS);
      return cleaned;
    }

    function startUtterance(text) {
      var utterance = new Utterance(text);
      utterance.lang = lang;
      var voice = pickVoice();
      if (voice) utterance.voice = voice;
      // pitch and volume are intentionally not set: the Tizen TV profile
      // does not support them on SpeechSynthesisUtterance.
      current = utterance;
      utterance.onend = function () { finish(utterance); };
      utterance.onerror = function () { finish(utterance); };
      synthesis.speak(utterance);
      noteSpeaking(true);
    }

    function finish(utterance) {
      if (current !== utterance) return;
      current = null;
      if (pending !== null) {
        var next = pending;
        pending = null;
        startUtterance(next);
        return;
      }
      noteSpeaking(false);
    }

    // Explicit speech. Returns true when an utterance was handed to the
    // synthesiser (started now or queued), false when speech is
    // unavailable here or the text is empty.
    function say(text, options) {
      options = options || {};
      var cleaned = cleanText(text);
      if (!cleaned || !canSpeak()) return false;
      if (current && !options.interrupt) {
        pending = cleaned; // at most one waiting; the newest wins
        return true;
      }
      if (current && options.interrupt) {
        pending = null;
        current = null;
        try { synthesis.cancel(); } catch (err) { /* keep going */ }
      }
      startUtterance(cleaned);
      return true;
    }

    // Automatic read-aloud: null when the preference is off (not
    // attempted), otherwise whatever say() returns.
    function announce(text) {
      if (!enabled) return null;
      return say(text);
    }

    function stop() {
      pending = null;
      current = null;
      noteSpeaking(false);
      if (isSupported()) {
        try { synthesis.cancel(); } catch (err) { /* best effort */ }
      }
    }

    function isEnabled() {
      return enabled;
    }

    function setEnabled(value) {
      enabled = !!value;
      try {
        if (storage) storage.setItem(STORAGE_KEY, enabled ? '1' : '0');
      } catch (err) {
        // Persistence is best-effort; the in-memory flag still applies.
      }
      if (!enabled) stop();
      return enabled;
    }

    return {
      isSupported: isSupported,
      canSpeak: canSpeak,
      voiceCount: voiceCount,
      pickVoice: pickVoice,
      isEnabled: isEnabled,
      setEnabled: setEnabled,
      say: say,
      announce: announce,
      stop: stop,
      isSpeaking: function () { return current !== null; },
      hasPending: function () { return pending !== null; },
    };
  }

  MG.speech = {
    create: create,
    STORAGE_KEY: STORAGE_KEY,
    MAX_CHARS: MAX_CHARS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.speech;
})(typeof globalThis !== 'undefined' ? globalThis : this);
