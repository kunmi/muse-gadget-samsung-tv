'use strict';
/*
 * Web login (pairing transfer): parsing of the SDK state files
 * (identity.json / pairing.json) exactly as the community PSP port's
 * tools/pair.py validates them, the verify-before-save gate borrowed from
 * the SDK's pair.py, and identity adoption — the transferred tokens must
 * end up registered to the node id they were issued to. The login's device
 * API traffic runs against a local mock server; nothing leaves the machine.
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

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function loginDeps(storage, overrides) {
  const store = new MG.store.Store(storage);
  return Object.assign({
    fetchVms: MG.museApi.fetchVms,
    apiRoot: MG.museApi.apiRoot,
    store,
    sdkToken: null,
    nowSeconds: () => 1800000000,
    adoptIdentity: (mac) => MG.identity.adoptMac(storage, mac),
  }, overrides || {});
}

test('webLogin: parses the SDK state files (pair.py shapes)', () => {
  const transfer = webLogin.parseTransfer(IDENTITY_JSON, PAIRING_JSON);
  assert.strictEqual(transfer.mac, 'aa:bb:cc:dd:ee:ff'); // lowercased
  assert.strictEqual(webLogin.nodeIdForMac(transfer.mac), 'homelink-ddeeff');
  assert.deepStrictEqual(transfer.credentials, {
    access_token: 'dev-access-1',
    refresh_token: 'dev-refresh-1',
    username: 'someone',
    api_url: '',
    api_url_v2: '',
    noise_host: 'hatch.metaaivm.com',
  });
});

test('webLogin: parse errors name the file and the problem, like pair.py', () => {
  assert.throws(() => webLogin.parseIdentityJson('{nope'), /identity\.json is not valid JSON/);
  assert.throws(() => webLogin.parseIdentityJson('[1]'), /identity\.json does not hold a JSON object/);
  assert.throws(() => webLogin.parseIdentityJson('{}'), /identity\.json has no usable "mac"/);
  assert.throws(() => webLogin.parseIdentityJson('{"mac": "nope"}'), /identity\.json has no usable "mac"/);
  assert.throws(() => webLogin.parseIdentityJson('{"mac": "aa:bb:cc:dd:ee"}'), /identity\.json has no usable "mac"/);
  assert.throws(() => webLogin.parsePairingJson('nope'), /pairing\.json is not valid JSON/);
  assert.throws(() => webLogin.parsePairingJson('{"refresh_token": "r"}'),
    /pairing\.json is missing: access_token/);
  assert.throws(() => webLogin.parsePairingJson('{}'),
    /pairing\.json is missing: access_token, refresh_token/);
  assert.throws(() => webLogin.parsePairingJson('{"access_token": "", "refresh_token": "r"}'),
    /pairing\.json is missing: access_token/);
});

test('webLogin: login verifies with the transferred token, saves the SDK record, adopts the identity', async () => {
  const seen = [];
  const { server, base } = await startServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      vm_list: [{ vm_ws_url: 'wss://vm', vm_auth_token: 'tok', vm_name: 'vm', vm_id: '1', default: true }],
    }));
  });
  try {
    const storage = memoryStorage();
    const before = MG.identity.loadOrCreate(storage); // the TV's own identity
    const deps = loginDeps(storage, { apiRoot: () => base });
    const result = await webLogin.login(deps, IDENTITY_JSON, PAIRING_JSON);
    assert.strictEqual(result.nodeId, 'homelink-ddeeff');
    assert.strictEqual(result.mac, 'aa:bb:cc:dd:ee:ff');

    // The gate ran against the mock device API with the transferred token.
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'GET');
    assert.strictEqual(seen[0].url, '/fetch_vms');
    assert.strictEqual(seen[0].headers.authorization, 'Bearer dev-access-1');

    // The saved record is the SDK's pairing record shape.
    const saved = deps.store.getPairing();
    assert.deepStrictEqual(saved, {
      access_token: 'dev-access-1',
      refresh_token: 'dev-refresh-1',
      token_type: 'device',
      username: 'someone',
      api_url: '',
      api_url_v2: '',
      noise_host: 'hatch.metaaivm.com',
      access_token_saved_at: 1800000000,
      sdk_token_hint: 'none',
    });

    // The identity was adopted: the TV now loads as the pairing's device,
    // no longer as its own previous identity.
    const adopted = MG.identity.loadOrCreate(storage);
    assert.strictEqual(adopted.mac, 'aa:bb:cc:dd:ee:ff');
    assert.strictEqual(adopted.nodeId, 'homelink-ddeeff');
    assert.notStrictEqual(adopted.mac, before.mac);
    assert.strictEqual(storage.getItem(MG.identity.STORAGE_KEY), '{"mac":"aa:bb:cc:dd:ee:ff"}');
  } finally {
    server.close();
  }
});

test('webLogin: a transfer the API leases no VM to saves nothing and adopts nothing', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ vm_list: [] }));
  });
  try {
    const storage = memoryStorage();
    const before = MG.identity.loadOrCreate(storage);
    const deps = loginDeps(storage, { apiRoot: () => base });
    await assert.rejects(
      webLogin.login(deps, IDENTITY_JSON, PAIRING_JSON),
      (err) => err && err.status === 'auth_failed'
    );
    assert.strictEqual(deps.store.getPairing(), null);
    assert.strictEqual(MG.identity.loadOrCreate(storage).mac, before.mac);
  } finally {
    server.close();
  }
});

test('webLogin: a 401 from the device API also saves nothing', async () => {
  const { server, base } = await startServer((req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    const storage = memoryStorage();
    const before = MG.identity.loadOrCreate(storage);
    const deps = loginDeps(storage, { apiRoot: () => base });
    await assert.rejects(
      webLogin.login(deps, IDENTITY_JSON, PAIRING_JSON),
      (err) => err && err.status === 'auth_failed'
    );
    assert.strictEqual(deps.store.getPairing(), null);
    assert.strictEqual(MG.identity.loadOrCreate(storage).mac, before.mac);
  } finally {
    server.close();
  }
});

test('webLogin: after adoption, token rotation presents the adopted node id', async () => {
  // The whole point of the transfer: service.js refreshes with
  // identity.nodeId, so the adopted identity must be the one the refresh
  // body names. Drive the real refresh client the way the service does.
  const seen = [];
  const { server, base } = await startServer(async (req, res) => {
    if (req.url === '/fetch_vms') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        vm_list: [{ vm_ws_url: 'wss://vm', vm_auth_token: 'tok', vm_name: 'vm', vm_id: '1', default: true }],
      }));
      return;
    }
    seen.push({ url: req.url, headers: req.headers, body: await readBody(req) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'dev-access-2', refresh_token: 'dev-refresh-2' }));
  });
  try {
    const storage = memoryStorage();
    const deps = loginDeps(storage, { apiRoot: () => base });
    await webLogin.login(deps, IDENTITY_JSON, PAIRING_JSON);
    const adopted = MG.identity.loadOrCreate(storage);
    const pairing = deps.store.getPairing();
    const { tokens, status } = await MG.museApi.refreshDeviceToken(
      pairing.refresh_token, adopted.nodeId, base, null);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(tokens, { access_token: 'dev-access-2', refresh_token: 'dev-refresh-2' });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, '/device_token/refresh');
    assert.strictEqual(seen[0].headers.authorization, 'Bearer hatch_refresh:dev-refresh-1');
    assert.deepStrictEqual(JSON.parse(seen[0].body), { device_id: 'homelink-ddeeff' });
  } finally {
    server.close();
  }
});
