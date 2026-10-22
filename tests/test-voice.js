'use strict';
/*
 * Voice input experiment: the MG.voice controller against a fake
 * webapis.voiceinteraction with the Samsung Product API's shape.
 * Covers detection (absent / partial / present), callback registration
 * (including a privilege-style refusal), the onupdatestate mapping,
 * content-context building, dictated text routed into the composer
 * draft, listen() outcomes, and the full no-op behaviour when the API
 * is absent. Nothing here proves a real TV grants any of it — that is
 * the experiment the module is built to report on.
 */
const assert = require('assert');
const { loadModules, test } = require('./helpers');

const MG = loadModules();

/* ---------- fakes ---------- */

function namedError(name, message) {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

function fakeVoiceInteraction(overrides) {
  const vi = {
    calls: { setCallback: [], listen: 0, items: [], responses: [] },
    version: '2.1-fake',
    setCallback(callbacks) { this.calls.setCallback.push(callbacks); },
    listen() { this.calls.listen++; },
    getVersion() { return this.version; },
    buildVoiceInteractionContentContextItem(x, y, title, aliases, focused) {
      const item = { positionX: x, positionY: y, title, alias: aliases, bFocused: focused };
      this.calls.items.push(item);
      return item;
    },
    buildVoiceInteractionContentContextResponse(items) {
      this.calls.responses.push(items);
      return 'CTX<' + items.map((i) => i.title).join('|') + '>';
    },
  };
  return Object.assign(vi, overrides || {});
}

function makeVoice(overrides) {
  overrides = overrides || {};
  const statuses = [];
  const drafts = [];
  let context = overrides.context || { screen: 'main', composerFocused: false };
  const deps = {
    webapis: overrides.webapis !== undefined
      ? overrides.webapis
      : { voiceinteraction: overrides.vi || fakeVoiceInteraction() },
    getContext: () => context,
    setDraft: (text) => drafts.push(text),
    onStatus: (text) => statuses.push(text),
  };
  return {
    voice: MG.voice.create(deps),
    deps, statuses, drafts,
    setContext(next) { context = next; },
  };
}

/* ---------- detection / no-op behaviour ---------- */

test('voice: no webapis at all → unavailable, and every method a safe no-op', () => {
  const { voice, statuses } = makeVoice({ webapis: null });
  assert.strictEqual(voice.isAvailable(), false);
  assert.deepStrictEqual(voice.describe(),
    { available: false, registered: false, version: null, error: null });
  assert.strictEqual(voice.start(), false);
  assert.strictEqual(voice.listen(), false);
  assert.ok(statuses.every((s) => /unavailable/i.test(s)), statuses.join(' / '));
  assert.strictEqual(voice.lastHeard(), null);

  const bare = makeVoice({ webapis: {} }); // webapis without the namespace
  assert.strictEqual(bare.voice.isAvailable(), false);
  assert.strictEqual(bare.voice.start(), false);
});

test('voice: a partial API (no setCallback/listen) counts as unavailable', () => {
  const { voice } = makeVoice({ vi: { getVersion() { return '1.0'; } } });
  assert.strictEqual(voice.isAvailable(), false);
  assert.strictEqual(voice.start(), false);
  assert.strictEqual(voice.listen(), false);
});

/* ---------- registration ---------- */

test('voice: registration hands the platform the full callback set', () => {
  const vi = fakeVoiceInteraction();
  const { voice } = makeVoice({ vi });
  assert.strictEqual(voice.start(), true);
  assert.strictEqual(vi.calls.setCallback.length, 1);
  const callbacks = vi.calls.setCallback[0];
  for (const name of ['onupdatestate', 'onrequestcontentcontext',
    'ontitleselection', 'onchangeappstate', 'onnavigation', 'onselection']) {
    assert.strictEqual(typeof callbacks[name], 'function', name);
  }
  assert.deepStrictEqual(voice.describe(),
    { available: true, registered: true, version: '2.1-fake', error: null });
  assert.strictEqual(voice.start(), true); // idempotent: no re-register
  assert.strictEqual(vi.calls.setCallback.length, 1);
});

test('voice: a privilege refusal at setCallback is surfaced, not hidden', () => {
  const vi = fakeVoiceInteraction({
    setCallback() { throw namedError('SecurityError', 'privilege denied'); },
  });
  const { voice, statuses } = makeVoice({ vi });
  assert.strictEqual(voice.start(), false);
  const d = voice.describe();
  assert.strictEqual(d.available, true);   // the API object exists…
  assert.strictEqual(d.registered, false); // …but registration was refused
  assert.ok(/SecurityError/.test(d.error), d.error);
  assert.ok(statuses.some((s) => /registration failed/.test(s) && /SecurityError/.test(s)));
});

test('voice: getVersion throwing still counts as present, version null', () => {
  const vi = fakeVoiceInteraction({
    getVersion() { throw namedError('SecurityError', 'nope'); },
  });
  const { voice } = makeVoice({ vi });
  assert.strictEqual(voice.isAvailable(), true);
  assert.strictEqual(voice.describe().version, null);
  assert.strictEqual(voice.start(), true); // registration itself works
});

/* ---------- state reporting ---------- */

test('voice: onupdatestate maps the app context onto platform states', () => {
  assert.strictEqual(MG.voice.appStateFor(null), 'None');
  assert.strictEqual(MG.voice.appStateFor({}), 'None');
  assert.strictEqual(MG.voice.appStateFor({ screen: 'main' }), 'Home');
  assert.strictEqual(MG.voice.appStateFor({ screen: 'setup' }), 'Setting');
  assert.strictEqual(MG.voice.appStateFor({ screen: 'main', composerFocused: true }), 'Search');
  assert.strictEqual(MG.voice.appStateFor({ screen: 'setup', composerFocused: true }), 'Search');

  const vi = fakeVoiceInteraction();
  const m = makeVoice({ vi });
  m.voice.start();
  const callbacks = vi.calls.setCallback[0];
  assert.strictEqual(callbacks.onupdatestate(), 'Home');
  m.setContext({ screen: 'setup', composerFocused: false });
  assert.strictEqual(callbacks.onupdatestate(), 'Setting');
  m.setContext({ screen: 'main', composerFocused: true });
  assert.strictEqual(callbacks.onupdatestate(), 'Search');
});

test('voice: content context offers the composer, focused only when it is', () => {
  const vi = fakeVoiceInteraction();
  const m = makeVoice({ vi });
  m.voice.start();
  const callbacks = vi.calls.setCallback[0];

  const response = callbacks.onrequestcontentcontext();
  assert.strictEqual(response, 'CTX<Message to Muse>');
  assert.strictEqual(vi.calls.items.length, 1);
  assert.strictEqual(vi.calls.items[0].title, MG.voice.COMPOSER_TITLE);
  assert.strictEqual(vi.calls.items[0].bFocused, false);
  assert.ok(vi.calls.items[0].alias.includes('search'));

  m.setContext({ screen: 'main', composerFocused: true });
  callbacks.onrequestcontentcontext();
  assert.strictEqual(vi.calls.items[1].bFocused, true);
});

test('voice: a broken context builder degrades to undefined, never a throw', () => {
  const vi = fakeVoiceInteraction({
    buildVoiceInteractionContentContextResponse() { throw namedError('TypeMismatchError'); },
  });
  const { voice } = makeVoice({ vi });
  voice.start();
  assert.strictEqual(voice.callbacks.onrequestcontentcontext(), undefined);
});

/* ---------- dictated text → composer draft ---------- */

test('voice: title selection delivers the heard string as an unsent draft', () => {
  const vi = fakeVoiceInteraction();
  const m = makeVoice({ vi });
  m.voice.start();
  const callbacks = vi.calls.setCallback[0];

  assert.strictEqual(callbacks.ontitleselection('what is the weather tomorrow'), true);
  assert.deepStrictEqual(m.drafts, ['what is the weather tomorrow']);
  assert.deepStrictEqual(m.voice.lastHeard(),
    { text: 'what is the weather tomorrow', via: 'title selection' });
  const last = m.statuses[m.statuses.length - 1];
  assert.ok(/Voice heard: "what is the weather tomorrow"/.test(last), last);
  assert.ok(/draft, not sent/.test(last), last);

  // Whitespace-only "dictation" is a no-result: no draft, no claim.
  assert.strictEqual(callbacks.ontitleselection('   '), false);
  assert.strictEqual(m.drafts.length, 1);
});

test('voice: state changes are surfaced; navigation/selection are not consumed', () => {
  const vi = fakeVoiceInteraction();
  const m = makeVoice({ vi });
  m.voice.start();
  const callbacks = vi.calls.setCallback[0];

  assert.strictEqual(callbacks.onchangeappstate('Search'), true);
  assert.ok(/app state to "Search"/.test(m.statuses[m.statuses.length - 1]));

  assert.strictEqual(callbacks.onnavigation('NAV_LEFT'), false); // TV default applies
  assert.ok(/navigation "NAV_LEFT"/.test(m.statuses[m.statuses.length - 1]));
  assert.strictEqual(callbacks.onselection(0), false);
  assert.ok(/selection 0/.test(m.statuses[m.statuses.length - 1]));
  assert.deepStrictEqual(m.drafts, []); // none of this produced text
});

/* ---------- listen() ---------- */

test('voice: listen() reports acceptance and platform refusals verbatim', () => {
  const vi = fakeVoiceInteraction();
  const m = makeVoice({ vi });
  m.voice.start();
  assert.strictEqual(m.voice.listen(), true);
  assert.strictEqual(vi.calls.listen, 1);
  assert.ok(/listening/.test(m.statuses[m.statuses.length - 1]));

  const refusing = fakeVoiceInteraction({
    listen() { throw namedError('SecurityError', 'voicecontrol not granted'); },
  });
  const m2 = makeVoice({ vi: refusing });
  m2.voice.start();
  assert.strictEqual(m2.voice.listen(), false);
  assert.ok(/listen\(\) failed: SecurityError/.test(m2.statuses[m2.statuses.length - 1]),
    m2.statuses.join(' / '));
});
