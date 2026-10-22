'use strict';
/*
 * Bloop, the ambient avatar: the pure state machine (connection, work,
 * speech and greeting waves resolved into one visible state, driven by
 * injected timers), the trigger mapping from the app's real event
 * sources, the speech module's onSpeakingChange hook feeding it, and
 * the generated SVG markup (original art, no external references).
 */
const assert = require('assert');
const { loadModules, test, memoryStorage } = require('./helpers');

const MG = loadModules();

/* ---------- fake clock/timers (same shape as avatar.js's deps) ---------- */

function fakeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = seq++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.t.at;
        next.t.fn();
      }
      now = target;
    },
  };
}

function makeAvatar() {
  const clock = fakeClock();
  const avatar = MG.avatar.create(clock);
  const seen = [];
  avatar.onChange((state) => seen.push(state));
  return { avatar, clock, seen };
}

function connect(avatar, clock) {
  avatar.serviceState('registered');
  clock.advance(MG.avatar.WAVE_MS); // let the greeting wave finish
}

/* ---------- state machine ---------- */

test('avatar: starts asleep, and a wave while disconnected is a no-op', () => {
  const { avatar, clock, seen } = makeAvatar();
  assert.strictEqual(avatar.getState(), 'sleep');
  assert.strictEqual(avatar.isConnected(), false);
  assert.strictEqual(avatar.wave(), false);
  clock.advance(10000);
  assert.strictEqual(avatar.getState(), 'sleep');
  assert.deepStrictEqual(seen, []);
});

test('avatar: connecting greets with a wave, then settles to idle', () => {
  const { avatar, clock, seen } = makeAvatar();
  avatar.serviceState('connecting'); // not a connection yet
  assert.strictEqual(avatar.getState(), 'sleep');
  avatar.serviceState('registered');
  assert.strictEqual(avatar.getState(), 'wave');
  clock.advance(MG.avatar.WAVE_MS - 1);
  assert.strictEqual(avatar.getState(), 'wave');
  clock.advance(1);
  assert.strictEqual(avatar.getState(), 'idle');
  assert.deepStrictEqual(seen, ['wave', 'idle']);
});

test('avatar: dropping the connection sleeps, whatever was happening', () => {
  const { avatar, clock } = makeAvatar();
  connect(avatar, clock);
  assert.strictEqual(avatar.getState(), 'idle');
  avatar.beginWork();
  assert.strictEqual(avatar.getState(), 'busy');
  avatar.serviceState('waiting');
  assert.strictEqual(avatar.getState(), 'sleep');
  clock.advance(10000); // no zombie busy/wave timers fire afterwards
  assert.strictEqual(avatar.getState(), 'sleep');
  avatar.serviceState('registered');
  assert.strictEqual(avatar.getState(), 'wave'); // reconnect greets again
});

test('avatar: busy nests and never flashes for less than the minimum spell', () => {
  const { avatar, clock } = makeAvatar();
  connect(avatar, clock);
  avatar.beginWork();
  avatar.beginWork();
  assert.strictEqual(avatar.getState(), 'busy');
  avatar.endWork(); // one level still open
  assert.strictEqual(avatar.getState(), 'busy');
  clock.advance(120); // the work was quick…
  avatar.endWork();
  assert.strictEqual(avatar.getState(), 'busy'); // …but the face holds
  clock.advance(MG.avatar.MIN_BUSY_MS - 120 - 1);
  assert.strictEqual(avatar.getState(), 'busy');
  clock.advance(1);
  assert.strictEqual(avatar.getState(), 'idle');

  // Work that runs long clears the moment it ends.
  avatar.beginWork();
  clock.advance(MG.avatar.MIN_BUSY_MS + 500);
  avatar.endWork();
  assert.strictEqual(avatar.getState(), 'idle');

  // An unbalanced endWork is ignored, not a phantom busy spell.
  avatar.endWork();
  clock.advance(5000);
  assert.strictEqual(avatar.getState(), 'idle');
});

test('avatar: speaking outranks busy and wave, and yields back to busy', () => {
  const { avatar, clock } = makeAvatar();
  connect(avatar, clock);
  avatar.beginWork();
  avatar.setSpeaking(true);
  assert.strictEqual(avatar.getState(), 'speaking');
  avatar.setSpeaking(false);
  assert.strictEqual(avatar.getState(), 'busy');
  clock.advance(MG.avatar.MIN_BUSY_MS);
  avatar.endWork();
  assert.strictEqual(avatar.getState(), 'idle');
});

test('avatar: a wave asked for mid-work is remembered and played after', () => {
  const { avatar, clock } = makeAvatar();
  connect(avatar, clock);
  avatar.beginWork();
  assert.strictEqual(avatar.wave(), false); // too busy to wave right now
  clock.advance(MG.avatar.MIN_BUSY_MS + 100);
  avatar.endWork();
  assert.strictEqual(avatar.getState(), 'wave'); // …so it waves now
  clock.advance(MG.avatar.WAVE_MS);
  assert.strictEqual(avatar.getState(), 'idle');
});

/* ---------- trigger mapping ---------- */

