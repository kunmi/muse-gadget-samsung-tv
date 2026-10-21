#!/usr/bin/env python3
# Interop test peer: drives the JS gadget client with Meta's Muse Gadget
# SDK Python implementation itself (linux/src/musegadget), the same way the
# SDK's tests/test_link_client.py FakeVm does.
#
# Channel protocol (stdin/stdout, one message per line):
#   JS -> VM : hex of one WebSocket binary frame, or "CMD {json}" to make
#              the VM send something ({"send_invoke": {...}} or
#              {"send_unpair": true}).
#   VM -> JS : hex of one WebSocket binary frame, or "EVT {json}" with an
#              observation for the test driver (register message, chat
#              request frame, link.result, ...).
#
# The SDK source is located via $MUSE_GADGET_SDK_LINUX_SRC, defaulting to
# the sibling checkout ../../muse-gadget-sdk-ref/linux/src relative to the
# repository root. This file is test tooling only; it is not part of the TV
# app and is not packaged into the .wgt.

import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SDK_SRC = os.environ.get("MUSE_GADGET_SDK_LINUX_SRC") or os.path.normpath(
    os.path.join(_HERE, "..", "..", "muse-gadget-sdk-ref", "linux", "src")
)
sys.path.insert(0, _SDK_SRC)

from musegadget.link_client import MessageDecoder, encode_message  # noqa: E402
from musegadget.noise import NoiseFrameDecoder, NoiseXXResponder  # noqa: E402
from musegadget.noise.envelope import (  # noqa: E402
    ApplicationResponse,
    BodyChunk,
    ServiceFrame,
)
from musegadget.noise.framing import encode_noise_frames  # noqa: E402
from musegadget.noise.transport import (  # noqa: E402
    decode_request_envelope,
    encode_response_envelope,
)

inp = sys.stdin.buffer
out = sys.stdout


def send_hex(data: bytes) -> None:
    out.write(data.hex() + "\n")
    out.flush()


def evt(obj) -> None:
    out.write("EVT " + json.dumps(obj) + "\n")
    out.flush()


def read_line() -> str:
    line = inp.readline()
    if not line:
        sys.exit(0)
    return line.strip().decode()


def main() -> None:
    responder = NoiseXXResponder()
    responder.initialize()
    send_hex(responder.read_message1_and_write_message2(bytes.fromhex(read_line())))
    responder.read_message3(bytes.fromhex(read_line()))
    send_cipher, recv_cipher = responder.split()

    decoder = NoiseFrameDecoder()
    messages = MessageDecoder()
    state = {"stream_id": None}

    def send_frame(frame: ServiceFrame) -> None:
        for chunk in encode_noise_frames(encode_response_envelope(frame)):
            send_hex(send_cipher.encrypt_with_ad(b"", chunk))

    def send_message(message: dict) -> None:
        send_frame(ServiceFrame.body_chunk(
            state["stream_id"], BodyChunk(data=encode_message(message)),
        ))

    while True:
        line = read_line()
        if line.startswith("CMD "):
            cmd = json.loads(line[4:])
            if "send_invoke" in cmd:
                send_message(cmd["send_invoke"])
            elif cmd.get("send_unpair"):
                send_message({"type": "evt", "event": "link.unpaired"})
            continue

        plain = recv_cipher.decrypt_with_ad(b"", bytes.fromhex(line))
        assembled = decoder.decode(plain)
        if assembled is None:
            continue
        frame = decode_request_envelope(assembled)

        if frame.kind == "request" and frame.value.path == "/link-control":
            state["stream_id"] = frame.stream_id
            send_frame(ServiceFrame.response(
                frame.stream_id, ApplicationResponse(status=200, end_body=False),
            ))
            evt({"event": "control_stream", "stream_id": frame.stream_id,
                 "verb": frame.value.verb, "end_body": frame.value.end_body})
        elif frame.kind == "request" and frame.value.path == "/chat/stream":
            headers = {h.key.lower(): h.value for h in frame.value.headers}
            evt({"event": "chat_request", "stream_id": frame.stream_id,
                 "verb": frame.value.verb, "path": frame.value.path,
                 "end_body": frame.value.end_body, "headers": headers,
                 "body": frame.value.body.decode("utf-8")})
            send_frame(ServiceFrame.response(
                frame.stream_id,
                ApplicationResponse(status=200, body=b'{"accepted":true}', end_body=True),
            ))
        elif frame.kind == "body_chunk":
            for message in messages.feed(frame.value.data):
                if message.get("method") == "link.register":
                    evt({"event": "register", "message": message})
                    send_message({"type": "res", "id": message["id"], "ok": True})
                elif message.get("method") == "link.result":
                    evt({"event": "link_result", "message": message})
                else:
                    evt({"event": "message", "message": message})
        else:
            evt({"event": "frame", "kind": frame.kind, "stream_id": frame.stream_id})


if __name__ == "__main__":
    main()
