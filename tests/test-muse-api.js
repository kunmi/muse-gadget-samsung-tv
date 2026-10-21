'use strict';
/*
 * Device API client against a local mock HTTP server: request shape
 * (headers, paths, bodies) and response parsing, mirroring muse_api.py.
 * No request ever leaves the machine.
 */
const assert = require('assert');
const http = require('http');
const { loadModules, test } = require('./helpers');

const MG = loadModules();
const api = MG.museApi;

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

test('api: fetch_vms request shape and vm_list parsing', async () => {
  const seen = [];
  const { server, base } = await startServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      vm_list: [
        { vm_url: 'https://legacy', vm_ws_url: 'wss://preferred', vm_auth_token: 'tok-a', vm_name: 'vm-a', vm_id: 'id-a', default: true },
        { vm_url: 'wss://plain', vm_auth_token: 'tok-b', vm_name: 'vm-b' },
        { vm_name: 'incomplete' },
        'not-an-object',
      ],
    }));
  });
  try {
    const { vms, status } = await api.fetchVms('device-token-1', base);
    assert.strictEqual(status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].method, 'GET');
    assert.strictEqual(seen[0].url, '/fetch_vms');
    assert.strictEqual(seen[0].headers.authorization, 'Bearer device-token-1');
    assert.strictEqual(seen[0].headers['x-api-version'], '1.0.0');
    assert.ok(/^musegadget\//.test(seen[0].headers['user-agent']), 'User-Agent: ' + seen[0].headers['user-agent']);
    assert.strictEqual(vms.length, 2);
    assert.deepStrictEqual(vms[0], {
      vm_url: 'wss://preferred', // vm_ws_url wins over vm_url, as in the SDK
      vm_auth_token: 'tok-a', vm_name: 'vm-a', vm_id: 'id-a', is_default: true,
    });
    assert.strictEqual(vms[1].vm_url, 'wss://plain');
    assert.strictEqual(vms[1].is_default, false);
  } finally {
    server.close();
  }
});

test('api: fetch_vms error body and 401 surface like the SDK', async () => {
  const errServer = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_title: 'Nope', backend_error_code: 'E1', vm_list: [{ vm_url: 'wss://x', vm_auth_token: 't' }] }));
  });
  try {
    const r = await api.fetchVms('tok', errServer.base);
    assert.deepStrictEqual(r.vms, []);
    assert.strictEqual(r.status, 200);
  } finally {
    errServer.server.close();
  }

  const authServer = await startServer((req, res) => {
    res.writeHead(401);
    res.end('unauthorized');
  });
  try {
    const r = await api.fetchVms('stale-token', authServer.base);
    assert.deepStrictEqual(r.vms, []);
    assert.strictEqual(r.status, 401);
  } finally {
    authServer.server.close();
  }
});

test('api: refresh posts only the refresh token and unwraps payload', async () => {
  const seen = [];
  const { server, base } = await startServer(async (req, res) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ payload: { access_token: 'A2', refresh_token: 'R2' } }));
  });
  try {
    const sdkToken = 'mgst_' + 'B'.repeat(43);
    const { tokens, status } = await api.refreshDeviceToken(
      'hatch_refresh:RAWREFRESH', 'homelink-abcdef', base, sdkToken);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(tokens, { access_token: 'A2', refresh_token: 'R2' });
    assert.strictEqual(seen[0].method, 'POST');
    assert.strictEqual(seen[0].url, '/device_token/refresh');
    // The stored token already carried the prefix; it must not be doubled,
    // and the access token is never presented here.
    assert.strictEqual(seen[0].headers.authorization, 'Bearer hatch_refresh:RAWREFRESH');
    assert.strictEqual(seen[0].headers['content-type'], 'application/json');
    assert.deepStrictEqual(JSON.parse(seen[0].body), {
      device_id: 'homelink-abcdef', sdk_token: sdkToken,
    });
  } finally {
    server.close();
  }
});

test('api: refresh without sdk_token omits it; 401 propagates', async () => {
  const seen = [];
  const { server, base } = await startServer(async (req, res) => {
    seen.push({ headers: req.headers, body: await readBody(req) });
    res.writeHead(401);
    res.end('gone');
  });
  try {
    const { tokens, status } = await api.refreshDeviceToken('PLAINREFRESH', 'homelink-abcdef', base, null);
    assert.strictEqual(tokens, null);
    assert.strictEqual(status, 401);
    assert.strictEqual(seen[0].headers.authorization, 'Bearer hatch_refresh:PLAINREFRESH');
    assert.deepStrictEqual(JSON.parse(seen[0].body), { device_id: 'homelink-abcdef' });
  } finally {
    server.close();
  }
});
