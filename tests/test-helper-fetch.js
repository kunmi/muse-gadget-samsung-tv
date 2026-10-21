'use strict';
/*
 * Pairing-helper fetch: the TV side of the login the README recommends.
 * A local mock plays the pairing helper (tools/pairing-helper's protocol:
 * GET /pairing?code=<6 digits> serves {"identity", "pairing"} once, 403
 * for a wrong code) and a second mock plays the Muse device API. The
 * fetched payload must flow through the same parse + verify-and-save gate
 * as a paste (test-web-login.js), and anything the helper or the API
 * refuses must leave the TV exactly as it was. Nothing leaves the machine.
 */
const assert = require('assert');
const http = require('http');
const { loadModules, test, memoryStorage } = require('./helpers');

const MG = loadModules();
const webLogin = MG.webLogin;

const IDENTITY_JSON = JSON.stringify({ mac: 'AA:BB:CC:DD:EE:FF' });
const PAIRING_JSON = JSON.stringify({
  access_token: 'dev-access-1',
  refresh_token: 'dev-refresh-1',
  token_type: 'device',
  username: 'someone',
  api_url: '',
  api_url_v2: '',
  noise_host: 'hatch.metaaivm.com',
  access_token_saved_at: 1790000000,
  sdk_token_hint: 'mgst_abcdefg',
});
const GOOD_PAYLOAD = JSON.stringify({ identity: IDENTITY_JSON, pairing: PAIRING_JSON });
const CODE = '042917';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

// The deps.httpGet the TV builds on XMLHttpRequest (app.js), here over
// Node's http so the fetch path runs against a real socket server.
function nodeHttpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

// A stand-in for tools/pairing-helper: serves `payload` once, only to the
// request carrying `code`; a wrong code is a 403 that consumes nothing.
function helperHandler(state, payload) {
  return (req, res) => {
    const url = new URL(req.url, 'http://helper');
    state.requests.push(url.pathname + url.search);
    if (url.pathname !== '/pairing') {
      res.writeHead(404); res.end('not found'); return;
    }
    if (state.consumed) { res.writeHead(410); res.end('gone'); return; }
    if (url.searchParams.get('code') !== CODE) {
      res.writeHead(403); res.end('wrong code'); return;
    }
    state.consumed = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
  };
}

// A stand-in for the Muse device API: leases one VM (or none, when
// `lease` is false) to whoever presents the transferred access token.
function apiHandler(state, lease) {
  return (req, res) => {
    state.requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lease
      ? { vm_list: [{ vm_ws_url: 'wss://vm', vm_auth_token: 'tok', vm_name: 'vm', vm_id: '1', default: true }] }
      : { vm_list: [] }));
  };
}

function loginDeps(storage, overrides) {
  const store = new MG.store.Store(storage);
  return Object.assign({
    fetchVms: MG.museApi.fetchVms,
    apiRoot: MG.museApi.apiRoot,
    store,
    sdkToken: null,
    nowSeconds: () => 1800000000,
    httpGet: nodeHttpGet,
    adoptIdentity: (mac) => MG.identity.adoptMac(storage, mac),
  }, overrides || {});
}

test('helperFetch: normalizeHelperAddress accepts what a user will type', () => {
  assert.strictEqual(webLogin.normalizeHelperAddress('192.168.1.42:8737'),
    'http://192.168.1.42:8737');
  assert.strictEqual(webLogin.normalizeHelperAddress('192.168.1.42'),
    'http://192.168.1.42:8737'); // the helper's default port
  assert.strictEqual(webLogin.normalizeHelperAddress('http://192.168.1.42:9000/'),
    'http://192.168.1.42:9000');
  assert.strictEqual(webLogin.normalizeHelperAddress('  raspberrypi.local:8737 '),
    'http://raspberrypi.local:8737');
  assert.throws(() => webLogin.normalizeHelperAddress(''),
    /Enter the helper address/);
  assert.throws(() => webLogin.normalizeHelperAddress('192.168.1.42:abc'),
    /bad port/);
  assert.throws(() => webLogin.normalizeHelperAddress('not an address'),
    /does not look like a helper address/);
});

test('helperFetch: a malformed code never touches the network', async () => {
  let calls = 0;
  const deps = loginDeps(memoryStorage(), {
    httpGet: () => { calls++; return Promise.resolve({ status: 200, body: GOOD_PAYLOAD }); },
  });
  await assert.rejects(
    webLogin.loginFromHelper(deps, '192.168.1.42:8737', '12345'),
    /6-digit code/);
  await assert.rejects(
    webLogin.loginFromHelper(deps, '192.168.1.42:8737', 'abcdef'),
    /6-digit code/);
  assert.strictEqual(calls, 0);
  assert.strictEqual(deps.store.getPairing(), null);
});

