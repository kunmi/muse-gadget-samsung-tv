'use strict';
/*
 * Pairing v5 verification, in two parts:
 *
 *  1. The SDK's published vectors (tests/fixtures/link_pairing_v5.json,
 *     copied from the SDK's linux/tests/vectors/): transcript, transcript
 *     hash, ECDH secret, session keys, session id and the encrypted
 *     client-finished record must match byte-for-byte.
 *
 *  2. A full simulated pairing: a fake phone (implemented with the same
 *     public primitives a real app would use) drives the JS SetupController
 *     through get_device_info -> hello -> client_finished -> wifi_scan ->
 *     provision_v2, and checks every status and the saved pairing record.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadModules, test, memoryStorage } = require('./helpers');

const MG = loadModules();
const u = MG.util;
const crypto = MG.crypto;
const p256 = MG.p256;
const pairing = MG.pairing;

const vectorsDoc = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'link_pairing_v5.json'), 'utf8'));

test('pairing vectors: transcript, keys and client_finished match the SDK fixtures', () => {
  assert.ok(vectorsDoc.vectors.length >= 2, 'expected at least the community and official vectors');
  for (const v of vectorsDoc.vectors) {
    const transcript = pairing.buildTranscript({
      community: v.community,
      authEpoch: v.pairing_auth_epoch,
      policy: v.pairing_policy,
      deviceId: v.device_id,
      nodeId: v.node_id,
      mac: v.mac,
      firmwareVersion: v.firmware_version,
      mobilePub: v.mobile_pub,
      devicePub: v.device_pub,
      mobileNonce: v.mobile_nonce,
      deviceNonce: v.device_nonce,
    });
    assert.strictEqual(transcript, v.transcript, v.name + ' transcript');
    const transcriptHash = crypto.sha256(u.utf8Encode(transcript));
    assert.strictEqual(u.b64urlEncode(transcriptHash), v.transcript_hash, v.name + ' transcript_hash');

    const deviceScalar = p256.bytesToBigInt(u.fromHex(v.device_private_scalar_hex));
    const mobilePub = u.b64urlDecode(v.mobile_pub);
    assert.strictEqual(u.b64urlEncode(p256.publicKeyFromPrivate(deviceScalar)), v.device_pub, v.name + ' device_pub');
    const secret = p256.ecdh(deviceScalar, mobilePub);
    assert.strictEqual(u.toHex(secret), v.ecdh_secret_hex, v.name + ' ecdh');

    const keys = pairing.deriveSessionKeys(
      secret, u.b64urlDecode(v.mobile_nonce), u.b64urlDecode(v.device_nonce), transcriptHash);
    assert.strictEqual(u.toHex(keys.sessionSecret), v.session_secret_hex, v.name + ' session_secret');
    assert.strictEqual(u.toHex(keys.mobileTxKey), v.mobile_tx_key_hex, v.name + ' mobile_tx_key');
    assert.strictEqual(u.toHex(keys.mobileRxKey), v.mobile_rx_key_hex, v.name + ' mobile_rx_key');
    assert.strictEqual(u.b64urlEncode(keys.sessionId), v.session_id, v.name + ' session_id');

    // The client-finished record: encrypted by the phone with mobile_tx,
    // counter 0, direction to-device.
    const sealed = crypto.aesGcmEncrypt(
      keys.mobileTxKey,
      pairing.recordNonce(0, 0),
      u.utf8Encode(v.client_finished_plaintext),
      u.utf8Encode(v.client_finished_aad));
    assert.strictEqual(
      u.b64urlEncode(sealed.subarray(0, sealed.length - 16)), v.client_finished_ciphertext,
      v.name + ' client_finished ciphertext');
    assert.strictEqual(
      u.b64urlEncode(sealed.subarray(sealed.length - 16)), v.client_finished_tag,
      v.name + ' client_finished tag');
    // And the device side can open it.
    const opened = crypto.aesGcmDecrypt(
      keys.mobileTxKey,
      pairing.recordNonce(0, 0),
      u.concatBytes(u.b64urlDecode(v.client_finished_ciphertext, 16384), u.b64urlDecode(v.client_finished_tag)),
      u.utf8Encode(v.client_finished_aad));
    assert.strictEqual(u.utf8Decode(opened), v.client_finished_plaintext);
  }
});

test('pairing: BLE chunk framing round trip at the default MTU', () => {
  const data = u.utf8Encode(JSON.stringify({ action: 'get_device_info', pad: 'x'.repeat(300) }));
  const packets = pairing.encodeChunks(data); // default ATT MTU 23 -> 17 payload bytes/packet
  assert.ok(packets.length > 10);
  for (const p of packets) assert.ok(p.length <= 20, 'packet exceeds MTU payload');
  const assembler = new pairing.ChunkAssembler();
  let out = null;
  for (const p of packets) {
    const res = assembler.feed(p);
    if (res) out = res;
  }
  assert.ok(out && u.bytesEqual(out, data));
  // An unchunked packet is a complete message.
  const plain = u.utf8Encode('error_encryption_required');
  assert.ok(u.bytesEqual(assembler.feed(plain), plain));
  // Out-of-order chunk drops the partial message.
  const two = pairing.encodeChunks(u.utf8Encode('y'.repeat(40)));
  const a2 = new pairing.ChunkAssembler();
  assert.strictEqual(a2.feed(two[1]), null);
});

/* ---------- simulated phone ---------- */

