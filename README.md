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
>    transfer**: pair any BLE-capable gadget client once, then move its
>    `identity.json` + `pairing.json` to the TV — easiest with the bundled
>    **pairing helper** (`tools/pairing-helper`), a zero-dependency script
>    that serves the files once to a one-time code you type on the TV;
>    pasting the files into the TV also works. The TV verifies them
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
| `display.text` | Show a message card (optional title; optional `speak` to read it aloud) |
| `display.image` | Show an image from a URL (optional caption) |
| `display.briefing` | Show a briefing card: a title and short lines (optional `speak`) |
| `speech.say` | Speak text aloud (text-to-speech), with no card; the result reports whether anything was spoken |
| `speech.stop` | Stop speech and clear queued speech |
| `tv.volume.get` | Read volume (0–100) and mute state |
| `tv.volume.set` / `tv.volume.up` / `tv.volume.down` | Set or step the volume |
| `tv.mute` | Mute / unmute / toggle |
| `tv.launch_app` | Open an installed app by its Tizen application id |
| `device.health` | Model, firmware, Tizen version, uptime, network, storage |

When Muse sends nothing, the TV shows a calm ambient screen: the Muse
Gadget TV wordmark, a connection status pill, and a clock.

### Reading messages aloud (text-to-speech)

The app can speak `display.text` and `display.briefing` content using the
TV web runtime's own speech synthesis (the W3C Web Speech API — the Tizen
TV W3C/HTML5 reference lists SpeechSynthesis in the TV profile, behind
the device feature `http://tizen.org/feature/speech.synthesis`, with no
privilege required). Muse can request speech per message with
`speak: true`, and the setup screen (card 4 · Voice) has a **Read
messages aloud** switch for automatic read-aloud plus a **Test the
voice** button. Be aware of the platform limits, which the app respects
rather than papers over: speech *recognition* is not in the TV profile,
utterance pitch/volume are unsupported, and whether a given TV exposes
any voices at all depends on the model — the app detects that at runtime
(the Voice card tells you how many voices your TV has) and simply stays
silent where there are none. Nothing is sent to a cloud TTS service.

### Using a Bluetooth keyboard

Pairing a keyboard is a TV setting, not an app setting: put the keyboard
in pairing mode, then on the TV go to **Settings → General → External
Device Manager → Input Device Manager → Add Bluetooth Keyboard** (on some
models the middle step is called *Keyboard Manager*). USB keyboards work
too — just plug them in.

Once paired, the keyboard works everywhere in the app:

- **Type into any field** — the SDK token, the pairing-helper address and
  code, the pasted pairing files, and the message box on the main screen.
  Characters land in the field exactly once; the TV's on-screen keyboard
  behaves as usual.
- **Enter** in a field runs that field's action (Save, Fetch & log in,
  Send…); **Enter** on a button presses it; **Space** presses it too.
- **Arrow keys** move between controls; inside a text field they move the
  caret instead (all four in the multi-line paste fields, left/right in
  single-line fields; up/down still jump to the neighbouring control).
- **Esc** first leaves the field you are typing in, then goes back a
  screen — the same job the remote's Return key does. **Tab / Shift+Tab**
  walk through the controls in order.

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

Four steps, in order, for any Muse user — nothing here is tied to a
particular account, and nobody's credentials are baked into the app. Only
step 2 is fiddly: it is Meta's one-time pairing, which every gadget
(official or community) goes through exactly once.

