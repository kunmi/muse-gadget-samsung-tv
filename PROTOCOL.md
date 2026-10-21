# Protocol notes — how this app maps to the Muse Gadget SDK

This app is a port of Meta's [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk)
(the `linux/` Python client is the reference; the `esp32/` firmware speaks the same protocols)
to a Samsung Tizen web app. The SDK sources are the specification. This file is
the port map, the message flow, and — most importantly — **every place the TV
app deviates from the SDK or cannot do what the SDK does**, with the reason.

User-facing names follow the SDK's house rule: everything a person reads says
**Muse**. The string `hatch` survives only in wire constants the server and
the Muse app depend on (the default Noise host `hatch.metaaivm.com`, the
`hatch_refresh:` auth prefix, the pairing labels `hatch-link-pairing-v5`, the
`hatch_link` pairing model and the `hatch-link:` device id), exactly as the
SDK's own AGENTS.md prescribes.

## Message flow (as implemented)

```
TV app                                     Muse device API / Muse VM
------                                     -------------------------
localStorage: identity (MAC-shaped id)     derived: homelink-xxxxxx node id
localStorage: SDK token (mgst_...)
localStorage: pairing record               {access_token, refresh_token, ...}

GET  https://api.muse.ai/fetch_vms         Authorization: Bearer <access token>
                                           X-API-Version: 1.0.0
  -> pick default VM (else first)

wss://<noise_host>/v1/noise?vm_id=<id>     (default host hatch.metaaivm.com)
  -> Noise XX handshake (initiator)        msg1 32 B, msg2 >= 96 B, msg3 64 B
  -> POST /link-control stream (open)      ServiceRequest/ServiceFrame protobufs,
                                           Noise-encrypted, chunked at 65,489 B
  -> link.register  {type:"req", id, method, params:{node_id, display_name,
                     platform:"tizen", version, device_family:"homehub",
                     model_id:"samsung-tv", is_wakeup_supported:false,
                     commands_v2:{...}}}
     (control messages are JSON, each prefixed with a little-endian u32 length)
  <- register reply {id, ok:true}          (error / ok:false -> session forbidden)
  <- link.invoke {method, id, command, params, timeout_ms}
  -> link.result {method, id, ok, payload|error}   (max 4 concurrent)
  <- event link.unpaired / node.unpaired   -> pairing record deleted, back to setup
  -> POST /chat/stream (same session)      {"message", "output_modality":"text",
                                            "device_id": <node id>, "session_id"?}
                                           headers x-request-id, x-app-id: musegadget

POST https://api.muse.ai/device_token/refresh
     Authorization: Bearer hatch_refresh:<refresh token after the last ":">
     body {"device_id": <node id>, "sdk_token": <mgst_...> if set}
     (the access token is NEVER presented; 401 = pairing revoked;
      tokens rotate at 3 h of age, they live ~4 h)
```

Reconnect behaviour mirrors `service.py`: backoff 2 s doubling to a 60 s
ceiling, a 15 s floor after auth outcomes, backoff reset after a session that
stayed registered ≥ 30 s, re-register after every reconnect.

## Port map

