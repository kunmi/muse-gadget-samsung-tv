# Muse Gadget TV

Turn a Samsung Tizen TV into a **Muse gadget**. Install this app on the TV,
pair it with your Muse account, and Muse can use the TV as a household
surface: show messages, images and briefings on the big screen, read and set
the volume, mute, and open TV apps — all over the same encrypted protocol
Meta's [Muse Gadget SDK](https://github.com/facebookincubator/muse-gadget-sdk)
uses for its Linux and ESP32 gadgets. There is also a composer on the TV for
sending a message *to* Muse.

The TV app is vanilla JavaScript with **no build step and no runtime
dependencies** — Tizen's Chromium runs the files in `app/` as-is, including a
self-contained implementation of the Noise XX session crypto (X25519,
AES-256-GCM, SHA-256), the protobuf transport framing, and pairing v5.

> ### Honest status
> The protocol implementation is verified in Node against the SDK's own
> test vectors, golden bytes generated from the SDK's Python code, and a
> live interop run against the SDK's Python implementation (see
> [Verification](#verification)). It has **not** been run on a real TV, and
> two things stand between this repo and a working gadget on your wall:
>
> 1. **Pairing.** In the SDK, the Muse app hands a gadget its credentials
>    over Bluetooth, and a Tizen *web* app cannot advertise a Bluetooth GATT
>    service — so the Muse app cannot provision the TV directly. But a
>    gadget's *login* is pure web (HTTPS to the Muse device API), and a
>    completed pairing is two small files, so the TV logs in by **pairing
>    transfer**: pair any BLE-capable gadget client once, then paste its
>    `identity.json` + `pairing.json` into the TV, which verifies them
>    against the Muse API and adopts the pairing's identity. This is the
>    flow the community PSP port established for a device with no Bluetooth
>    at all. The whole story, unsparingly, is in [PROTOCOL.md](PROTOCOL.md).
> 2. **The WebSocket upgrade.** The SDK authenticates the Noise connection
>    with an `Authorization` header on the WebSocket upgrade; browsers
>    cannot set WebSocket headers, so whether the production edge accepts
>    the TV's upgrade is untested (PROTOCOL.md, gap 2).
>
> Everything else — device API, token rotation, Noise session, control
> stream, commands, chat — follows the SDK exactly and is tested.

## What Muse can do on the TV

| Command | What it does |
|---|---|
| `display.text` | Show a message card (optional title) |
| `display.image` | Show an image from a URL (optional caption) |
| `display.briefing` | Show a briefing card: a title and short lines |
| `tv.volume.get` | Read volume (0–100) and mute state |
| `tv.volume.set` / `tv.volume.up` / `tv.volume.down` | Set or step the volume |
| `tv.mute` | Mute / unmute / toggle |
| `tv.launch_app` | Open an installed app by its Tizen application id |
| `device.health` | Model, firmware, Tizen version, uptime, network, storage |

When Muse sends nothing, the TV shows a calm ambient screen: the Muse
Gadget TV wordmark, a connection status pill, and a clock.

Ask Muse things like:

> Put a note on the living-room TV: "Dinner is at 7."

> Show today's briefing on the TV.

> Turn the TV down a bit.

## Install

### Path 1 — Apps2Samsung (sideloaded .wgt)

1. Grab `muse-gadget-tv.wgt` from this repo's GitHub Releases (or build it
   yourself — see [BUILD.md](BUILD.md)).
2. In Apps2Samsung, pick the `.wgt` and install it on your TV. Apps2Samsung
   applies your Samsung developer certificate at install time, so the
   package in this repo is intentionally unsigned.
3. Launch **Muse Gadget TV** from the TV's app list.

### Path 2 — TizenBrew (module)

This repo is also a TizenBrew *application module*: its root `package.json`
carries `"packageType": "app"` and points at `app/index.html`, and the app
is fully static, so it can be served from GitHub Pages or any static host.

1. Install TizenBrew on the TV (see the TizenBrew project for its own
   install steps).
2. In TizenBrew, add this repository as a module source and install
   **Muse Gadget TV**.
3. Launch it from the TizenBrew launcher.

### Path 3 — Tizen Studio (development)

Open the `app/` folder as a Tizen web project, set your signing certificate,
and run on a TV in developer mode. The project is the `app/` folder itself
(`config.xml` at its root).