test('helperFetch: fetch, verify, save and adopt — the recommended login end to end', async () => {
  const helperState = { requests: [], consumed: false };
  const apiState = { requests: [] };
  const helper = await startServer(helperHandler(helperState, GOOD_PAYLOAD));
  const api = await startServer(apiHandler(apiState, true));
  try {
    const storage = memoryStorage();
    const before = MG.identity.loadOrCreate(storage);
    const deps = loginDeps(storage, { apiRoot: () => api.base });
    const helperAddress = helper.base.replace('http://', '');
    const result = await webLogin.loginFromHelper(deps, helperAddress, CODE);

    assert.strictEqual(result.nodeId, 'homelink-ddeeff');
    // The helper was asked once, for the pairing, with the typed code.
    assert.deepStrictEqual(helperState.requests, ['/pairing?code=' + CODE]);
    assert.strictEqual(helperState.consumed, true);
    // The gate ran against the device API with the transferred token.
    assert.strictEqual(apiState.requests.length, 1);
    assert.strictEqual(apiState.requests[0].headers.authorization, 'Bearer dev-access-1');
    // The saved record is the SDK's pairing record shape, and the
    // identity was adopted — the same outcome as the paste login.
    const saved = deps.store.getPairing();
    assert.strictEqual(saved.access_token, 'dev-access-1');
    assert.strictEqual(saved.refresh_token, 'dev-refresh-1');
    const adopted = MG.identity.loadOrCreate(storage);
    assert.strictEqual(adopted.mac, 'aa:bb:cc:dd:ee:ff');
    assert.notStrictEqual(adopted.mac, before.mac);
  } finally {
    helper.server.close();
    api.server.close();
  }
});

test('helperFetch: a wrong code is refused by the helper and never reaches the Muse API', async () => {
  const helperState = { requests: [], consumed: false };
  const apiState = { requests: [] };
  const helper = await startServer(helperHandler(helperState, GOOD_PAYLOAD));
  const api = await startServer(apiHandler(apiState, true));
  try {
    const storage = memoryStorage();
    const before = MG.identity.loadOrCreate(storage);
    const deps = loginDeps(storage, { apiRoot: () => api.base });
    const helperAddress = helper.base.replace('http://', '');
    await assert.rejects(
      webLogin.loginFromHelper(deps, helperAddress, '999999'),
      /refused that code/);
    assert.strictEqual(helperState.consumed, false); // the transfer survives
    assert.strictEqual(apiState.requests.length, 0);
    assert.strictEqual(deps.store.getPairing(), null);
    assert.strictEqual(MG.identity.loadOrCreate(storage).mac, before.mac);
    // And the right code still works afterwards.
    const result = await webLogin.loginFromHelper(deps, helperAddress, CODE);
    assert.strictEqual(result.nodeId, 'homelink-ddeeff');
  } finally {
    helper.server.close();
    api.server.close();
  }
});

test('helperFetch: a payload that is not the pairing is rejected and saves nothing', async () => {
  const badPayloads = [
    '{"identity": 42, "pairing": "..."}',                 // wrong shapes
    '{"identity": "{\\"mac\\": \\"AA:BB:CC:DD:EE:FF\\"}"}', // pairing field absent
    'this is not json',
    JSON.stringify({ // well-formed envelope, but the pairing file is bad
      identity: IDENTITY_JSON,
      pairing: '{"refresh_token": "dev-refresh-1"}',
    }),
  ];
  for (const payload of badPayloads) {
    const helperState = { requests: [], consumed: false };
    const apiState = { requests: [] };
    const helper = await startServer(helperHandler(helperState, payload));
    const api = await startServer(apiHandler(apiState, true));
    try {
      const storage = memoryStorage();
      const before = MG.identity.loadOrCreate(storage);
      const deps = loginDeps(storage, { apiRoot: () => api.base });
      await assert.rejects(
        webLogin.loginFromHelper(deps, helper.base.replace('http://', ''), CODE),
        Error);
      assert.strictEqual(deps.store.getPairing(), null, 'payload: ' + payload);
      assert.strictEqual(MG.identity.loadOrCreate(storage).mac, before.mac);
      assert.strictEqual(apiState.requests.length, 0, 'payload: ' + payload);
    } finally {
      helper.server.close();
      api.server.close();
    }
  }
});

test('helperFetch: credentials the API leases no VM to save nothing, even fetched cleanly', async () => {
  const helperState = { requests: [], consumed: false };
  const apiState = { requests: [] };
  const helper = await startServer(helperHandler(helperState, GOOD_PAYLOAD));
  const api = await startServer(apiHandler(apiState, false)); // leases nothing
  try {
    const storage = memoryStorage();
    const before = MG.identity.loadOrCreate(storage);
    const deps = loginDeps(storage, { apiRoot: () => api.base });
    await assert.rejects(
      webLogin.loginFromHelper(deps, helper.base.replace('http://', ''), CODE),
      (err) => err && err.status === 'auth_failed');
    assert.strictEqual(deps.store.getPairing(), null);
    assert.strictEqual(MG.identity.loadOrCreate(storage).mac, before.mac);
  } finally {
    helper.server.close();
    api.server.close();
  }
});