| TV app module (`app/js/`) | SDK source it follows |
|---|---|
| `muse-api.js` | `linux/src/musegadget/muse_api.py` (fetch_vms, token refresh) |
| `identity.js` | `linux/src/musegadget/identity.py` |
| `store.js` | `linux/src/musegadget/config.py` (token shape, pairing record, hint) |
| `crypto.js` | primitives for `noise/noise_xx.py` + `pairing.py` (SHA-256, HMAC, HKDF, X25519, AES-256-GCM) |
| `p256.js` | the P-256 ECDH used by `pairing.py` |
| `proto.js` | `linux/src/musegadget/noise/_proto.py` |
| `noise.js` | `linux/src/musegadget/noise/noise_xx.py` |
| `envelope.js` | `linux/src/musegadget/noise/envelope.py` |
| `framing.js` | `linux/src/musegadget/noise/framing.py` |
| `transport.js` | `linux/src/musegadget/noise/transport.py` |
| `control-framing.js` | `encode_message` / `MessageDecoder` in `link_client.py` |
| `link-session.js` | `linux/src/musegadget/link_client.py` (LinkSession) |
| `service.js` | `linux/src/musegadget/service.py` (reconnect loop, rotation) |
| `executor.js` | `linux/src/musegadget/executor.py` (spec format + result shape; TV command set) |
| `pairing.js` | `pairing.py` + `ble_setup.py` + `ble_framing.py` + `pair.py` (verify-and-save); GATT UUIDs from `ble_server.py` |
| `tv.js` | Samsung Tizen web APIs (no SDK counterpart; the inverse of the SDK's `skills/gadget-samsung-tizen-tvs` host-side skill) |
| `app.js` | UI only (no SDK counterpart) |

## Deviations and gaps — read this before trusting the app

### 1. Pairing cannot be completed on the TV (the big one)

What pairing does in the SDK:

1. The gadget advertises a BLE GATT service
   (`7fdd3d1c-38ea-46cf-8b46-314ecf5f240c`; RX write characteristic
   `4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01`, TX notify characteristic
   `d75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c`) under the name `MuseGadgetXXXXXX`
   for a 10-minute setup window.
2. The Muse app connects, reads `device_info`, and runs **pairing v5**:
   P-256 ECDH + HKDF-SHA256 session keys over a canonical transcript, then
   AES-256-GCM-sealed records. The first sealed record
   (`pairing_client_finished`) confirms the session (community mode:
   `pairing_auth: "none"`, policy `confirm_app`); the device answers with a
   sealed `pairing_confirmed` status that carries its SDK token.
3. The app then sends a sealed `provision_v2`: Wi-Fi fields (ignored — the
   gadget is already online) and the **device credentials the backend minted
   for this gadget**: `access_token`, `refresh_token`, `token_type: "device"`,
   plus `username`, `api_url`, `api_url_v2`, `noise_host`.
4. The gadget verifies the credentials with `fetch_vms` (must return at
   least one VM) and only then saves the pairing record
   (`wifi_connecting → wifi_connected → auth_ok` statuses on the way).

The SDK token (`mgst_…`) is **not** a device credential: it never authorises
`fetch_vms`. It identifies the developer account the gadget belongs to; the
backend records it when pairing completes, and the gadget optionally presents
it again on token refresh.

Why the TV can't do step 1–3: **a Tizen web app has no BLE GATT server.**
Samsung's Tizen web Bluetooth API (`tizen.bluetooth`) is central-mode only —
a web app can scan and connect to peripherals, but it cannot advertise a
service, expose characteristics, or accept the Muse app's writes. Without
advertising, the Muse app never sees the TV, so the v5 handshake and
`provision_v2` can never reach it. This is a platform limit of the web
runtime, not something more code in the `.wgt` can fix.

What the TV app does instead:

- `pairing.js` implements the **complete device side of pairing v5** —
  transcript, key schedule, record encryption, the `SetupController`
  dispatch, BLE chunk framing, and verify-and-save provisioning — behind a
  transport interface shaped exactly like the SDK's. It is verified
  byte-for-byte against the SDK's published pairing vectors, and a simulated
  phone in the test suite drives the full flow to a saved pairing record.
  If a future shell (native wrapper, different runtime) ever provides a GATT
  server transport, the pairing code is ready to run over it unchanged.
- For real provisioning today, the setup screen offers **credential
  import**: the user pastes a device access/refresh token pair that a
  completed SDK pairing issued, and the app runs `pair.py`'s exact
  verify-and-save step (`fetch_vms` must return a VM) before storing
  anything. Nothing is stored on failure, and the app never shows a paired
  state it did not verify.
- The SDK token is still collected in onboarding and used exactly as the SDK
  uses it: recorded as the pairing's hint and sent on token refresh.

What remains for the user: obtaining the device credential pair currently
means completing one SDK pairing (e.g. the Linux gadget on a Pi) with the
same Muse account and copying the pair from its `pairing.json`. That is
clunky and is stated plainly in the UI and README.

### 2. The WebSocket upgrade cannot carry the Authorization header

The SDK opens `wss://<host>/v1/noise?vm_id=…` with
`Authorization: Bearer <vm_auth_token>` as an upgrade header, and maps a
401/403 upgrade response to “re-fetch VM credentials / forbidden”. Browsers —
including Tizen's Chromium — **cannot set headers on a WebSocket upgrade and
cannot read the upgrade's HTTP status**. The app therefore connects without
the header; a connection that dies during the handshake is reported as
AUTH_REJECTED (the closest observable equivalent), and a close at any later
point is a normal reconnect. Whether the production edge accepts an
unauthenticated upgrade (relying on the Noise handshake + per-frame
routing) is **unverified** — it needs a paired account and a TV to test, and
neither exists in the development environment. If the edge requires the
header, the TV build will need a server-side accommodation (for example the
token as a subprotocol or query parameter); the session code isolates this
in one factory function (`wsFactory`) so the change stays small.

### 3. Browser-forbidden headers

`fetch`/`XMLHttpRequest` in a web runtime forbid setting `User-Agent`, so on
the TV the device API requests carry the runtime's own agent string instead
of `musegadget/<version> (… )`. The client sets it wherever the platform
allows (the Node test suite asserts it). No other header is affected.

### 4. Registration values are the TV adaptation

`link.register` keeps the SDK's shape and `device_family: "homehub"`, and
never advertises `device.ota` (the server pushes ESP32 firmware to `link`
devices). Adapted values: `platform: "tizen"` (Linux sends `"linux"`),
`model_id: "samsung-tv"` (Linux sends `"linux"`), and `display_name` is the
TV's `MuseGadgetTV` + 6 hex digits (the Linux client defaults to the host
name; its BLE name is `MuseGadget` + the same suffix). The pairing
`device_info` model stays `hatch_link`, as the apps require.

