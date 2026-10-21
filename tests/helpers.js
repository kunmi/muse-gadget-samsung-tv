'use strict';
/*
 * Shared helpers for the Node test suite: loads the app's plain-script
 * modules in index.html order (they attach to globalThis.MG) and provides a
 * tiny test registry. No npm dependencies.
 */
const path = require('path');

const APP_JS = path.join(__dirname, '..', 'app', 'js');
const MODULE_ORDER = [
  'util.js', 'crypto.js', 'p256.js', 'proto.js', 'noise.js', 'envelope.js',
  'framing.js', 'transport.js', 'control-framing.js', 'muse-api.js',
  'identity.js', 'store.js', 'pairing.js', 'tv.js', 'executor.js',
  'link-session.js', 'service.js',
];

let loaded = false;
function loadModules() {
  if (loaded) return globalThis.MG;
  for (const file of MODULE_ORDER) require(path.join(APP_JS, file));
  loaded = true;
  return globalThis.MG;
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function runAll(filter) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const { name, fn } of tests) {
    if (filter && !name.includes(filter)) { skipped++; continue; }
    try {
      const result = await fn();
      if (result && result.skipped) {
        skipped++;
        console.log('skip - ' + name + ' (' + result.skipped + ')');
      } else {
        passed++;
        console.log('ok   - ' + name);
      }
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log('       ' + String((err && err.stack) || err).split('\n').join('\n       '));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped');
  return failed;
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

module.exports = { loadModules, test, runAll, memoryStorage, APP_JS };