function makePhone(device) {
  // device: {nodeId, deviceId, mac, firmwareVersion} for the transcript.
  const scalar = p256.generatePrivateScalar();
  const pub = p256.publicKeyFromPrivate(scalar);
  const nonce = u.randomBytes(16);
  return {
    helloMessage() {
      return {
        action: 'pairing_client_hello',
        version: 5,
        pairing_auth: 'none',
        pairing_policy: 'confirm_app',
        mobile_pub: u.b64urlEncode(pub),
        mobile_nonce: u.b64urlEncode(nonce),
      };
    },
    acceptReady(ready) {
      const transcript = pairing.buildTranscript({
        community: true, authEpoch: 0, policy: 'confirm_app',
        deviceId: device.deviceId, nodeId: device.nodeId, mac: device.mac,
        firmwareVersion: device.firmwareVersion,
        mobilePub: u.b64urlEncode(pub), devicePub: ready.device_pub,
        mobileNonce: u.b64urlEncode(nonce), deviceNonce: ready.device_nonce,
      });
      const hash = crypto.sha256(u.utf8Encode(transcript));
      assert.strictEqual(u.b64urlEncode(hash), ready.transcript_hash);
      const secret = p256.ecdh(scalar, u.b64urlDecode(ready.device_pub));
      this.keys = pairing.deriveSessionKeys(
        secret, nonce, u.b64urlDecode(ready.device_nonce), hash);
      assert.strictEqual(u.b64urlEncode(this.keys.sessionId), ready.session_id);
      this.sessionId = ready.session_id;
      this.txCounter = 0;
      this.rxCounter = 0;
    },
    encrypt(objOrText) {
      const text = typeof objOrText === 'string' ? objOrText : JSON.stringify(objOrText);
      const sealed = crypto.aesGcmEncrypt(
        this.keys.mobileTxKey,
        pairing.recordNonce(0, this.txCounter),
        u.utf8Encode(text),
        pairing.recordAad(this.sessionId, 0, this.txCounter));
      const env = {
        action: 'pairing_encrypted',
        type: 'pairing_encrypted',
        session_id: this.sessionId,
        counter: String(this.txCounter),
        ciphertext: u.b64urlEncode(sealed.subarray(0, sealed.length - 16)),
        tag: u.b64urlEncode(sealed.subarray(sealed.length - 16)),
      };
      this.txCounter++;
      return env;
    },
    decrypt(envelope) {
      assert.strictEqual(envelope.type, 'pairing_encrypted');
      assert.strictEqual(envelope.session_id, this.sessionId);
      const counter = Number(envelope.counter);
      assert.strictEqual(counter, this.rxCounter);
      const plain = crypto.aesGcmDecrypt(
        this.keys.mobileRxKey,
        pairing.recordNonce(1, counter),
        u.concatBytes(u.b64urlDecode(envelope.ciphertext, 16384), u.b64urlDecode(envelope.tag)),
        pairing.recordAad(this.sessionId, 1, counter));
      this.rxCounter++;
      return JSON.parse(u.utf8Decode(plain));
    },
  };
}

