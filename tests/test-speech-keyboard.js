'use strict';
/*
 * Speech (text-to-speech) and keyboard planning.
 *
 * Speech is driven against a fake synthesiser with the W3C Web Speech
 * shape — the same object the Tizen TV web runtime exposes when the
 * device has the speech.synthesis feature. Keyboard tests drive the pure
 * planKey mapping over remote keys and hardware-keyboard keys in nav and
 * editing contexts. Executor tests stub the speech module and the UI.
 */
const assert = require('assert');
const { loadModules, test, memoryStorage } = require('./helpers');

const MG = loadModules();

/* ---------- fakes ---------- */

function FakeUtterance(text) {
  this.text = text;
  this.lang = null;
  this.voice = null;
  this.onend = null;
  this.onerror = null;
}

function fakeSynthesis(voices) {
  return {
    spoken: [],
    cancels: 0,
    speak(u) { this.spoken.push(u); },
    cancel() { this.cancels++; },
    getVoices() { return voices || []; },
  };
}

const VOICES = [
  { name: 'Deutsch', lang: 'de-DE', default: false },
  { name: 'English', lang: 'en-US', default: true },
];

function makeSpeech(overrides) {
  overrides = overrides || {};
  const synth = overrides.synthesis || fakeSynthesis(VOICES);
  const deps = Object.assign({
    Utterance: FakeUtterance,
    storage: memoryStorage(),
    lang: 'en-US',
  }, overrides, { synthesis: synth });
  return { speech: MG.speech.create(deps), synth, deps };
}

function endCurrent(synth) {
  const u = synth.spoken[synth.spoken.length - 1];
  assert.ok(u && u.onend, 'an utterance with onend is speaking');
  u.onend();
}

/* ---------- speech module ---------- */

test('speech: unsupported without a synthesiser or without voices, and silent', () => {
  const noSynth = MG.speech.create({ synthesis: null, Utterance: FakeUtterance, storage: memoryStorage() });
  assert.strictEqual(noSynth.isSupported(), false);
  assert.strictEqual(noSynth.say('hello'), false);
  assert.strictEqual(noSynth.announce('hello'), null); // disabled by default anyway

  const { speech, synth } = makeSpeech({ synthesis: fakeSynthesis([]) });
  assert.strictEqual(speech.isSupported(), true); // API object exists…
  assert.strictEqual(speech.canSpeak(), false);    // …but no voices behind it
  assert.strictEqual(speech.voiceCount(), 0);
  assert.strictEqual(speech.say('hello'), false);
  assert.strictEqual(synth.spoken.length, 0);
});

test('speech: say speaks with the default voice, queue holds at most one pending', () => {
  const { speech, synth } = makeSpeech();
  assert.strictEqual(speech.say('First message'), true);
  assert.strictEqual(synth.spoken.length, 1);
  assert.strictEqual(synth.spoken[0].text, 'First message');
  assert.strictEqual(synth.spoken[0].voice.name, 'English'); // default voice wins
  assert.strictEqual(synth.spoken[0].lang, 'en-US');
  assert.strictEqual(synth.spoken[0].pitch, undefined); // unsupported on Tizen TV
  assert.strictEqual(synth.spoken[0].volume, undefined);

  assert.strictEqual(speech.say('Second message'), true); // queued
  assert.strictEqual(speech.say('Third message'), true);  // replaces the queued one
  assert.strictEqual(synth.spoken.length, 1);
  assert.strictEqual(speech.hasPending(), true);

  endCurrent(synth);
  assert.strictEqual(synth.spoken.length, 2);
  assert.strictEqual(synth.spoken[1].text, 'Third message');
  assert.strictEqual(speech.hasPending(), false);
});

test('speech: interrupt cancels current speech and drops the queue', () => {
  const { speech, synth } = makeSpeech();
  speech.say('Long announcement');
  speech.say('Queued');
  assert.strictEqual(speech.say('Urgent', { interrupt: true }), true);
  assert.strictEqual(synth.cancels, 1);
  assert.strictEqual(synth.spoken.length, 2);
  assert.strictEqual(synth.spoken[1].text, 'Urgent');
  assert.strictEqual(speech.hasPending(), false);
});

test('speech: stop cancels and clears; empty text is a no-op', () => {
  const { speech, synth } = makeSpeech();
  assert.strictEqual(speech.say('   '), false);
  assert.strictEqual(speech.say(''), false);
  speech.say('Speaking');
  speech.say('Waiting');
  speech.stop();
  assert.strictEqual(synth.cancels, 1);
  assert.strictEqual(speech.isSpeaking(), false);
  assert.strictEqual(speech.hasPending(), false);
});