### 5. Command set: adapted, not copied

The Linux executor's `system.run`, `file.read` and `file.write` are **not**
ported: a TV web app has no shell and no general filesystem, and remote
shell on a television would be a liability, not a feature. In their place
the TV advertises `display.text`, `display.image`, `display.briefing`,
`tv.volume.get/set/up/down`, `tv.mute`, `tv.launch_app` and `device.health`
(same spec format, same `{ok, payload|error}` result shape; unknown invokes
get a proper error result). `device.health` reports model/firmware/Tizen
version/uptime/network/storage as available instead of the Linux load,
memory and temperature fields, which don't exist here.

### 6. Chat surface: sending only

`sendChat` (POST /chat/stream) is ported, including the >64 KiB chunked
upload path in 16 KiB body chunks. The SDK's `/chat/subscribe` event stream,
voice notes (`send_voice`) and TTS streaming are not ported: the TV has no
push-to-talk UX in this version. The composer in the UI posts to the main
chat (no `session_id`), like `musegadget send-user-msg` without arguments.

### 7. Smaller differences

- **JSON escaping**: Python's `json.dumps` escapes non-ASCII (`\uXXXX`);
  JavaScript's `JSON.stringify` emits raw UTF-8. Both are valid JSON and the
  VM parses either; the bytes can differ for non-ASCII payloads.
- **Local interface**: the SDK's Unix-socket `send-user-msg` has no TV
  analogue; the on-screen composer calls the same `sendChat` path.
- **State storage**: identity and pairing live in `localStorage` instead of
  `/var/lib/musegadget` files. If storage is unavailable the identity becomes
  per-launch and nothing can pair persistently (the SDK fails loudly in the
  equivalent situation by refusing to overwrite an unreadable identity).
- **Crypto performance**: the pure-JS primitives are not constant-time, and
  AES-GCM's GHASH is a bit-serial implementation — a maximum-size 65 KB
  transport frame takes a noticeable fraction of a second to authenticate.
  Control and chat traffic is far smaller; image display is by URL, so no
  large payloads cross the session in normal use.
- **Runtime floor**: the pure-JS crypto needs `BigInt`, so the app requires
  Tizen 5.5+ (2020 and later Samsung TVs). `config.xml` declares
  `required_version="5.5"`.
- **ESP32-only endpoints**: `POST /device_token/mint` exists in the ESP32
  SDK's API client (it exchanges a *user/session* token for a device pair)
  but no shipped device code calls it — provisioning arrives via
  `provision_v2` only. It is not used here either.

## Verification status (honest)

Verified in Node (see the test suite): all crypto primitives against
standard vectors and Node's native implementations; envelope/framing bytes
against goldens generated by running the SDK's Python code; the Noise XX
loopback; the pairing vectors byte-for-byte; a simulated-phone pairing that
saves a verified record; the device API request shapes against a local mock
server; and a **full interop run of this JS client against the SDK's own
Python Noise responder and control stream** (register → invoke → result →
chat → unpaired), modelled on the SDK's `tests/test_link_client.py`.

Not verified — cannot be, in this environment: running on a real Samsung TV
(no hardware), TizenBrew/Apps2Samsung installation, a live pairing, the
WebSocket upgrade against the production edge (gap 2 above), and an
end-to-end session with a real Muse VM using a real SDK token and device
credentials. The on-TV run remains unverified until the app is installed on
a TV and paired.