function waitFor(condition, what) {
  const deadline = Date.now() + 4000;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + what));
      setTimeout(poll, 5);
    })();
  });
}

test('pairing: full simulated setup flow saves a verified pairing record', async () => {
  const storage = memoryStorage();
  const store = new MG.store.Store(storage);
  const sdkToken = 'mgst_' + 'A'.repeat(43);
  const identityLike = {
    nodeId: 'homelink-00aa11',
    deviceId: 'hatch-link:02:00:00:00:aa:11',
    mac: '02:00:00:00:aa:11',
    firmwareVersion: '0.1.0',
  };
  const session = new pairing.PairingSession({
    nodeId: identityLike.nodeId,
    deviceId: identityLike.deviceId,
    mac: identityLike.mac,
    firmwareVersion: '0.1.0',
    sdkToken,
  });

  const sentPackets = [];
  const transport = {
    sendPackets(packets) { sentPackets.push(...packets); },
    mtu() { return 247; },
    disconnect() { this.disconnected = true; },
  };
  const network = {
    isOnline() { return true; },
    currentConnectionEntry() { return { ssid: 'HomeNet', rssi: -40, secure: false }; },
  };
  let completed = false;
  const controller = new pairing.SetupController({
    pairing: session,
    identity: identityLike,
    version: '0.1.0',
    transport,
    network,
    provision(credentials, commit) {
      return pairing.verifyAndSaveProvisioning(credentials, commit, {
        fetchVms: () => Promise.resolve({
          vms: [{ vm_url: 'wss://vm', vm_auth_token: 't', vm_name: 'vm', vm_id: '1', is_default: true }],
          status: 200,
        }),
        apiRoot: MG.museApi.apiRoot,
        store,
        sdkToken,
        nowSeconds: () => 1700000000,
      });
    },
    onComplete() { completed = true; },
  });

  const phoneInbox = new pairing.ChunkAssembler();
  const phoneMessages = [];
  let phoneCursor = 0;
  function drainPhone() {
    while (sentPackets.length) {
      const msg = phoneInbox.feed(sentPackets.shift());
      if (msg) phoneMessages.push(JSON.parse(u.utf8Decode(msg)));
    }
  }
  async function nextPhoneMessage(what) {
    await waitFor(() => { drainPhone(); return phoneMessages.length > phoneCursor; }, what);
    return phoneMessages[phoneCursor++];
  }
  function phoneSends(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const packet of pairing.encodeChunks(u.utf8Encode(text), 247)) {
      controller.onWrite(packet);
    }
  }

  // get_device_info in plaintext, answered at any time.
  phoneSends({ action: 'get_device_info' });
  const info = await nextPhoneMessage('device_info');
  assert.strictEqual(info.type, 'device_info');
  assert.strictEqual(info.model, 'hatch_link');
  assert.strictEqual(info.node_id, 'homelink-00aa11');
  assert.strictEqual(info.pairing_policy, 'confirm_app');
  assert.strictEqual(info.network_ready, true);

  // A sensitive action in plaintext is refused in plaintext.
  phoneSends({ action: 'provision_v2' });
  await waitFor(() => sentPackets.length > 0, 'encryption-required status');
  const rawStatus = sentPackets.shift();
  assert.strictEqual(u.utf8Decode(rawStatus), 'error_encryption_required');

  // Hello -> pairing_ready; the phone derives the same session.
  const phone = makePhone(identityLike);
  phoneSends(phone.helloMessage());
  const ready = await nextPhoneMessage('pairing_ready');
  assert.strictEqual(ready.type, 'pairing_ready');
  phone.acceptReady(ready);

  // client_finished (encrypted) -> pairing_confirmed carrying the SDK token.
  phoneSends(phone.encrypt({ action: 'pairing_client_finished' }));
  const confirmedEnv = await nextPhoneMessage('pairing_confirmed');
  const confirmed = phone.decrypt(confirmedEnv);
  assert.deepStrictEqual(confirmed, { type: 'status', status: 'pairing_confirmed', sdk_token: sdkToken });

  // wifi_scan (encrypted) -> one network, the current connection.
  phoneSends(phone.encrypt({ action: 'wifi_scan' }));
  const scanEnv = await nextPhoneMessage('wifi_scan_result');
  const scan = phone.decrypt(scanEnv);
  assert.deepStrictEqual(scan, {
    type: 'wifi_scan_result',
    networks: [{ ssid: 'HomeNet', rssi: -40, secure: false }],
  });

  // provision_v2 (encrypted) -> wifi_connecting, wifi_connected, auth_ok.
  phoneSends(phone.encrypt({
    action: 'provision_v2',
    ssid: 'HomeNet',
    password: 'secret',
    access_token: 'access-123',
    refresh_token: 'refresh-456',
    token_type: 'device',
    username: 'kunmi',
    api_url: '',
    api_url_v2: '',
    noise_host: '',
  }));
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const env = await nextPhoneMessage('provision status ' + i);
    statuses.push(phone.decrypt(env).status);
  }
  assert.deepStrictEqual(statuses, ['wifi_connecting', 'wifi_connected', 'auth_ok']);
  assert.ok(completed, 'onComplete should have fired');

  const record = store.getPairing();
  assert.ok(record, 'pairing record saved');
  assert.strictEqual(record.access_token, 'access-123');
  assert.strictEqual(record.refresh_token, 'refresh-456');
  assert.strictEqual(record.token_type, 'device');
  assert.strictEqual(record.username, 'kunmi');
  assert.strictEqual(record.sdk_token_hint, 'mgst_AAAAAAA');
  assert.strictEqual(record.access_token_saved_at, 1700000000);
});