## Set it up with Muse

1. **Get an SDK token.** At [gadgets.muse.ai](https://gadgets.muse.ai/settings/sdk-tokens)
   (Account → SDK tokens), create a token (`mgst_…`). Every gadget needs
   one, including ones you build for yourself. Read the
   [Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms) first.
2. **Enter it on the TV.** Open Muse Gadget TV → *Setup & pairing*, paste
   the token, Save. The TV generates its gadget identity once (a
   `MuseGadgetTVXXXXXX` name and a `homelink-xxxxxx` node id) and keeps it
   across unpairing — unless a web login (next step) replaces it with a
   transferred pairing's identity.
3. **Log in (pairing transfer).** On a computer or Raspberry Pi with
   Bluetooth, install the SDK's Linux client and pair it with the Muse
   app (*Settings → Devices → Developer mode*, then *Add Device*). Stop
   that client and leave it off — only one device can use a pairing at a
   time. Copy `identity.json` and `pairing.json` from its state folder
   (`/var/lib/musegadget`) and paste both into the TV's *Setup & pairing*
   → *Log in over the web*. The TV checks the credentials against the Muse
   device API before saving — nothing is stored if the check fails — adopts
   the pairing's identity, and from then on connects and rotates its
   tokens by itself over HTTPS. (Pasting just the two device tokens also
   works as a fallback, but keeps the TV's own identity; see PROTOCOL.md
   for why the files are the reliable path.)
4. **Use it.** Once the status pill says *Connected to Muse*, ask Muse to
   show something on the TV, or type a message to Muse in the TV's
   composer.

Pairing matters: community gadgets pair without manufacturer verification,
and the setup handshake cannot stop an active man-in-the-middle attack. Set
up on a network you trust, as the SDK's own README advises.

## Safety notes

- Muse gets exactly the commands in the table above — nothing else. This
  port deliberately has **no** shell or file access (the Linux gadget's
  `system.run` / `file.read` / `file.write` were not ported; see
  PROTOCOL.md).
- The SDK token and the device credentials live in the app's local storage
  on the TV. Anyone with the device credential pair can impersonate this
  gadget to your Muse until you unpair it (in the Muse app, or with the
  *Unpair this TV* button, which deletes them from the TV).
- Use is governed by the [Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms).

## Verification

`npm test` (or `node tests/run-tests.js`) runs, with no network access:

- crypto primitives against FIPS/RFC/NIST vectors and Node's native crypto;
- protobuf/framing bytes against **goldens generated by the SDK's Python
  code**;
- the Noise XX initiator↔responder loopback and transport round trips;
- **pairing v5 against the SDK's published test vectors, byte-for-byte**,
  plus a full simulated-phone pairing that ends in a verified, saved
  pairing record;
- the device API client against a local mock server (request shapes,
  parsing, refresh semantics);
- the web login (pairing transfer): SDK state-file parsing with the PSP
  tool's validation rules, the verify-before-save gate against a mock
  device API (a rejected transfer saves nothing and adopts nothing),
  identity adoption, and rotation presenting the adopted node id;
- an **interop run of the real JS link client against the SDK's own Python
  implementation** (handshake, register, invoke/result, chat, unpair) when
  the SDK checkout and Python `cryptography` are available — it skips
  cleanly otherwise. CI runs it in full.

Not verified (needs hardware and a real account): the on-TV run, the store
install paths, live pairing, a live pairing transfer, the production
WebSocket edge.

## Layout

```
app/            the Tizen web app (this is what ships in the .wgt)
  config.xml    Tizen manifest (package muse.gadget, app muse.gadget.tv)
  index.html    ambient screen, setup screen, display cards
  js/           protocol modules (see PROTOCOL.md for the port map)
  css/, icon.png
tools/build-wgt.sh   builds dist/muse-gadget-tv.wgt
tests/          Node test suite (+ the Python interop peer)
package.json    TizenBrew module manifest (packageType "app")
PROTOCOL.md     port map, message flow, every deviation and gap
BUILD.md        building, packaging and releasing
```

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The protocol
implementation is derived from Meta's Muse Gadget SDK (Apache 2.0). The
SDK's Jollybot avatar artwork is *not* covered by that license and is not
included anywhere in this project; the icon and UI art here are original.
