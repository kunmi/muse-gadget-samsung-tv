'use strict';
/*
 * Podcast Mode: the persisted toggle and bed volume, the generative
 * Web Audio bed against a fake audio graph (start, chord cycling,
 * ducking under speech, teardown), narration triggers for messages
 * and activity (coordinated with the executor's spoken flag so nothing
 * is spoken twice), the activity rate limits, the approval heuristic,
 * and the clean no-op halves: no Web Audio → narration still works;
 * no TTS → the bed still plays.
 */
const assert = require('assert');
const { loadModules, test, memoryStorage } = require('./helpers');

const MG = loadModules();
const P = MG.podcast;

/* ---------- fakes ---------- */

function fakeParam(initial) {
  return {
    value: initial || 0,
    targets: [],
    setTargetAtTime(v) { this.targets.push(v); this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {},
  };
}

function fakeAudioContextClass(options) {
  const opts = typeof options === 'object' && options !== null ? options : {};
  const instances = [];
  function FakeAudioContext() {
    this.state = opts.startSuspended ? 'suspended' : 'running';
    this.allowResume = !opts.refuseResume;
    this.currentTime = 0;
    this.destination = { kind: 'destination' };
    this.oscillators = [];
    this.gains = [];
    this.filters = [];
    this.closed = false;
    instances.push(this);
  }
  FakeAudioContext.prototype.createGain = function () {
    const node = { gain: fakeParam(1), connect() {}, disconnect() {} };
    this.gains.push(node);
    return node;
  };
  FakeAudioContext.prototype.createOscillator = function () {
    const node = {
      type: '', frequency: fakeParam(0), detune: fakeParam(0),
      started: false, stopped: false,
      connect() {}, disconnect() {},
      start() { this.started = true; },
      stop() { this.stopped = true; },
    };
    this.oscillators.push(node);
    return node;
  };
  FakeAudioContext.prototype.createBiquadFilter = function () {
    const node = { type: '', frequency: fakeParam(0), Q: fakeParam(0), connect() {}, disconnect() {} };
    this.filters.push(node);
    return node;
  };
  FakeAudioContext.prototype.resume = function () {
    if (this.allowResume) this.state = 'running';
    return Promise.resolve();
  };
  FakeAudioContext.prototype.close = function () {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  };
  FakeAudioContext.instances = instances;
  return FakeAudioContext;
}

function fakeSpeech(sayResult) {
  return {
    calls: [],
    sayResult: sayResult !== undefined ? sayResult : true,
    say(text) { this.calls.push(text); return this.sayResult; },
  };
}

function fakeTimers() {
  let nowMs = 0;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fn, at: nowMs + ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    advance: (ms) => {
      const target = nowMs + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        }
        if (!next) break;
        timers.delete(next.id);
        nowMs = next.t.at;
        next.t.fn();
      }
      nowMs = target;
    },
  };
}

function makePodcast(overrides) {
  overrides = overrides || {};
  const timers = fakeTimers();
  const AudioCtor = overrides.audioContextCtor !== undefined
    ? overrides.audioContextCtor
    : fakeAudioContextClass(overrides.audioOptions);
  const deps = {
    audioContextCtor: AudioCtor,
    speech: overrides.speech !== undefined ? overrides.speech : fakeSpeech(),
    storage: overrides.storage || memoryStorage(),
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  };
  return { podcast: P.create(deps), deps, timers, AudioCtor };
}

/* ---------- persistence ---------- */

test('podcast: mode and bed volume persist like the other preferences', () => {
  const storage = memoryStorage();
  const { podcast } = makePodcast({ storage });
  assert.strictEqual(podcast.isEnabled(), false);
  assert.strictEqual(podcast.getBedVolume(), P.DEFAULT_BED_VOLUME);

  podcast.setEnabled(true);
  assert.strictEqual(storage.getItem(P.MODE_KEY), '1');
  podcast.setBedVolume(0.3);
  assert.strictEqual(storage.getItem(P.VOLUME_KEY), '0.3');
  podcast.setBedVolume(99); // clamped to the max
  assert.strictEqual(podcast.getBedVolume(), P.MAX_BED_VOLUME);
  podcast.setBedVolume(-1); // clamped to silence
  assert.strictEqual(podcast.getBedVolume(), 0);

  const again = makePodcast({ storage }).podcast; // fresh instance, same storage
  assert.strictEqual(again.isEnabled(), true);
  assert.strictEqual(again.getBedVolume(), 0);

  podcast.setEnabled(false);
  assert.strictEqual(storage.getItem(P.MODE_KEY), '0');
});

/* ---------- the bed ---------- */