test('pairing: a bad client_finished record kills the session', async () => {
  const identityLike = { nodeId: 'homelink-00bb22', deviceId: 'hatch-link:02:00:00:00:bb:22', mac: '02:00:00:00:bb:22', firmwareVersion: '0.1.0' };
  const session = new pairing.PairingSession({
    nodeId: identityLike.nodeId, deviceId: identityLike.deviceId, mac: identityLike.mac,
    firmwareVersion: '0.1.0', sdkToken: null,
  });
  const phone = makePhone(identityLike);
  const ready = session.handleHello(phone.helloMessage());
  phone.acceptReady(ready);
  // Wrong action inside the first record: the session must not confirm.
  const text = session.decrypt(phone.encrypt({ action: 'wifi_scan' }));
  assert.strictEqual(JSON.parse(text).action, 'wifi_scan');
  const generation = session.handleClientFinished(JSON.parse(text));
  assert.strictEqual(generation, 0);
  assert.strictEqual(session.state, 'idle');
  assert.strictEqual(session.confirmed, false);
});

test('pairing: invalid hello is refused with error_pairing_invalid_hello', () => {
  const session = new pairing.PairingSession({
    nodeId: 'homelink-00cc33', deviceId: 'hatch-link:02:00:00:00:cc:33', mac: '02:00:00:00:cc:33',
    firmwareVersion: '0.1.0', sdkToken: null,
  });
  assert.throws(
    () => session.handleHello({ version: 4, pairing_auth: 'none', pairing_policy: 'confirm_app' }),
    (err) => err.status === 'error_pairing_invalid_hello');
  assert.throws(
    () => session.handleHello({ version: 5, pairing_auth: 'fleet_ecdsa_p256_v1', pairing_policy: 'confirm_app' }),
    (err) => err.status === 'error_pairing_invalid_hello');
});
