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
"""Tests for tools/pairing-helper/pairing-helper.py.

Run:  python3 tests/test_pairing_helper.py

The helper's contract, exercised over a real local socket:
  - a request carrying the one-time code gets the pairing, exactly once;
  - a wrong code is a 403 and does NOT consume the transfer;
  - the code shows up nowhere in any response, and neither do the tokens;
  - missing or malformed pairing files are a clean, plain-language error
    (the same validation rules the TV applies: app/js/web-login.js).
"""
import http.client
import importlib.util
import json
import os
import tempfile
import threading
import unittest

HELPER_PATH = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..",
    "tools", "pairing-helper", "pairing-helper.py"))


def _load_helper():
    spec = importlib.util.spec_from_file_location("pairing_helper", HELPER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = _load_helper()

IDENTITY_TEXT = '{"mac": "AA:BB:CC:DD:EE:FF"}\n'
PAIRING_TEXT = json.dumps({
    "access_token": "secret-access-token-value",
    "refresh_token": "secret-refresh-token-value",
    "token_type": "device",
    "username": "someone",
    "api_url": "",
    "api_url_v2": "",
    "noise_host": "hatch.metaaivm.com",
    "access_token_saved_at": 1790000000,
    "sdk_token_hint": "mgst_abcdefg",
})
CODE = "123456"


def write_pair(tmp, identity=IDENTITY_TEXT, pairing=PAIRING_TEXT):
    identity_path = os.path.join(tmp, "identity.json")
    pairing_path = os.path.join(tmp, "pairing.json")
    for path, text in ((identity_path, identity), (pairing_path, pairing)):
        if text is None:
            if os.path.exists(path):
                os.remove(path)
        else:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
    return identity_path, pairing_path


class LoadPairingFilesTests(unittest.TestCase):
    def test_valid_files_load_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            payload = helper.load_pairing_files(*write_pair(tmp))
        self.assertEqual(payload, {"identity": IDENTITY_TEXT,
                                   "pairing": PAIRING_TEXT})

    def test_missing_files_error_names_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(helper.HelperError) as ctx:
                helper.load_pairing_files(*write_pair(tmp, identity=None))
            self.assertIn("identity.json", str(ctx.exception))
            with self.assertRaises(helper.HelperError) as ctx:
                helper.load_pairing_files(*write_pair(tmp, pairing=None))
            self.assertIn("pairing.json", str(ctx.exception))

    def test_malformed_files_error_cleanly(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad_cases = [
                ("{nope", PAIRING_TEXT, "identity.json is not valid JSON"),
                ('[1]', PAIRING_TEXT, "identity.json does not hold a JSON object"),
                ('{}', PAIRING_TEXT, 'identity.json has no usable "mac"'),
                ('{"mac": "aa:bb:cc:dd:ee"}', PAIRING_TEXT,
                 'identity.json has no usable "mac"'),
                (IDENTITY_TEXT, "nope", "pairing.json is not valid JSON"),
                (IDENTITY_TEXT, '{"refresh_token": "r"}',
                 "pairing.json is missing: access_token"),
                (IDENTITY_TEXT, '{}',
                 "pairing.json is missing: access_token, refresh_token"),
                (IDENTITY_TEXT, '{"access_token": "", "refresh_token": "r"}',
                 "pairing.json is missing: access_token"),
            ]
            for identity, pairing, message in bad_cases:
                with self.subTest(message=message):
                    with self.assertRaises(helper.HelperError) as ctx:
                        helper.load_pairing_files(
                            *write_pair(tmp, identity, pairing))
                    self.assertIn(message, str(ctx.exception))


class ServingTests(unittest.TestCase):
    def setUp(self):
        self.payload = {"identity": IDENTITY_TEXT, "pairing": PAIRING_TEXT}
        self.server, self.state = helper.make_server(
            self.payload, CODE, "127.0.0.1", 0)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", path)
            resp = conn.getresponse()
            return resp.status, resp.read().decode("utf-8")
        finally:
            conn.close()

    def test_right_code_serves_the_pairing_once(self):
        status, body = self.get("/pairing?code=" + CODE)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), self.payload)
        self.assertTrue(self.state["consumed"])
        # A second fetch — even with the right code — is refused.
        status, _ = self.get("/pairing?code=" + CODE)
        self.assertEqual(status, 410)

    def test_wrong_code_is_403_and_the_transfer_remains(self):
        status, body = self.get("/pairing?code=999999")
        self.assertEqual(status, 403)
        self.assertNotIn(CODE, body)
        self.assertFalse(self.state["consumed"])
        # A missing code is just a wrong code.
        status, _ = self.get("/pairing")
        self.assertEqual(status, 403)
        self.assertFalse(self.state["consumed"])
        # The transfer is still there for the right code.
        status, body = self.get("/pairing?code=" + CODE)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), self.payload)

    def test_no_secrets_on_other_paths(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertNotIn("secret-access-token-value", body)
        self.assertNotIn("secret-refresh-token-value", body)
        status, body = self.get("/anything-else")
        self.assertEqual(status, 404)
        self.assertNotIn("secret-access-token-value", body)
        # The pairing endpoint's refusal carries no secrets either.
        status, body = self.get("/pairing?code=000000")
        self.assertEqual(status, 403)
        self.assertNotIn("secret-access-token-value", body)

    def test_serve_once_returns_after_the_transfer(self):
        # serve_once (the loop main() uses) must end once the transfer
        # happens — here driven from a thread against the same machinery.
        server, state = helper.make_server(self.payload, CODE, "127.0.0.1", 0)
        port = server.server_address[1]
        outcome = {}

        def run():
            outcome["done"] = helper.serve_once(server, state, 30)
            server.server_close()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("GET", "/pairing?code=" + CODE)
            resp = conn.getresponse()
            self.assertEqual(resp.status, 200)
            resp.read()
        finally:
            conn.close()
        thread.join(timeout=10)
        self.assertEqual(outcome.get("done"), True)


if __name__ == "__main__":
    unittest.main()