test('speech: spoken text is capped at 500 characters', () => {
  const { speech, synth } = makeSpeech();
  speech.say('x'.repeat(900));
  assert.strictEqual(synth.spoken[0].text.length, MG.speech.MAX_CHARS);
  assert.strictEqual(MG.speech.MAX_CHARS, 500);
});

test('speech: announce follows the persisted read-aloud preference', () => {
  const storage = memoryStorage();
  const { speech, synth } = makeSpeech({ storage });
  assert.strictEqual(speech.isEnabled(), false);
  assert.strictEqual(speech.announce('Quiet message'), null); // not attempted
  assert.strictEqual(synth.spoken.length, 0);

  speech.setEnabled(true);
  assert.strictEqual(storage.getItem(MG.speech.STORAGE_KEY), '1');
  assert.strictEqual(speech.announce('Loud message'), true);
  assert.strictEqual(synth.spoken.length, 1);

  // A fresh instance over the same storage starts enabled (persisted).
  const again = MG.speech.create({
    synthesis: synth, Utterance: FakeUtterance, storage, lang: 'en-US',
  });
  assert.strictEqual(again.isEnabled(), true);
  again.setEnabled(false);
  assert.strictEqual(storage.getItem(MG.speech.STORAGE_KEY), '0');
});

test('speech: voice picking falls back to language match, then first voice', () => {
  const noDefault = [
    { name: 'A', lang: 'de-DE', default: false },
    { name: 'B', lang: 'en-GB', default: false },
  ];
  const { speech, synth } = makeSpeech({ synthesis: fakeSynthesis(noDefault) });
  speech.say('Hello');
  assert.strictEqual(synth.spoken[0].voice.name, 'B'); // en-* prefix match
});

/* ---------- keyboard planning ---------- */

const kb = MG.keyboard;
const NAV = { cardVisible: false, editing: false, multiline: false, focusedButton: true, focusedField: false };
const EDIT1 = { cardVisible: false, editing: true, multiline: false, focusedButton: false, focusedField: true };
const EDITN = { cardVisible: false, editing: true, multiline: true, focusedButton: false, focusedField: true };

test('keyboard: a showing card dismisses on any key', () => {
  assert.deepStrictEqual(kb.planKey({ key: 'a' }, { cardVisible: true }), { action: 'dismiss' });
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowDown' }, { cardVisible: true }), { action: 'dismiss' });
});

test('keyboard: remote keys plan like before (arrows nav, Enter clicks, 10009 backs)', () => {
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowUp' }, NAV), { action: 'nav', direction: 'up' });
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowLeft' }, NAV), { action: 'nav', direction: 'left' });
  assert.deepStrictEqual(kb.planKey({ key: 'Enter', keyCode: 13 }, NAV), { action: 'activate' });
  assert.deepStrictEqual(kb.planKey({ key: '', keyCode: 10009 }, NAV), { action: 'back' });
  assert.deepStrictEqual(kb.planKey({ key: '', keyCode: 461 }, NAV), { action: 'back' });
  assert.deepStrictEqual(kb.planKey({ key: 'XF86Back' }, NAV), { action: 'back' });
});

test('keyboard: typing in a field passes through untouched, exactly once', () => {
  for (const key of ['a', 'Z', '5', ' ', '.', '@', 'Backspace', 'Delete', 'Home', 'End']) {
    assert.deepStrictEqual(kb.planKey({ key }, EDIT1), { action: 'passthrough' }, key);
  }
  // Caret arrows: left/right in a single-line field, everything in a textarea.
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowLeft' }, EDIT1), { action: 'passthrough' });
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowRight' }, EDIT1), { action: 'passthrough' });
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowUp' }, EDITN), { action: 'passthrough' });
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowDown' }, EDITN), { action: 'passthrough' });
  // Up/down in a single-line field still move spatial focus.
  assert.deepStrictEqual(kb.planKey({ key: 'ArrowUp' }, EDIT1), { action: 'nav', direction: 'up' });
});

test('keyboard: Enter submits a field, Escape leaves editing before going back', () => {
  assert.deepStrictEqual(kb.planKey({ key: 'Enter' }, EDIT1), { action: 'submit' });
  assert.deepStrictEqual(kb.planKey({ key: 'Escape', keyCode: 27 }, EDIT1), { action: 'exit-editing' });
  assert.deepStrictEqual(kb.planKey({ key: '', keyCode: 10009 }, EDIT1), { action: 'exit-editing' });
  assert.deepStrictEqual(kb.planKey({ key: 'Escape', keyCode: 27 }, NAV), { action: 'back' });
  // Spatial focus resting on a field (after exit-editing): Enter re-enters it.
  const ONFIELD = { cardVisible: false, editing: false, multiline: false, focusedButton: false, focusedField: true };
  assert.deepStrictEqual(kb.planKey({ key: 'Enter' }, ONFIELD), { action: 'edit' });
});