test('podcast: enabling starts a generated bed; disabling tears it down', () => {
  const { podcast, AudioCtor } = makePodcast();
  assert.strictEqual(podcast.audioState(), 'off');
  podcast.setEnabled(true);
  assert.strictEqual(AudioCtor.instances.length, 1);
  const ctx = AudioCtor.instances[0];
  assert.strictEqual(podcast.audioState(), 'running');
  assert.strictEqual(podcast.isBedAvailable(), true);
  // First chord: 4 notes (triangle) + 1 sine root + 1 LFO oscillator.
  assert.strictEqual(ctx.oscillators.filter((o) => o.started).length, 6);
  const master = ctx.gains[0]; // startBed creates the master gain first
  assert.strictEqual(master.gain.value, P.DEFAULT_BED_VOLUME);

  podcast.setEnabled(false);
  assert.strictEqual(podcast.audioState(), 'off');
  assert.strictEqual(ctx.closed, true);
  assert.ok(ctx.oscillators.every((o) => !o.started || o.stopped));
});

test('podcast: chords cycle on the timer and retire the previous chord', () => {
  const { podcast, timers, AudioCtor } = makePodcast();
  podcast.setEnabled(true);
  const ctx = AudioCtor.instances[0];
  const before = ctx.oscillators.length;
  timers.advance(24000); // CHORD_MS
  assert.ok(ctx.oscillators.length > before, 'a new chord started');
  timers.advance(7000); // the retired chord's stop timer fires
  const firstChordOscs = ctx.oscillators.slice(1, 6); // [0] is the LFO
  assert.ok(firstChordOscs.every((o) => o.stopped), 'old chord stopped');
});

test('podcast: the bed ducks while narration speaks and swells back after', () => {
  const { podcast, AudioCtor } = makePodcast();
  podcast.setEnabled(true);
  const ctx = AudioCtor.instances[0];
  const master = ctx.gains[0]; // startBed creates the master gain first
  assert.strictEqual(master.gain.value, P.DEFAULT_BED_VOLUME);

  podcast.setSpeaking(true);
  assert.strictEqual(master.gain.value, P.DEFAULT_BED_VOLUME * P.DUCK_RATIO);
  podcast.setSpeaking(false);
  assert.strictEqual(master.gain.value, P.DEFAULT_BED_VOLUME);

  // Ducking follows the volume setting too.
  podcast.setBedVolume(0.2);
  assert.strictEqual(master.gain.value, 0.2);
  podcast.setSpeaking(true);
  assert.strictEqual(master.gain.value, 0.2 * P.DUCK_RATIO);
});

test('podcast: a suspended context reports honestly and resumes on interaction', () => {
  // Autoplay policy: the context starts suspended and resume() is
  // refused until the "user" has interacted (allowResume).
  const { podcast, AudioCtor } = makePodcast({
    audioOptions: { startSuspended: true, refuseResume: true },
  });
  podcast.setEnabled(true);
  assert.strictEqual(podcast.audioState(), 'suspended'); // not faked as playing
  assert.strictEqual(podcast.notifyInteraction(), 'suspended'); // still refused
  AudioCtor.instances[0].allowResume = true; // the gesture lands
  assert.strictEqual(podcast.notifyInteraction(), 'running');
  assert.strictEqual(podcast.audioState(), 'running');
});

/* ---------- the no-op halves ---------- */

test('podcast: no Web Audio → narration still works, bed reports unavailable', () => {
  const speech = fakeSpeech();
  const { podcast } = makePodcast({ audioContextCtor: null, speech });
  podcast.setEnabled(true);
  assert.strictEqual(podcast.isBedAvailable(), false);
  assert.strictEqual(podcast.audioState(), 'unavailable');
  assert.strictEqual(podcast.notifyInteraction(), 'unavailable');
  const outcome = podcast.considerMessage('display.text',
    { text: 'Dinner is at 7' }, { ok: true, payload: { shown: true } });
  assert.strictEqual(outcome, 'spoken');
  assert.deepStrictEqual(speech.calls, ['Dinner is at 7']);
  podcast.setSpeaking(true); // ducking with no bed: no crash
  podcast.setEnabled(false);
});

test('podcast: no TTS voices → the bed still plays and narration is a clean miss', () => {
  const speech = fakeSpeech(false); // say() declines: no voices on this TV
  const { podcast } = makePodcast({ speech });
  podcast.setEnabled(true);
  assert.strictEqual(podcast.audioState(), 'running');
  const outcome = podcast.considerMessage('display.text',
    { text: 'Dinner is at 7' }, { ok: true, payload: { shown: true } });
  assert.strictEqual(outcome, 'unavailable');
  assert.strictEqual(podcast.activity('connected'), false); // nothing handed over
  assert.strictEqual(podcast.audioState(), 'running'); // bed unaffected
});

/* ---------- message narration ---------- */

