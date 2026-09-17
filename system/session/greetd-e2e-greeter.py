#!/usr/bin/env python3
"""Disposable CI greeter for SWIR System Edition.

This file is only installed into the graphical E2E image. It exercises greetd's
real IPC + PAM authentication path with a disposable test account, then starts
the SWIR Wayland session. It is not a production greeter and contains no
production credentials.
"""

import json
import os
import socket
import struct
import sys

USERNAME = os.environ.get("SWIR_E2E_USERNAME", "swir-e2e")
PASSWORD = os.environ.get("SWIR_E2E_PASSWORD", "SWIR-E2E-Only-2026!")
SOCK = os.environ.get("GREETD_SOCK")

if not SOCK or not os.path.isabs(SOCK):
    raise SystemExit("GREETD_SOCK is missing or not absolute")


def recv_exact(conn: socket.socket, size: int) -> bytes:
    out = bytearray()
    while len(out) < size:
        chunk = conn.recv(size - len(out))
        if not chunk:
            raise RuntimeError("greetd IPC closed unexpectedly")
        out.extend(chunk)
    return bytes(out)


def exchange(conn: socket.socket, payload: dict) -> dict:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    conn.sendall(struct.pack("=I", len(raw)) + raw)
    size = struct.unpack("=I", recv_exact(conn, 4))[0]
    if size <= 0 or size > 1024 * 1024:
        raise RuntimeError(f"invalid greetd reply size: {size}")
    reply = json.loads(recv_exact(conn, size).decode("utf-8"))
    if not isinstance(reply, dict) or not isinstance(reply.get("type"), str):
        raise RuntimeError("malformed greetd reply")
    return reply


def require_success_or_auth(reply: dict) -> dict:
    kind = reply.get("type")
    if kind == "error":
        raise RuntimeError(f"greetd error: {reply.get('error_type')}: {reply.get('description')}")
    if kind not in {"success", "auth_message"}:
        raise RuntimeError(f"unexpected greetd reply: {kind}")
    return reply


with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
    conn.settimeout(20)
    conn.connect(SOCK)

    reply = require_success_or_auth(exchange(conn, {"type": "create_session", "username": USERNAME}))
    prompts = 0
    while reply.get("type") == "auth_message":
        prompts += 1
        if prompts > 12:
            raise RuntimeError("too many PAM prompts")
        auth_type = reply.get("auth_message_type")
        if auth_type == "secret":
            response = PASSWORD
        elif auth_type == "visible":
            # The disposable account should not need a visible response, but a
            # blank answer is deterministic and keeps the greeter generic.
            response = ""
        elif auth_type in {"info", "error"}:
            response = None
        else:
            raise RuntimeError(f"unsupported PAM message type: {auth_type}")
        message = {"type": "post_auth_message_response"}
        if response is not None:
            message["response"] = response
        reply = require_success_or_auth(exchange(conn, message))

    if reply.get("type") != "success":
        raise RuntimeError("PAM authentication did not complete")

    start = {
        "type": "start_session",
        "cmd": ["/usr/local/bin/swir-session"],
        "env": [
            "XDG_SESSION_TYPE=wayland",
            "XDG_CURRENT_DESKTOP=SWIR",
            "XDG_SESSION_DESKTOP=swir",
            "SWIR_SESSION_E2E=1",
            "SWIR_WESTON_BACKEND=headless",
            "SWIR_WESTON_SHELL=kiosk-shell.so",
            "WAYLAND_DISPLAY=wayland-swir",
        ],
    }
    reply = exchange(conn, start)
    if reply.get("type") != "success":
        raise RuntimeError(f"greetd refused session start: {reply}")

print("SWIR_GREETD_E2E_AUTH_SUCCESS", flush=True)
sys.exit(0)