test('avatar: display.* commands wave on arrival; other commands do not', () => {
  const { avatar, clock } = makeAvatar();
  connect(avatar, clock);

  avatar.commandStarted('display.text');
  assert.strictEqual(avatar.getState(), 'busy');
  clock.advance(MG.avatar.MIN_BUSY_MS + 50);
  avatar.commandFinished('display.text');
  assert.strictEqual(avatar.getState(), 'wave'); // a message arrived: greet it
  clock.advance(MG.avatar.WAVE_MS);
  assert.strictEqual(avatar.getState(), 'idle');

  avatar.commandStarted('display.briefing');
  clock.advance(MG.avatar.MIN_BUSY_MS + 50);
  avatar.commandFinished('display.briefing');
  assert.strictEqual(avatar.getState(), 'wave');
  clock.advance(MG.avatar.WAVE_MS);

  avatar.commandStarted('tv.volume.set');
  assert.strictEqual(avatar.getState(), 'busy');
  clock.advance(MG.avatar.MIN_BUSY_MS + 50);
  avatar.commandFinished('tv.volume.set');
  assert.strictEqual(avatar.getState(), 'idle'); // no wave for housekeeping

  // A display command whose speech is still playing waves only after.
  avatar.commandStarted('display.text');
  avatar.setSpeaking(true);
  clock.advance(MG.avatar.MIN_BUSY_MS + 50);
  avatar.commandFinished('display.text');
  assert.strictEqual(avatar.getState(), 'speaking');
  avatar.setSpeaking(false);
  assert.strictEqual(avatar.getState(), 'wave');
  clock.advance(MG.avatar.WAVE_MS);
  assert.strictEqual(avatar.getState(), 'idle');
});

test('avatar: command events while disconnected stay asleep', () => {
  const { avatar, clock } = makeAvatar();
  avatar.commandStarted('display.text');
  avatar.commandFinished('display.text');
  clock.advance(10000);
  assert.strictEqual(avatar.getState(), 'sleep');
});

/* ---------- speech hook integration ---------- */

function FakeUtterance(text) {
  this.text = text;
  this.lang = null;
  this.voice = null;
  this.onend = null;
  this.onerror = null;
}

test('avatar + speech: the speaking hook lip-flaps exactly while speech runs', () => {
  const { avatar, clock } = makeAvatar();
  connect(avatar, clock);

  const spoken = [];
  const events = [];
  const synthesis = {
    speak(u) { spoken.push(u); },
    cancel() {},
    getVoices() { return [{ name: 'English', lang: 'en-US', default: true }]; },
  };
  const speech = MG.speech.create({
    synthesis,
    Utterance: FakeUtterance,
    storage: memoryStorage(),
    lang: 'en-US',
    onSpeakingChange: (value) => { events.push(value); avatar.setSpeaking(value); },
  });

  assert.strictEqual(speech.say('Dinner is at seven.'), true);
  assert.deepStrictEqual(events, [true]);
  assert.strictEqual(avatar.getState(), 'speaking');

  // A queued second utterance is not a new transition: no flicker.
  assert.strictEqual(speech.say('And there is cake.'), true);
  spoken[spoken.length - 1].onend(); // first ends, second starts
  assert.deepStrictEqual(events, [true]);
  assert.strictEqual(avatar.getState(), 'speaking');

  spoken[spoken.length - 1].onend(); // second ends: silence
  assert.deepStrictEqual(events, [true, false]);
  assert.strictEqual(avatar.getState(), 'idle');

  // stop() mid-utterance also ends the speaking state.
  speech.say('One more thing');
  assert.strictEqual(avatar.getState(), 'speaking');
  speech.stop();
  assert.deepStrictEqual(events, [true, false, true, false]);
  assert.strictEqual(avatar.getState(), 'idle');

  // An interrupt swaps utterances without a speaking transition.
  speech.say('First');
  speech.say('Interrupt!', { interrupt: true });
  assert.deepStrictEqual(events, [true, false, true, false, true]);
  assert.strictEqual(avatar.getState(), 'speaking');
  clock.advance(1); // machine timers do not interfere
  assert.strictEqual(avatar.getState(), 'speaking');
});

/* ---------- markup ---------- */

test('avatar: markup is one self-contained original SVG (no external art)', () => {
  const svg = MG.avatar.buildMarkup();
  assert.ok(svg.startsWith('<svg'), 'an inline SVG');
  assert.ok(svg.includes('class="bloop"'));
  for (const part of ['bloop-float', 'bloop-arm-right', 'bloop-arm-left',
    'bloop-eyes-open', 'bloop-eyes-closed', 'bloop-mouth-talk',
    'bloop-mouth-smile', 'bloop-dots', 'bloop-orb', 'bloop-zzz']) {
    assert.ok(svg.includes(part), 'markup has ' + part);
  }
  assert.ok(!/<img|url\(http|href=|src=/.test(svg), 'no external references');
  assert.ok(!/jolly/i.test(svg), 'no third-party character naming');
  assert.strictEqual(MG.avatar.NAME, 'Bloop');
});

test('avatar: mount mirrors state onto a container and unmounts cleanly', () => {
  const { avatar, clock } = makeAvatar();
  const attrs = {};
  const container = {
    innerHTML: '',
    setAttribute(name, value) { attrs[name] = value; },
  };
  const mounted = MG.avatar.mount(container, avatar);
  assert.ok(mounted, 'mounts against a minimal container');
  assert.ok(container.innerHTML.includes('<svg'));
  assert.strictEqual(attrs['data-state'], 'sleep');
  avatar.serviceState('registered');
  assert.strictEqual(attrs['data-state'], 'wave');
  clock.advance(MG.avatar.WAVE_MS);
  assert.strictEqual(attrs['data-state'], 'idle');
  mounted.unmount();
  assert.strictEqual(container.innerHTML, '');
  avatar.serviceState('waiting'); // unsubscribed: no more mirroring
  assert.strictEqual(attrs['data-state'], 'idle');
  assert.strictEqual(MG.avatar.mount(null, avatar), null);
  assert.strictEqual(MG.avatar.mount(container, null), null);
});
