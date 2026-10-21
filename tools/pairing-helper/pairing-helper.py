#!/usr/bin/env python3
# Copyright (c) 2026 Muse Gadget TV contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Pairing helper for Muse Gadget TV — hand your pairing to the TV once.

Run this on the computer or Raspberry Pi where you paired Meta's Muse
Gadget SDK Linux client with the Muse app. A finished pairing is two small
files in that client's state folder (default /var/lib/musegadget):

    identity.json   {"mac": "aa:bb:cc:dd:ee:ff"}
    pairing.json    {access_token, refresh_token, ...}

This helper serves those two files exactly once, over your home network,
to whoever asks with the one-time 6-digit code it prints. On the TV you
type the helper's address and that code (Muse Gadget TV → Setup &
pairing → "Log in over the web" → "Fetch from pairing helper"), and the
TV verifies the credentials with Muse before saving anything. Then this
helper stops by itself. It also stops, having sent nothing, when its time
runs out (--serve-minutes, default 10).

Security model, plainly: the transfer is plaintext HTTP on your LAN,
guarded by a single-use code with a short life. Anyone on your network
who types the code first gets the pairing — the same trust level as the
Muse Gadget SDK's own pairing advice ("set it up on a network you
trust"). Run it once, at the TV, on a home network you trust. Token values
are never printed or logged.

Zero dependencies: Python 3.6+ standard library only.

    python3 pairing-helper.py [--dir /var/lib/musegadget]
                              [--identity PATH] [--pairing PATH]
                              [--port 8737] [--serve-minutes 10]
"""

import argparse
import hmac
import json
import os
import re
import secrets
import socket
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_STATE_DIR = "/var/lib/musegadget"
DEFAULT_PORT = 8737
DEFAULT_SERVE_MINUTES = 10.0

# The same validation rules the TV applies (app/js/web-login.js, which
# follows the Muse Gadget SDK community tooling): the identity MAC shape,
# and a pairing must carry non-empty access/refresh tokens.
MAC_RE = re.compile(r"^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
PAIRING_FIELDS = ("access_token", "refresh_token")

ROOT_TEXT = (
    "Muse Gadget TV pairing helper is running.\n"
    "On the TV, choose \"Fetch from pairing helper\" and type the address\n"
    "and the 6-digit code shown in the helper's terminal window.\n"
    "There is nothing to see here — the pairing is never shown in a browser.\n"
)


class HelperError(Exception):
    """A problem the user can fix, phrased for the terminal."""


def _read_file(path, name):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError:
        raise HelperError(
            "could not find %s at %s. Point --dir at the folder that holds "
            "your pairing files if they live somewhere else." % (name, path))
    except (OSError, UnicodeDecodeError) as err:
        raise HelperError("could not read %s at %s (%s)." % (name, path, err))


def _parse_json(text, name):
    try:
        data = json.loads(text)
    except ValueError:
        raise HelperError("%s is not valid JSON." % name)
    if not isinstance(data, dict):
        raise HelperError("%s does not hold a JSON object." % name)
    return data


def load_pairing_files(identity_path, pairing_path):
    """Read and validate the two pairing files.

    Returns the payload the helper serves: the files' raw text, exactly as
    the TV's login expects to receive them. Raises HelperError with a
    plain-language message on any problem.
    """
    identity_text = _read_file(identity_path, "identity.json")
    pairing_text = _read_file(pairing_path, "pairing.json")

    identity = _parse_json(identity_text, "identity.json")
    mac = identity.get("mac")
    if not isinstance(mac, str) or not MAC_RE.match(mac.strip()):
        raise HelperError(
            'identity.json has no usable "mac". Has that device finished '
            "pairing?")

    pairing = _parse_json(pairing_text, "pairing.json")
    missing = [field for field in PAIRING_FIELDS
               if not isinstance(pairing.get(field), str)
               or not pairing.get(field)]
    if missing:
        raise HelperError(
            "pairing.json is missing: %s. Has that device finished pairing?"
            % ", ".join(missing))

    return {"identity": identity_text, "pairing": pairing_text}


def generate_code():
    return "%06d" % secrets.randbelow(1000000)


def _make_handler(state):
    class PairingHandler(BaseHTTPRequestHandler):
        # HTTP/1.0: one request per connection, closed after the reply —
        # the simplest behaviour for the TV's XHR client to consume.
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self._send(200, "text/plain; charset=utf-8", ROOT_TEXT)
                return
            if parsed.path != "/pairing":
                self._send(404, "text/plain; charset=utf-8",
                           "Not found. On the TV, use the address and code "
                           "the helper printed.\n")
                return
            if state["consumed"]:
                self._send(410, "text/plain; charset=utf-8",
                           "That code was already used — the helper sends a "
                           "pairing only once. Run the helper again for a "
                           "fresh code.\n")
                return
            code = (parse_qs(parsed.query).get("code") or [""])[0]
            if not code or not hmac.compare_digest(code, state["code"]):
                # A wrong code never consumes the one transfer.
                self._send(403, "text/plain; charset=utf-8",
                           "Wrong code. Check the 6 digits in the helper's "
                           "terminal window and try again — a wrong code "
                           "does not use up the transfer.\n")
                return
            state["consumed"] = True
            state["served_to"] = self.client_address[0]
            self._send(200, "application/json",
                       json.dumps(state["payload"]))

        def _send(self, status, content_type, body):
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):
            # Never log paths or query strings: the code travels in one.
            sys.stderr.write("  (request from %s)\n"
                             % (self.client_address[0],))

    return PairingHandler


class _Server(HTTPServer):
    allow_reuse_address = True


def make_server(payload, code, host, port):
    """Build the HTTP server and its transfer state (for main and tests)."""
    state = {"payload": payload, "code": code,
             "consumed": False, "served_to": None}
    server = _Server((host, port), _make_handler(state))
    return server, state


def serve_once(server, state, timeout_seconds):
    """Serve until the one transfer happens or the time runs out."""
    server.timeout = 1.0  # wake up regularly to check the deadline
    deadline = time.monotonic() + timeout_seconds
    while not state["consumed"] and time.monotonic() < deadline:
        server.handle_request()
    return state["consumed"]


def lan_addresses():
    """This machine's likely LAN IPv4 addresses, best guess first."""
    addrs = []
    try:
        # A UDP "connect" sends nothing; it just reveals which local
        # address this machine would use to reach the rest of the LAN.
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            addrs.append(sock.getsockname()[0])
        finally:
            sock.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None,
                                       socket.AF_INET):
            ip = info[4][0]
            if ip not in addrs:
                addrs.append(ip)
    except OSError:
        pass
    addrs = [ip for ip in addrs if not ip.startswith("127.")]
    return addrs or ["127.0.0.1"]


