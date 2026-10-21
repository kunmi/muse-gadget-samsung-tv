'use strict';
/*
 * End-to-end interop: the JS LinkSession talks to Meta's Muse Gadget SDK
 * Python implementation (tests/interop-vm.py, modelled on the SDK's own
 * FakeVm in tests/test_link_client.py) over a pipe that stands in for the
 * WebSocket. This exercises the real SDK Noise responder, transport
 * decryption and control-stream handling against the JS client byte-for-byte
 * — the strongest verification available without a live Muse VM.
 *
 * Skips cleanly when the SDK checkout or Python `cryptography` is missing.
 */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadModules, test } = require('./helpers');

const MG = loadModules();

function findPython() {
  const candidates = [
    process.env.MUSE_GADGET_PYTHON,
    '/tmp/mgvenv/bin/python',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import cryptography'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function sdkAvailable() {
  const src = process.env.MUSE_GADGET_SDK_LINUX_SRC ||
    path.join(__dirname, '..', '..', 'muse-gadget-sdk-ref', 'linux', 'src');
  return fs.existsSync(path.join(src, 'musegadget', 'link_client.py'));
}

class FakeWs {
  constructor() {
    this.handlers = { open: [], message: [], close: [], error: [] };
    this.binaryType = 'blob';
    this.sent = [];
    setTimeout(() => this._emit('open', {}), 0);
  }
  addEventListener(type, fn) { this.handlers[type].push(fn); }
  removeEventListener(type, fn) {
    this.handlers[type] = this.handlers[type].filter((f) => f !== fn);
  }
  _emit(type, event) { for (const fn of [...this.handlers[type]]) fn(event); }
  send(data) { this.sent.push(Buffer.from(data).toString('hex')); }
  deliver(bytes) {
    const buf = Buffer.from(bytes);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    this._emit('message', { data: ab });
  }
  close() { this._emit('close', {}); }
}

test('interop: JS link session against the SDK Python implementation', async () => {
  const python = findPython();
  if (!python) return { skipped: 'no Python with the cryptography package found' };
  if (!sdkAvailable()) return { skipped: 'muse-gadget-sdk-ref checkout not found next to the repo' };

  const child = spawn(python, [path.join(__dirname, 'interop-vm.py')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  const waiters = [];
  function onEvent(evt) {
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(evt)) {
        waiters[i].resolve(evt);
        waiters.splice(i, 1);
      }
    }
  }
  function waitEvent(pred, what) {
    const existing = events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + what)), 15000);
      waiters.push({ pred, resolve: (e) => { clearTimeout(timer); resolve(e); } });
    });
  }

  const ws = new FakeWs();
  const originalSend = ws.send.bind(ws);
  ws.send = (data) => {
    child.stdin.write(Buffer.from(data).toString('hex') + '\n');
    originalSend(data);
  };
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (line.startsWith('EVT ')) onEvent(JSON.parse(line.slice(4)));
    else if (/^[0-9a-f]+$/.test(line)) ws.deliver(Buffer.from(line, 'hex'));
  });

  const calls = [];
  const connectLog = [];
  const device = new MG.linkSession.DeviceDescription({
    nodeId: 'homelink-abcdef',
    displayName: 'MuseGadgetTVABCDEF',
    version: '0.1.0',
    commands: MG.executor.COMMAND_SPECS,
  });
  const session = new MG.linkSession.LinkSession({
    noiseHost: 'gw.example',
    vmId: 'vm 1&x',
    vmAuthToken: 'test-vm-token',
    device,
    runCommand(command, params, timeoutMs) {
      calls.push([command, params, timeoutMs]);
      return { ok: true, payload: { stdout: 'hi\n', exit_code: 0 } };
    },
    wsFactory(url, headers) {
      connectLog.push([url, headers]);
      return ws;
    },
    log() {},
  });

  try {
    const outcomePromise = session.run();

    // URL is escaped exactly like encodeURIComponent (the SDK test asserts
    // the same string for the Python client).
    await waitEvent((e) => e.event === 'control_stream', 'control stream');
    assert.strictEqual(connectLog[0][0], 'wss://gw.example/v1/noise?vm_id=vm%201%26x');
    assert.deepStrictEqual(connectLog[0][1], { Authorization: 'Bearer test-vm-token' });

    const register = await waitEvent((e) => e.event === 'register', 'link.register');
    const regMsg = register.message;
    assert.strictEqual(regMsg.type, 'req');
    assert.strictEqual(regMsg.method, 'link.register');
    assert.strictEqual(regMsg.params.node_id, 'homelink-abcdef');
    assert.strictEqual(regMsg.params.display_name, 'MuseGadgetTVABCDEF');
    assert.strictEqual(regMsg.params.platform, 'tizen');
    assert.strictEqual(regMsg.params.device_family, 'homehub');
    assert.strictEqual(regMsg.params.model_id, 'samsung-tv');
    assert.strictEqual(regMsg.params.is_wakeup_supported, false);
    assert.ok(regMsg.params.commands_v2['display.text']);
    assert.ok(!('device.ota' in regMsg.params.commands_v2));
    assert.ok(!('system.run' in regMsg.params.commands_v2));

    await waitEvent(() => session.isRegistered(), 'registration');
    assert.ok(session.isRegistered());

    // VM invokes a command; the reply must be the exact result object.
    child.stdin.write('CMD ' + JSON.stringify({
      send_invoke: {
        method: 'link.invoke', id: 'inv-1', command: 'display.text',
        params: { text: 'hello tv' }, timeout_ms: 5000,
      },
    }) + '\n');
    const result = await waitEvent((e) => e.event === 'link_result', 'link.result');
    assert.deepStrictEqual(result.message, {
      method: 'link.result', id: 'inv-1', ok: true, payload: { stdout: 'hi\n', exit_code: 0 },
    });
    assert.deepStrictEqual(calls, [['display.text', { text: 'hello tv' }, 5000]]);

    // Chat: a device-attributed POST /chat/stream on the same session.
    const chatPromise = session.sendChat('porch light on', 'side-1');
    const chatEvt = await waitEvent((e) => e.event === 'chat_request', 'chat request');
    assert.strictEqual(chatEvt.verb, 'POST');
    assert.strictEqual(chatEvt.path, '/chat/stream');
    assert.strictEqual(chatEvt.end_body, true);
    assert.deepStrictEqual(JSON.parse(chatEvt.body), {
      message: 'porch light on', output_modality: 'text',
      device_id: 'homelink-abcdef', session_id: 'side-1',
    });
    assert.strictEqual(chatEvt.headers['content-type'], 'application/json');
    assert.strictEqual(chatEvt.headers['x-app-id'], 'musegadget');
    assert.ok(chatEvt.headers['x-request-id']);
    const chatResult = await chatPromise;
    assert.deepStrictEqual(chatResult, { ok: true, status: 200, response: { accepted: true } });

    // Unpair ends the session with the UNPAIRED outcome.
    child.stdin.write('CMD ' + JSON.stringify({ send_unpair: true }) + '\n');
    const outcome = await outcomePromise;
    assert.strictEqual(outcome, 'unpaired');
  } finally {
    child.stdin.end();
    child.kill();
  }
});