test('podcast: messages narrate only in mode, and never twice', () => {
  const speech = fakeSpeech();
  const { podcast } = makePodcast({ speech });

  // Mode off: nothing.
  assert.strictEqual(podcast.considerMessage('display.text',
    { text: 'Hi' }, { ok: true, payload: { shown: true } }), 'skipped-disabled');
  assert.deepStrictEqual(speech.calls, []);

  podcast.setEnabled(true);
  // The executor already spoke it (speak:true or read-aloud): defer.
  assert.strictEqual(podcast.considerMessage('display.text',
    { text: 'Hi' }, { ok: true, payload: { shown: true, spoken: true } }),
    'skipped-already-spoken');
  assert.deepStrictEqual(speech.calls, []);

  // Executor did not speak (no spoken field): podcast narrates.
  assert.strictEqual(podcast.considerMessage('display.text',
    { title: 'Note', text: 'Dinner at 7' }, { ok: true, payload: { shown: true } }), 'spoken');
  assert.deepStrictEqual(speech.calls, ['Note. Dinner at 7']);

  // Briefings compose title + lines the same way the executor speaks them.
  assert.strictEqual(podcast.considerMessage('display.briefing',
    { title: 'Morning', lines: ['Rain at 9', 'Train strike'] },
    { ok: true, payload: { shown: true } }), 'spoken');
  assert.strictEqual(speech.calls[1], 'Morning. Rain at 9. Train strike');

  // spoken:false means speech was attempted and unavailable: also a miss.
  assert.strictEqual(podcast.considerMessage('display.text',
    { text: 'Hi' }, { ok: true, payload: { shown: true, spoken: false } }), 'unavailable');
});

/* ---------- approval heuristic + emphasis ---------- */

test('podcast: the approval heuristic needs a keyword AND a request marker', () => {
  assert.strictEqual(P.looksLikeApproval('Can I delete the old backups? This needs your approval.'), true);
  assert.strictEqual(P.looksLikeApproval('Please confirm the payment to continue.'), true);
  assert.strictEqual(P.looksLikeApproval('Permission granted for the update.'), false); // no request
  assert.strictEqual(P.looksLikeApproval('What time is dinner?'), false); // no approval keyword
  assert.strictEqual(P.looksLikeApproval('The confirmation screen shows your booking.'), false);
  assert.strictEqual(P.looksLikeApproval('Dinner is at 7.'), false);
  assert.strictEqual(P.looksLikeApproval(''), false);
  assert.strictEqual(P.looksLikeApproval(null), false);
});

test('podcast: approval-looking messages are narrated with emphasis', () => {
  const speech = fakeSpeech();
  const { podcast } = makePodcast({ speech });
  podcast.setEnabled(true);
  const text = 'Muse wants to send an email on your behalf. Please approve?';
  assert.strictEqual(podcast.isApprovalText(text), true);
  assert.strictEqual(podcast.considerMessage('display.text',
    { text }, { ok: true, payload: { shown: true } }), 'spoken');
  assert.strictEqual(speech.calls[0], 'Attention. ' + text);
});

/* ---------- activity narration + rate limits ---------- */

test('podcast: activity lines narrate, pair up, and respect the rate limits', () => {
  const speech = fakeSpeech();
  const { podcast, timers } = makePodcast({ speech });

  assert.strictEqual(podcast.activity('connected'), false); // mode off
  podcast.setEnabled(true);

  assert.strictEqual(podcast.activity('connected'), true);
  assert.deepStrictEqual(speech.calls, ['Connected to Muse.']);
  assert.strictEqual(podcast.activity('connected'), false); // deduped

  // "done" with no spoken "working" before it is dropped.
  assert.strictEqual(podcast.activity('done'), false);

  // The global gap swallows a "working" right after the connect line.
  assert.strictEqual(podcast.activity('working'), false);
  timers.advance(P.ACTIVITY_GAP_MS);
  assert.strictEqual(podcast.activity('working'), true);
  assert.strictEqual(speech.calls[1], 'Working on it.');

  // "done" pairs with the spoken "working", once the gap has passed.
  assert.strictEqual(podcast.activity('done'), false); // too soon
  timers.advance(P.ACTIVITY_GAP_MS);
  assert.strictEqual(podcast.activity('done'), true);
  assert.strictEqual(speech.calls[2], 'Done.');

  // "working" has its own longer throttle even past the global gap.
  timers.advance(P.ACTIVITY_GAP_MS);
  assert.strictEqual(podcast.activity('working'), false);
  timers.advance(P.WORKING_MIN_MS);
  assert.strictEqual(podcast.activity('working'), true);

  // Disconnected dedupes within its window, then may speak again.
  assert.strictEqual(podcast.activity('disconnected'), true);
  assert.strictEqual(podcast.activity('disconnected'), false);
  timers.advance(P.DEDUPE_MS);
  assert.strictEqual(podcast.activity('disconnected'), true);

  assert.strictEqual(podcast.activity('bogus-kind'), false);
});