def main(argv=None):
    try:
        # The address and code must reach the user the moment they are
        # printed, even when stdout is a pipe or a file.
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass
    parser = argparse.ArgumentParser(
        prog="pairing-helper.py",
        description="Serve your Muse gadget pairing to Muse Gadget TV "
                    "once, over your home network, guarded by a one-time "
                    "6-digit code.")
    parser.add_argument("--dir", default=DEFAULT_STATE_DIR,
                        help="folder holding identity.json and pairing.json "
                             "(default: %(default)s)")
    parser.add_argument("--identity", default=None,
                        help="path to identity.json (overrides --dir)")
    parser.add_argument("--pairing", default=None,
                        help="path to pairing.json (overrides --dir)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="port to serve on (default: %(default)s)")
    parser.add_argument("--serve-minutes", type=float,
                        default=DEFAULT_SERVE_MINUTES,
                        help="stop after this many minutes if nobody "
                             "fetches (default: %(default)s)")
    args = parser.parse_args(argv)

    identity_path = args.identity or os.path.join(args.dir, "identity.json")
    pairing_path = args.pairing or os.path.join(args.dir, "pairing.json")

    try:
        payload = load_pairing_files(identity_path, pairing_path)
    except HelperError as err:
        print("Could not start: %s" % err, file=sys.stderr)
        return 1

    code = generate_code()
    try:
        server, state = make_server(payload, code, "0.0.0.0", args.port)
    except OSError:
        print("Could not start: port %d is already in use. "
              "Try --port %d." % (args.port, args.port + 1),
              file=sys.stderr)
        return 1
    port = server.server_address[1]
    minutes = args.serve_minutes
    minutes_text = ("%g" % minutes)

    print("Muse Gadget TV — pairing helper")
    print("================================")
    print("")
    print("Found your pairing:")
    print("  identity: %s" % identity_path)
    print("  pairing:  %s" % pairing_path)
    print("")
    print("On your TV, open Muse Gadget TV > Setup & pairing > card 3")
    print('("Log in over the web"), choose "Fetch from pairing helper",')
    print("and type:")
    print("")
    addresses = ["%s:%d" % (ip, port) for ip in lan_addresses()]
    print("  Helper address:   %s" % addresses[0])
    for extra in addresses[1:]:
        print("                    (if that does not work, try %s)" % extra)
    print("  Code:             %s" % code)
    print("")
    print('Then press "Fetch & log in" on the TV.')
    print("")
    print("This helper sends the pairing ONCE, to whoever types that code")
    print("first, then stops by itself. It also stops after %s minute(s)"
          % minutes_text)
    print("if nobody fetches, having sent nothing. Anyone on this network")
    print("who gets the code first could take the pairing, so only run it")
    print("on a home network you trust — the same advice the Muse Gadget")
    print("SDK gives for pairing itself.")
    print("")
    print("Waiting for the TV...")
    try:
        done = serve_once(server, state, minutes * 60.0)
    except KeyboardInterrupt:
        print("\nStopped. Nothing was sent.")
        server.server_close()
        return 0
    server.server_close()

    if done:
        print("Pairing sent to %s." % state["served_to"])
        print("The helper has stopped — the code cannot be used again.")
        print("")
        print("One more thing: keep the Muse gadget service on THIS")
        print("machine off from now on. The TV uses this pairing now,")
        print("and only one device can use a pairing at a time.")
        return 0
    print("Nobody fetched the pairing within %s minute(s), so the helper"
          % minutes_text)
    print("stopped. Nothing was sent. Run it again when you are sitting")
    print("at the TV.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
