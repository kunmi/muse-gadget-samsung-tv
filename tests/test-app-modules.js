'use strict';
/*
 * Identity, store and executor behaviour (TV commands with the Tizen APIs
 * absent, as they are off-device: guarded paths must answer with proper
 * link.result-style errors, never throw).
 */
const assert = require('assert');
const { loadModules, test, memoryStorage } = require('./helpers');

const MG = loadModules();
const u = MG.util;

test('identity: generated once, MAC-shaped, names derived as the SDK derives them', () => {
  const storage = memoryStorage();
  const first = MG.identity.loadOrCreate(storage);
  assert.ok(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(first.mac), first.mac);
  const octets = first.mac.split(':').map((h) => parseInt(h, 16));
  assert.strictEqual(octets[0] & 0x03, 0x02, 'locally administered, unicast');
  const suffix = first.mac.replace(/:/g, '').slice(-6);
  assert.strictEqual(first.nodeId, 'homelink-' + suffix);
  assert.strictEqual(first.deviceId, 'hatch-link:' + first.mac);
  assert.strictEqual(first.bleName, 'MuseGadget' + suffix.toUpperCase());
  assert.strictEqual(first.displayName, 'MuseGadgetTV' + suffix.toUpperCase());
  const second = MG.identity.loadOrCreate(storage);
  assert.strictEqual(second.mac, first.mac, 'identity persists across loads');
});

test('store: SDK token validation matches config.py', () => {
  const store = new MG.store.Store(memoryStorage());
  const good = 'mgst_' + 'a'.repeat(42) + 'A';
  assert.strictEqual(store.setSdkToken(good), good);
  assert.strictEqual(store.getSdkToken(), good);
  assert.strictEqual(MG.store.sdkTokenHint(good), 'mgst_aaaaaaa');
  assert.strictEqual(MG.store.sdkTokenHint(null), 'none');
  assert.throws(() => store.setSdkToken('mgst_short'), /not valid/);
  assert.throws(() => store.setSdkToken('mgst_' + 'a'.repeat(42) + 'B'), /not valid/); // final char class
  assert.throws(() => store.setSdkToken('nope_' + 'a'.repeat(43)), /not valid/);
});

test('store: pairing record round trip, corrupt data reads as unpaired', () => {
  const storage = memoryStorage();
  const store = new MG.store.Store(storage);
  assert.strictEqual(store.getPairing(), null);
  const record = { access_token: 'a', refresh_token: 'r', token_type: 'device' };
  store.setPairing(record);
  assert.deepStrictEqual(store.getPairing(), record);
  store.clearPairing();
  assert.strictEqual(store.getPairing(), null);
  storage.setItem('museGadgetTv.pairing', '{broken');
  assert.strictEqual(store.getPairing(), null);
  storage.setItem('museGadgetTv.pairing', '{"access_token":1}');
  assert.strictEqual(store.getPairing(), null);
});

test('executor: display commands reach the UI hooks and report ok', async () => {
  const shown = [];
  const ui = {
    showText: (c) => shown.push(['text', c]),
    showImage: (c) => shown.push(['image', c]),
    showBriefing: (c) => shown.push(['briefing', c]),
  };
  const exec = MG.executor.createExecutor(ui, { startedAt: Date.now(), nodeId: 'homelink-x', version: '0.1.0' });
  assert.deepStrictEqual(await exec.run('display.text', { text: 'Dinner at 7' }), { ok: true, payload: { shown: true } });
  assert.deepStrictEqual(shown[0], ['text', { title: null, text: 'Dinner at 7' }]);
  assert.strictEqual((await exec.run('display.image', { url: 'https://example.com/a.png', caption: 'hi' })).ok, true);
  assert.strictEqual((await exec.run('display.image', { url: 'ftp://nope' })).ok, false);
  const briefing = await exec.run('display.briefing', { title: 'Morning', lines: ['a', 'b'] });
  assert.deepStrictEqual(briefing, { ok: true, payload: { shown: true, lines: 2 } });
  const briefingStr = await exec.run('display.briefing', { title: 'Morning', lines: 'a\nb' });
  assert.strictEqual(briefingStr.ok, true);
  assert.strictEqual((await exec.run('display.text', {})).ok, false);
});

test('executor: unknown commands and missing params are errors, never crashes', async () => {
  const exec = MG.executor.createExecutor({
    showText() {}, showImage() {}, showBriefing() {},
  }, {});
  const unknown = await exec.run('system.run', { command: 'rm -rf /' });
  assert.strictEqual(unknown.ok, false);
  assert.ok(/unknown command/.test(unknown.error));
  assert.strictEqual((await exec.run('tv.volume.set', { level: 'loud' })).ok, false);
  assert.strictEqual((await exec.run('tv.launch_app', {})).ok, false);
});

test('executor: TV-dependent commands fail cleanly without Tizen APIs', async () => {
  const exec = MG.executor.createExecutor({
    showText() {}, showImage() {}, showBriefing() {},
  }, {});
  const vol = await exec.run('tv.volume.get', {});
  assert.strictEqual(vol.ok, false);
  assert.ok(/not available/.test(vol.error));
  const health = await exec.run('device.health', {});
  assert.strictEqual(health.ok, true);
  assert.strictEqual(typeof health.payload.uptime_s, 'number');
});

test('executor: COMMAND_SPECS advertises the TV set and nothing dangerous', () => {
  const names = Object.keys(MG.executor.COMMAND_SPECS).sort();
  assert.deepStrictEqual(names, [
    'device.health', 'display.briefing', 'display.image', 'display.text',
    'speech.say', 'speech.stop',
    'tv.launch_app', 'tv.mute', 'tv.volume.down', 'tv.volume.get',
    'tv.volume.set', 'tv.volume.up',
  ]);
  for (const name of names) {
    const spec = MG.executor.COMMAND_SPECS[name];
    assert.strictEqual(typeof spec.description, 'string');
    assert.ok(spec.required && spec.optional);
  }
});