test('keyboard: Tab walks the controls; stray keys outside fields are swallowed', () => {
  assert.deepStrictEqual(kb.planKey({ key: 'Tab' }, NAV), { action: 'focus-next' });
  assert.deepStrictEqual(kb.planKey({ key: 'Tab', shiftKey: true }, NAV), { action: 'focus-prev' });
  assert.deepStrictEqual(kb.planKey({ key: 'Tab' }, EDIT1), { action: 'focus-next' });
  assert.deepStrictEqual(kb.planKey({ key: 'x' }, NAV), { action: 'ignore' });
  assert.deepStrictEqual(kb.planKey({ key: 'Backspace' }, NAV), { action: 'ignore' });
  assert.deepStrictEqual(kb.planKey({ key: ' ' }, NAV), { action: 'activate' }); // space on a button
});

/* ---------- executor speech wiring ---------- */

function stubUi() {
  return { showText() {}, showImage() {}, showBriefing() {} };
}

function stubSpeech(enabled) {
  const calls = [];
  return {
    calls,
    say(text, opts) { calls.push(['say', text, opts]); return true; },
    announce(text) { calls.push(['announce', text]); return enabled ? true : null; },
    stop() { calls.push(['stop']); },
    isSupported() { return true; },
  };
}

test('executor: display.text speaks only when asked or when read-aloud is on', async () => {
  const speech = stubSpeech(false);
  const exec = MG.executor.createExecutor(stubUi(), { speech });
  assert.deepStrictEqual(await exec.run('display.text', { text: 'Dinner at 7' }),
    { ok: true, payload: { shown: true } }); // announce returned null → no spoken field
  assert.deepStrictEqual(speech.calls, [['announce', 'Dinner at 7']]);

  speech.calls.length = 0;
  assert.deepStrictEqual(await exec.run('display.text', { text: 'Dinner at 7', speak: true }),
    { ok: true, payload: { shown: true, spoken: true } });
  assert.deepStrictEqual(speech.calls, [['say', 'Dinner at 7', undefined]]);

  speech.calls.length = 0;
  assert.deepStrictEqual(await exec.run('display.text', { title: 'Note', text: 'Dinner', speak: true }),
    { ok: true, payload: { shown: true, spoken: true } });
  assert.deepStrictEqual(speech.calls, [['say', 'Note. Dinner', undefined]]);

  const loud = stubSpeech(true);
  const exec2 = MG.executor.createExecutor(stubUi(), { speech: loud });
  assert.deepStrictEqual(await exec2.run('display.text', { text: 'Hi', speak: false }),
    { ok: true, payload: { shown: true } }); // speak:false suppresses even announce
  assert.deepStrictEqual(loud.calls, []);
  assert.strictEqual((await exec2.run('display.briefing', { title: 'Morning', lines: ['a', 'b'] })).payload.spoken, true);
  assert.deepStrictEqual(loud.calls, [['announce', 'Morning. a. b']]);
  assert.strictEqual((await exec2.run('display.text', { text: 'Hi', speak: 'yes' })).ok, false);
});

test('executor: speech.say and speech.stop reach the speech module', async () => {
  const speech = stubSpeech(false);
  const exec = MG.executor.createExecutor(stubUi(), { speech });
  assert.deepStrictEqual(await exec.run('speech.say', { text: 'Hello TV' }),
    { ok: true, payload: { spoken: true, supported: true } });
  assert.deepStrictEqual(speech.calls[0], ['say', 'Hello TV', { interrupt: false }]);
  await exec.run('speech.say', { text: 'Now', interrupt: true });
  assert.deepStrictEqual(speech.calls[1], ['say', 'Now', { interrupt: true }]);
  assert.deepStrictEqual(await exec.run('speech.stop', {}), { ok: true, payload: { stopped: true } });
  assert.deepStrictEqual(speech.calls[2], ['stop']);
  assert.strictEqual((await exec.run('speech.say', {})).ok, false);

  const bare = MG.executor.createExecutor(stubUi(), {}); // no speech dep at all
  assert.deepStrictEqual(await bare.run('speech.say', { text: 'Hello' }),
    { ok: true, payload: { spoken: false, supported: false } });
  assert.deepStrictEqual(await bare.run('speech.stop', {}), { ok: true, payload: { stopped: true } });
});