1. **Get an SDK token.** At [gadgets.muse.ai](https://gadgets.muse.ai/settings/sdk-tokens)
   (Account → SDK tokens), create a token (`mgst_…`). Every gadget needs
   one, including ones you build for yourself. Read the
   [Gadget SDK Terms](https://gadgets.muse.ai/sdk-terms) first.
2. **Pair the official Linux SDK once.** On a Raspberry Pi or any Linux
   computer with Bluetooth, install Meta's
   [Linux Device SDK](https://github.com/facebookincubator/muse-gadget-sdk/blob/main/linux/README.md)
   and pair it with the Muse app (*Settings → Devices → Developer mode*,
   then *Add Device*). That short Bluetooth conversation is where the Muse
   app hands over your account's device credentials — there is **no web
   sign-in for gadgets**, so this step cannot be skipped or done in a
   browser. When pairing finishes, **stop the SDK client on that machine
   and leave it off**: its pairing is about to move to the TV, and only
   one device can use a pairing at a time.
3. **Install the TV app** (see [Install](#install) above) and launch it —
   it opens on the setup screen. In *Setup & pairing*, card 1, paste your
   SDK token and Save. The TV generates its own gadget identity (a
   `MuseGadgetTVXXXXXX` name and a `homelink-xxxxxx` node id); the login
   in the next step replaces it with the transferred pairing's identity.
4. **Log in — fetch the pairing.** On the pairing machine, run the helper
   (it is in this repo, needs nothing but Python 3):

   ```sh
   python3 tools/pairing-helper/pairing-helper.py
   ```

   It reads `identity.json` and `pairing.json` from the SDK state folder
   (`/var/lib/musegadget`), prints a **helper address** and a **one-time
   6-digit code**, and waits. On the TV — card 3, *Fetch from pairing
   helper* — type the address and the code and press *Fetch & log in*.
   The helper sends the pairing once, only to the request carrying that
   code, and then stops. The TV checks the credentials against the Muse
   device API before saving — nothing is stored if the check fails —
   adopts the pairing's identity, and from then on connects and rotates
   its tokens by itself over HTTPS.

   No Python handy? Card 3 also accepts the two files pasted in directly,
   and — as a last resort — the bare device-token pair; see PROTOCOL.md
   for why the files are the reliable path.
5. **Use it.** Once the status pill says *Connected to Muse*, ask Muse to
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
- the pairing-helper fetch (TV side): address/code handling and the helper
  protocol against a mock helper — a clean fetch feeds the same gate,
  while a refused code and a malformed payload are rejected before the
  Muse API is ever called. The helper script has its own suite
  (`python3 tests/test_pairing_helper.py`): the right code serves the
  pairing once and then refuses, a wrong code is a 403 that consumes
  nothing, no response ever contains a token value, and missing or
  malformed pairing files error cleanly;
- the speech module against a fake synthesiser (support detection with an
  empty voice list, queue/interrupt/stop discipline, the 500-character
  cap, the persisted read-aloud preference) and the executor's speech
  wiring against a stub;
- the keyboard planner's full mapping (remote keys, typing passthrough in
  single- and multi-line fields, Enter/Esc/Tab semantics);
- an **interop run of the real JS link client against the SDK's own Python
  implementation** (handshake, register, invoke/result, chat, unpair) when
  the SDK checkout and Python `cryptography` are available — it skips
  cleanly otherwise. CI runs it in full.

Not verified (needs hardware and a real account): the on-TV run, the store
install paths, live pairing, a pairing transfer from a real account (the
real helper and the TV's real fetch code were smoke-tested together on
localhost with fixture files), the production WebSocket edge, speech
actually sounding on a retail TV (whether the S95F-class runtime exposes
voices is a hardware question), and a real Bluetooth keyboard paired with
the TV.

## Layout

```
app/            the Tizen web app (this is what ships in the .wgt)
  config.xml    Tizen manifest (package muse.gadget, app muse.gadget.tv)
  index.html    ambient screen, setup screen, display cards
  js/           protocol modules (see PROTOCOL.md for the port map)
  css/, icon.png
tools/          build-wgt.sh (builds the .wgt) and pairing-helper/ — the
                zero-dependency script that hands a pairing to the TV once
tests/          Node test suite (+ the Python interop peer and helper tests)
package.json    TizenBrew module manifest (packageType "app")
PROTOCOL.md     port map, message flow, every deviation and gap
BUILD.md        building, packaging and releasing
```

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The protocol
implementation is derived from Meta's Muse Gadget SDK (Apache 2.0). The
SDK's Jollybot avatar artwork is *not* covered by that license and is not
included anywhere in this project; the icon and UI art here are original.
