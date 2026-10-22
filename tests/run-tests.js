'use strict';
/*
 * Test runner: node tests/run-tests.js [substring-filter]
 * Loads every test-*.js file in this directory (they register their tests),
 * then runs them in order. No npm dependencies.
 */
require('./test-crypto');
require('./test-goldens');
require('./test-noise');
require('./test-framing');
require('./test-pairing');
require('./test-muse-api');
require('./test-web-login');
require('./test-helper-fetch');
require('./test-app-modules');
require('./test-speech-keyboard');
require('./test-avatar');
require('./test-interop');

const { runAll } = require('./helpers');

runAll(process.argv[2]).then((failed) => {
  process.exitCode = failed > 0 ? 1 : 0;
});
