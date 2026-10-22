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
 * Podcast Mode: a toggleable mode in which the TV behaves like a
 * narrated ambient briefing channel — a soft generative music bed
 * under spoken narration of what Muse shows and what the gadget does.
 * The mode is persisted like the read-aloud preference, and the two
 * stay distinct: Podcast Mode narrates incoming messages whether or
 * not "Read messages aloud" is on (see the narration rules below).
 *
 * The bed is generated in code with the Web Audio API: a slow pad —
 * detuned triangle/sine oscillators through a low-pass filter whose
 * cutoff drifts on a slow LFO — cycling a four-chord progression.
 * There are no audio files, no samples and no licensed music; it works
 * offline and under TizenBrew. TV runtimes gate audio behind user
 * interaction, so the bed starts when the user enables the mode (a
 * click) or, if the mode was left on, at the first key/click after
 * boot (notifyInteraction); until then audioState() honestly reports
 * 'suspended' instead of pretending to play.
 *
 * Ducking: the speech module's speaking transitions reach this module
 * through setSpeaking() (app.js fans its onSpeakingChange hook out to
 * here and to the avatar). While narration speaks, the bed dips to
 * DUCK_RATIO of its level; when speech ends it swells back.
 *
 * Narration rules (all through MG.speech's say(), so the 500-character
 * cap and the one-speaking/one-queued discipline apply unchanged):
 *
 *   - Messages: display.text / display.briefing content is narrated
 *     when it arrives. Coordination with the executor's own speech
 *     (speak:true, or read-aloud announce) happens through the command
 *     result: a boolean `spoken` in the result payload means the
 *     executor already ran its speech path (spoken — stay silent; or
 *     attempted-and-unavailable — retrying would fail identically).
 *     Podcast narration covers the remaining case, where the executor
 *     did not attempt speech at all. Nothing is ever spoken twice.
 *     Arrives via considerMessage().
 *   - Activity: short lines for the gadget's own life — connected,
 *     disconnected, "Working on it.", "Done." — via activity(). They
 *     are rate-limited so the TV never chatters: at least
 *     ACTIVITY_GAP_MS between any two activity lines, "working" at
 *     most once per WORKING_MIN_MS, "done"/"failed" only when a
 *     "working" line was actually spoken for that spell, and the
 *     connected/disconnected lines deduplicated within DEDUPE_MS.
 *     Housekeeping commands (volume, health) are never narrated;
 *     app.js simply does not call activity() for them.
 *   - Approval-looking messages: if a message reads like a request
 *     for the user's permission or approval — looksLikeApproval()
 *     requires BOTH an approval keyword AND a request marker, so a
 *     mere mention never triggers it — it is narrated with an
 *     "Attention." prefix, and app.js highlights its card. The gadget
 *     protocol carries no approval flag (display.* parameters are
 *     text/title/speak only), so text is all there is to go on.
 *
 * What this mode can never do: narrate things that do not reach the
 * TV. Approval cards shown in the Muse app on a phone, for example,
 * are not sent to the gadget — if Muse does not send the TV a
 * message, there is nothing here to narrate. See the README.
 *
 * Avatar sync needs no code here: narration goes through speech.say(),
 * whose speaking hook already drives the avatar's speaking state, and
 * the busy state is driven by the same command/composer work tracking
 * as always. Podcast Mode speaks and ducks; Bloop reacts on his own.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  var MODE_KEY = 'museGadgetTv.podcastMode';
  var VOLUME_KEY = 'museGadgetTv.podcastBedVolume';
  var DEFAULT_BED_VOLUME = 0.12;
  var MAX_BED_VOLUME = 0.4;
  var DUCK_RATIO = 0.22;
  var CHORD_MS = 24000;
  var ACTIVITY_GAP_MS = 12000;
  var WORKING_MIN_MS = 45000;
  var DEDUPE_MS = 8000;

  var LINES = {
    connected: 'Connected to Muse.',
    disconnected: 'Disconnected from Muse.',
    working: 'Working on it.',
    done: 'Done.',
    failed: 'That did not go through.',
  };

  // A gentle I–vi–IV–V-ish pad in C, low and slow. Frequencies in Hz.
  var CHORDS = [
    [130.81, 164.81, 196.00, 246.94], // Cmaj7: C3 E3 G3 B3
    [110.00, 130.81, 164.81, 196.00], // Am7:   A2 C3 E3 G3
    [174.61, 220.00, 261.63, 329.63], // Fmaj7: F3 A3 C4 E4
    [196.00, 246.94, 293.66, 329.63], // G6:    G3 B3 D4 E4
  ];

  var APPROVAL_WORDS =
    /\b(permission|permissions|approve|approval|approving|allow|authorize|authorise|authorization|consent|confirm|confirmation)\b/i;
  var REQUEST_MARKERS =
    /(\?|please\b|do you want|would you like|can i\b|may i\b|shall i\b|waiting for your|needs? your (approval|permission|confirmation)|requests? (permission|approval|confirmation)|ask(ing)? for your)/i;

  // Conservative on purpose: an approval keyword alone ("Permission
  // granted", "the confirmation screen") is not a request; a question
  // alone is not about approval. Both halves must be present.
  function looksLikeApproval(text) {
    if (typeof text !== 'string' || !text) return false;
    return APPROVAL_WORDS.test(text) && REQUEST_MARKERS.test(text);
  }

  // deps: {audioContextCtor, speech, storage, now, setTimeout, clearTimeout}
  //   audioContextCtor — window.AudioContext/webkitAudioContext; may be null.
  //   speech           — an MG.speech instance; may be null (bed-only mode).
  //   storage          — localStorage-like; may be null.
  //   now/setTimeout/clearTimeout — injectable for tests.
  function create(deps) {
    deps = deps || {};
    var AudioCtor = deps.audioContextCtor || null;
    var speech = deps.speech || null;
    var storage = deps.storage || null;
    var now = deps.now || function () { return Date.now(); };
    var setTimer = deps.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = deps.clearTimeout || function (id) { clearTimeout(id); };

    var enabled = false;
    var bedVolume = DEFAULT_BED_VOLUME;
    try {
      enabled = !!storage && storage.getItem(MODE_KEY) === '1';
      var savedVolume = storage ? parseFloat(storage.getItem(VOLUME_KEY)) : NaN;
      if (isFinite(savedVolume)) bedVolume = clampVolume(savedVolume);
    } catch (err) {
      enabled = false;
      bedVolume = DEFAULT_BED_VOLUME;
    }

    function clampVolume(value) {
      if (!isFinite(value)) return DEFAULT_BED_VOLUME;
      return Math.min(MAX_BED_VOLUME, Math.max(0, value));
    }

    function persist() {
      try {
        if (storage) {
          storage.setItem(MODE_KEY, enabled ? '1' : '0');
          storage.setItem(VOLUME_KEY, String(bedVolume));
        }
      } catch (err) {
        // Persistence is best-effort; the in-memory state still applies.
      }
    }

    /* ---------- the ambient bed (Web Audio, generated) ---------- */

    var ctx = null;
    var master = null;   // master gain (volume + ducking live here)
    var filter = null;
    var bedGroups = [];  // live chord groups {gain, oscs}
    var bedNodes = [];   // everything to stop on teardown (lfo etc.)
    var chordTimer = null;
    var chordIndex = 0;
    var speakingNow = false;

    function isBedAvailable() {
      return typeof AudioCtor === 'function';
    }

    function audioState() {
      if (!isBedAvailable()) return 'unavailable';
      if (!ctx) return 'off';
      return ctx.state === 'running' ? 'running' : 'suspended';
    }

    function masterTarget() {
      return speakingNow ? bedVolume * DUCK_RATIO : bedVolume;
    }

    function applyMaster(immediate) {
      if (!ctx || !master) return;
      try {
        if (immediate) {
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.value = masterTarget();
        } else {
          master.gain.setTargetAtTime(masterTarget(), ctx.currentTime, 0.4);
        }
      } catch (err) { /* a dying context must not take the app with it */ }
    }

    function startChord(freqs) {
      var groupGain = ctx.createGain();
      groupGain.gain.value = 0;
      groupGain.connect(filter);
      var oscs = [];
      freqs.forEach(function (freq, idx) {
        var osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        osc.detune.value = idx % 2 === 0 ? 4 : -3;
        osc.connect(groupGain);
        osc.start();
        oscs.push(osc);
        if (idx === 0) { // a sine under the root, for body
          var sub = ctx.createOscillator();
          sub.type = 'sine';
          sub.frequency.value = freq;
          sub.connect(groupGain);
          sub.start();
          oscs.push(sub);
        }
      });
      groupGain.gain.setTargetAtTime(0.16, ctx.currentTime, 1.6);
      var group = { gain: groupGain, oscs: oscs };
      bedGroups.push(group);
      return group;
    }

    function retireGroup(group) {
      try {
        group.gain.gain.setTargetAtTime(0, ctx.currentTime, 1.8);
      } catch (err) { /* already gone */ }
      var stopTimer = setTimer(function () {
        group.oscs.forEach(function (osc) {
          try { osc.stop(); } catch (err) { /* already stopped */ }
          try { osc.disconnect(); } catch (err) { /* already gone */ }
        });
        try { group.gain.disconnect(); } catch (err) { /* already gone */ }
        var idx = bedGroups.indexOf(group);
        if (idx >= 0) bedGroups.splice(idx, 1);
      }, 7000);
      bedNodes.push({ stop: function () { clearTimer(stopTimer); } });
    }

    function scheduleChords() {
      if (chordTimer !== null) clearTimer(chordTimer);
      chordTimer = setTimer(function () {
        chordTimer = null;
        if (!ctx) return;
        chordIndex = (chordIndex + 1) % CHORDS.length;
        var previous = bedGroups[bedGroups.length - 1];
        startChord(CHORDS[chordIndex]);
        if (previous) retireGroup(previous);
        scheduleChords();
      }, CHORD_MS);
    }

    function startBed() {
      if (!enabled || !isBedAvailable() || ctx) return audioState();
      try {
        ctx = new AudioCtor();
        master = ctx.createGain();
        master.gain.value = 0;
        filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 650;
        if (filter.Q) filter.Q.value = 0.4;
        filter.connect(master);
        master.connect(ctx.destination);

        // A slow LFO breathing on the filter cutoff.
        var lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = 0.06;
        var lfoDepth = ctx.createGain();
        lfoDepth.gain.value = 110;
        lfo.connect(lfoDepth);
        lfoDepth.connect(filter.frequency);
        lfo.start();
        bedNodes.push(lfo, lfoDepth);

        chordIndex = 0;
        startChord(CHORDS[chordIndex]);
        scheduleChords();
        applyMaster(true);
        if (typeof ctx.resume === 'function') {
          var resumed = ctx.resume();
          if (resumed && typeof resumed.catch === 'function') {
            resumed.catch(function () { /* stays suspended; reported as such */ });
          }
        }
      } catch (err) {
        ctx = null;
        master = null;
        filter = null;
      }
      return audioState();
    }

    function stopBed() {
      if (chordTimer !== null) { clearTimer(chordTimer); chordTimer = null; }
      var oldCtx = ctx;
      var groups = bedGroups;
      var nodes = bedNodes;
      ctx = null;
      master = null;
      filter = null;
      bedGroups = [];
      bedNodes = [];
      groups.forEach(function (group) {
        group.oscs.forEach(function (osc) {
          try { osc.stop(); } catch (err) { /* already stopped */ }
        });
      });
      nodes.forEach(function (node) {
        if (node && typeof node.stop === 'function') {
          try { node.stop(); } catch (err) { /* timer handles / oscs */ }
        }
      });
      if (oldCtx && typeof oldCtx.close === 'function') {
        try {
          var closed = oldCtx.close();
          if (closed && typeof closed.catch === 'function') closed.catch(function () {});
        } catch (err) { /* a closed context is the goal anyway */ }
      }
    }

    // The autoplay-policy bridge: call on user gestures. If the context
    // exists but is suspended, try to resume it; if the mode is on and
    // no context exists yet (e.g. start() raced the boot), start now.
    function notifyInteraction() {
      if (!enabled) return audioState();
      if (!ctx) return startBed();
      if (ctx.state !== 'running' && typeof ctx.resume === 'function') {
        try {
          var resumed = ctx.resume();
          if (resumed && typeof resumed.catch === 'function') resumed.catch(function () {});
        } catch (err) { /* reported via audioState() */ }
      }
      return audioState();
    }

    /* ---------- narration ---------- */

    var lastActivityAt = -Infinity;
    var lastWorkingAt = -Infinity;
    var lastKindAt = {};
    var workingSpoken = false; // a "working" line is awaiting its outcome

    function sayLine(text) {
      if (!speech || typeof speech.say !== 'function') return false;
      try { return speech.say(text) === true; } catch (err) { return false; }
    }

    // Activity narration, rate-limited per the rules in the header.
    // Returns true only when a line was actually handed to the speaker.
    function activity(kind) {
      if (!enabled) return false;
      if (!Object.prototype.hasOwnProperty.call(LINES, kind)) return false;
      var t = now();
      if (kind === 'connected' || kind === 'disconnected') {
        if (lastKindAt[kind] !== undefined && t - lastKindAt[kind] < DEDUPE_MS) return false;
      } else {
        if (t - lastActivityAt < ACTIVITY_GAP_MS) return false;
        if (kind === 'working' && t - lastWorkingAt < WORKING_MIN_MS) return false;
        if ((kind === 'done' || kind === 'failed') && !workingSpoken) return false;
      }
      if (!sayLine(LINES[kind])) return false;
      lastActivityAt = t;
      lastKindAt[kind] = t;
      if (kind === 'working') {
        lastWorkingAt = t;
        workingSpoken = true;
      }
      if (kind === 'done' || kind === 'failed') workingSpoken = false;
      return true;
    }

    // Message narration for display.text / display.briefing, called by
    // app.js with the command's params and its result. Returns a code:
    // 'spoken' | 'skipped-disabled' | 'skipped-already-spoken' |
    // 'unavailable' (no speech, or speech declined).
    function considerMessage(command, params, result) {
      if (!enabled) return 'skipped-disabled';
      // A boolean spoken field means the executor already ran its
      // speech path for this message (speak:true, or read-aloud): true
      // — it was narrated, stay silent; false — speech was attempted
      // and unavailable, and retrying through the same module would
      // fail the same way. Podcast narration is only for the case the
      // executor did not attempt speech at all (no spoken field).
      if (result && result.payload && typeof result.payload.spoken === 'boolean') {
        return result.payload.spoken ? 'skipped-already-spoken' : 'unavailable';
      }
      params = params || {};
      var text = '';
      if (command === 'display.text') {
        text = params.title ? params.title + '. ' + params.text : String(params.text || '');
      } else if (command === 'display.briefing') {
        var lines = Array.isArray(params.lines) ? params.lines : [];
        text = String(params.title || '') + '. ' + lines.join('. ');
      } else {
        return 'skipped-disabled'; // not a narratable command here
      }
      text = text.trim();
      if (!text) return 'unavailable';
      if (looksLikeApproval(text)) text = 'Attention. ' + text;
      return sayLine(text) ? 'spoken' : 'unavailable';
    }

    function isApprovalText(text) {
      return looksLikeApproval(text);
    }

    /* ---------- mode control ---------- */

    function setEnabled(value) {
      enabled = !!value;
      persist();
      if (enabled) startBed();
      else stopBed();
      return enabled;
    }

    function isEnabled() {
      return enabled;
    }

    // Boot entry: if the mode was left on, try to start the bed (it may
    // stay suspended until the first interaction — see audioState()).
    function start() {
      if (enabled) startBed();
      return enabled;
    }

    function setSpeaking(value) {
      speakingNow = !!value;
      applyMaster(false);
    }

    function setBedVolume(value) {
      bedVolume = clampVolume(value);
      persist();
      applyMaster(false);
      return bedVolume;
    }

    function getBedVolume() {
      return bedVolume;
    }

    return {
      isEnabled: isEnabled,
      setEnabled: setEnabled,
      start: start,
      notifyInteraction: notifyInteraction,
      isBedAvailable: isBedAvailable,
      audioState: audioState,
      setSpeaking: setSpeaking,
      setBedVolume: setBedVolume,
      getBedVolume: getBedVolume,
      activity: activity,
      considerMessage: considerMessage,
      isApprovalText: isApprovalText,
    };
  }

  MG.podcast = {
    create: create,
    looksLikeApproval: looksLikeApproval,
    LINES: LINES,
    CHORDS: CHORDS,
    MODE_KEY: MODE_KEY,
    VOLUME_KEY: VOLUME_KEY,
    DEFAULT_BED_VOLUME: DEFAULT_BED_VOLUME,
    MAX_BED_VOLUME: MAX_BED_VOLUME,
    DUCK_RATIO: DUCK_RATIO,
    ACTIVITY_GAP_MS: ACTIVITY_GAP_MS,
    WORKING_MIN_MS: WORKING_MIN_MS,
    DEDUPE_MS: DEDUPE_MS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.podcast;
})(typeof globalThis !== 'undefined' ? globalThis : this);
