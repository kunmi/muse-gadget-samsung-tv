# Pairing helper — Muse Gadget TV

`pairing-helper.py` hands your Muse gadget pairing from the computer (or
Raspberry Pi) where you paired to the TV, once, over your home network —
so you never have to type JSON on a TV remote.

**Zero dependencies.** One file, Python 3.6+ standard library only.

```sh
python3 pairing-helper.py
```

Run it where the Muse Gadget SDK Linux client paired: it reads
`identity.json` and `pairing.json` from that client's state folder
(default `/var/lib/musegadget`; override with `--dir`, or `--identity` /
`--pairing` for individual files). It prints:

- the **helper address** to type on the TV (this machine's LAN address and
  port, default port `8737`), and
- a **one-time 6-digit code**.

On the TV: *Muse Gadget TV → Setup & pairing → card 3 → "Fetch from
pairing helper"*, type both, press **Fetch & log in**. The TV verifies the
credentials with Muse before saving anything. The helper then stops by
itself; it also stops — having sent nothing — after 10 minutes
(`--serve-minutes`), and a wrong code never uses up the transfer.

**Security, plainly.** The transfer is plaintext HTTP on your LAN,
guarded by the single-use code and its short life. Anyone on your network
who types the code first gets the pairing, so run it once, at the TV, on
a home network you trust — the same trust level as the Muse Gadget SDK's
own pairing advice. Token values are never printed or logged. After a
successful transfer, keep the gadget client on the pairing machine off:
only one device can use a pairing at a time.
