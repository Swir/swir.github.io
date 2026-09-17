#!/usr/bin/env python3
"""SWIR System Edition peer-credential Polkit authorization broker.

Linux-only. The broker derives the caller PID/UID/GID from SO_PEERCRED, confirms
that UID owns an active local graphical systemd-logind session, asks Polkit for
the exact requested action, and returns a short-lived HMAC-authenticated grant.
The caller never supplies its own Unix identity.
"""

from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REQUEST_SCHEMA = "swir.peer-authorization-request/0.1"
RESPONSE_SCHEMA = "swir.peer-authorization-response/0.1"
PAYLOAD_SCHEMA = "swir.peer-authorization-grant/0.1"
ENVELOPE_SCHEMA = "swir.peer-authorization-envelope/0.1"
ISSUER = "swir-peer-authorization-broker"
AUDIENCE = "swir-system-privileged-services"
DEFAULT_SOCKET = "/run/swir/peer-authorization.sock"
DEFAULT_KEY = "/run/swir/peer-authorization.key"
DEFAULT_PKCHECK = "/usr/bin/pkcheck"
DEFAULT_LOGINCTL = "/usr/bin/loginctl"
MAX_REQUEST_BYTES = 16 * 1024
MAX_COMMAND_OUTPUT = 256 * 1024
MAX_SESSIONS = 64
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SAFE_USER = re.compile(r"^[A-Za-z0-9_.@-]{1,128}$")
PLAN_DIGEST = re.compile(r"^[a-f0-9]{64}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
IFNAME = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
SESSION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

SCOPE_ACTION = {
    "packages.mutate": "org.swir.system.packages.mutate",
    "packages.recover": "org.swir.system.packages.recover",
    "network.activate": "org.swir.system.network.activate",
    "network.deactivate": "org.swir.system.network.deactivate",
    "firmware.update": "org.swir.system.firmware.update",
    "firmware.recover": "org.swir.system.firmware.recover",
}
PACKAGE_OPERATIONS = {"install", "update", "remove"}
GRAPHICAL_TYPES = {"wayland", "x11"}
USER_CLASSES = {"user", "user-early"}


class BrokerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise BrokerError(code, message)


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def safe_text(value: Any, pattern: re.Pattern[str], code: str, message: str) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail(code, message)
    return value


def parse_proc_start_time(pid: int) -> str:
    if not isinstance(pid, int) or pid <= 0:
        fail("INVALID_PEER_PID", "peer pid must be a positive integer")
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError as exc:
        raise BrokerError("PEER_PROCESS_UNAVAILABLE", f"cannot read /proc/{pid}/stat: {exc.strerror}") from exc
    end = text.rfind(") ")
    if end <= 0:
        fail("PEER_PROCESS_INVALID", "could not parse peer process stat")
    fields = text[end + 2 :].strip().split()
    if len(fields) <= 19 or not fields[19].isdigit():
        fail("PEER_PROCESS_INVALID", "peer process start time is unavailable")
    return fields[19]


def validate_trusted_binary(path_value: str, expected: str, test_mode: bool) -> Path:
    path = Path(path_value)
    if not path.is_absolute():
        fail("BINARY_PATH_INVALID", f"binary path must be absolute: {path_value}")
    if not test_mode and str(path) != expected:
        fail("BINARY_NOT_ALLOWLISTED", f"production binary is pinned to {expected}")
    try:
        info = path.lstat()
    except OSError as exc:
        raise BrokerError("BINARY_UNAVAILABLE", f"binary unavailable: {path}: {exc.strerror}") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail("BINARY_UNTRUSTED", f"binary must be a regular non-symlink file: {path}")
    if info.st_mode & 0o022:
        fail("BINARY_UNTRUSTED_MODE", f"binary must not be group/world writable: {path}")
    if not (info.st_mode & 0o111):
        fail("BINARY_NOT_EXECUTABLE", f"binary is not executable: {path}")
    if not test_mode and info.st_uid != 0:
        fail("BINARY_UNTRUSTED_OWNER", f"binary must be root-owned: {path}")
    if not test_mode and path.resolve() != path:
        fail("BINARY_UNTRUSTED_REALPATH", f"binary must resolve exactly to {path}")
    return path


def ensure_secure_parent(path_value: str, test_mode: bool) -> Path:
    parent = Path(path_value).parent
    try:
        info = parent.lstat()
    except OSError as exc:
        raise BrokerError("RUNTIME_DIRECTORY_UNAVAILABLE", f"runtime directory unavailable: {parent}: {exc.strerror}") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail("RUNTIME_DIRECTORY_UNTRUSTED", f"runtime directory must be a real directory: {parent}")
    if info.st_mode & 0o022:
        fail("RUNTIME_DIRECTORY_WRITABLE", f"runtime directory must not be group/world writable: {parent}")
    if not test_mode and info.st_uid != 0:
        fail("RUNTIME_DIRECTORY_OWNER_INVALID", f"runtime directory must be root-owned: {parent}")
    return parent


def load_or_create_key(path_value: str, test_mode: bool) -> bytes:
    ensure_secure_parent(path_value, test_mode)
    path = Path(path_value)
    expected_uid = os.geteuid() if test_mode else 0
    try:
        info = path.lstat()
    except FileNotFoundError:
        key = secrets.token_bytes(32)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        fd = os.open(path, flags, 0o600)
        try:
            os.write(fd, key)
            os.fsync(fd)
        finally:
            os.close(fd)
        info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        fail("AUTH_KEY_UNTRUSTED", "authorization key must be a regular non-symlink file")
    if info.st_uid != expected_uid:
        fail("AUTH_KEY_OWNER_INVALID", "authorization key owner is invalid")
    if stat.S_IMODE(info.st_mode) != 0o600:
        fail("AUTH_KEY_MODE_INVALID", "authorization key mode must be exactly 0600")
    key = path.read_bytes()
    if len(key) != 32:
        fail("AUTH_KEY_LENGTH_INVALID", "authorization key must contain exactly 32 bytes")
    return key


def run_command(binary: Path, args: list[str], timeout: float = 10.0) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            [str(binary), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise BrokerError("NATIVE_COMMAND_TIMEOUT", f"{binary.name} timed out") from exc
    if len(result.stdout.encode("utf-8")) > MAX_COMMAND_OUTPUT or len(result.stderr.encode("utf-8")) > MAX_COMMAND_OUTPUT:
        fail("NATIVE_COMMAND_OUTPUT_TOO_LARGE", f"{binary.name} output exceeded limit")
    return result


def parse_properties(text: str) -> dict[str, str]:
    props: dict[str, str] = {}
    for raw in text.splitlines():
        if "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key):
            props[key] = value.strip()[:1024]
    return props


@dataclass(frozen=True)
class SessionActor:
    session_id: str
    uid: int
    username: str
    seat: str | None
    session_type: str


def resolve_active_session(loginctl: Path, uid: int) -> SessionActor:
    listed = run_command(loginctl, ["list-sessions", "--no-legend", "--no-pager"])
    if listed.returncode != 0:
        fail("LOGIND_LIST_FAILED", "loginctl list-sessions failed")
    session_ids: list[str] = []
    for line in listed.stdout.splitlines():
        first = line.strip().split(maxsplit=1)[0] if line.strip() else ""
        if SESSION_ID.fullmatch(first) and first not in session_ids:
            session_ids.append(first)
            if len(session_ids) >= MAX_SESSIONS:
                break
    candidates: list[SessionActor] = []
    properties = [
        "--no-pager", "--property=Id", "--property=User", "--property=Name",
        "--property=Remote", "--property=Active", "--property=State",
        "--property=Type", "--property=Class", "--property=Seat",
    ]
    for session_id in session_ids:
        result = run_command(loginctl, ["show-session", session_id, *properties])
        if result.returncode != 0:
            continue
        props = parse_properties(result.stdout)
        if props.get("Id") != session_id:
            continue
        if props.get("User") != str(uid):
            continue
        username = props.get("Name", "")
        session_type = props.get("Type", "").lower()
        session_class = props.get("Class", "").lower()
        if not SAFE_USER.fullmatch(username):
            continue
        if props.get("Active", "").lower() != "yes" or props.get("Remote", "").lower() == "yes":
            continue
        if props.get("State", "").lower() != "active":
            continue
        if session_type not in GRAPHICAL_TYPES or session_class not in USER_CLASSES:
            continue
        seat = props.get("Seat") or None
        candidates.append(SessionActor(session_id, uid, username, seat, session_type))
    if not candidates:
        fail("NO_ACTIVE_LOCAL_SESSION", "peer uid has no active local graphical session")
    candidates.sort(key=lambda item: (0 if item.seat == "seat0" else 1, 0 if item.session_type == "wayland" else 1, item.session_id))
    return candidates[0]


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("schema") != REQUEST_SCHEMA:
        fail("INVALID_REQUEST_SCHEMA", f"request schema must be {REQUEST_SCHEMA}")
    scope = value.get("scope")
    if scope not in SCOPE_ACTION:
        fail("UNSUPPORTED_SCOPE", "unsupported authorization scope")
    plan_digest = safe_text(value.get("planDigest"), PLAN_DIGEST, "INVALID_PLAN_DIGEST", "planDigest must be lowercase SHA-256")
    allow_interaction = value.get("allowUserInteraction", False)
    if not isinstance(allow_interaction, bool):
        fail("INVALID_INTERACTION_FLAG", "allowUserInteraction must be boolean")
    request: dict[str, Any] = {
        "schema": REQUEST_SCHEMA,
        "scope": scope,
        "planDigest": plan_digest,
        "allowUserInteraction": allow_interaction,
    }
    if scope.startswith("packages."):
        request["domain"] = "packages"
        request["packageId"] = safe_text(value.get("packageId"), SAFE_ID, "INVALID_PACKAGE_ID", "invalid packageId")
        operation = value.get("operation")
        if operation not in PACKAGE_OPERATIONS:
            fail("INVALID_PACKAGE_OPERATION", "package operation must be install, update, or remove")
        request["operation"] = operation
    elif scope.startswith("network."):
        request["domain"] = "network"
        request["connectionUuid"] = safe_text(value.get("connectionUuid"), UUID, "INVALID_CONNECTION_UUID", "invalid connection UUID")
        expected_operation = scope.split(".", 1)[1]
        if value.get("operation") not in (None, expected_operation):
            fail("NETWORK_OPERATION_SCOPE_MISMATCH", "network operation does not match scope")
        request["operation"] = expected_operation
        ifname = value.get("ifname")
        if ifname is not None:
            request["ifname"] = safe_text(ifname, IFNAME, "INVALID_INTERFACE_NAME", "invalid interface name")
        else:
            request["ifname"] = None
    else:
        request["domain"] = "firmware"
        request["deviceId"] = safe_text(value.get("deviceId"), SAFE_ID, "INVALID_DEVICE_ID", "invalid deviceId")
        expected_operation = scope.split(".", 1)[1]
        if value.get("operation") not in (None, expected_operation):
            fail("FIRMWARE_OPERATION_SCOPE_MISMATCH", "firmware operation does not match scope")
        request["operation"] = expected_operation
        release_id = value.get("releaseId")
        if release_id is not None:
            request["releaseId"] = safe_text(release_id, SAFE_ID, "INVALID_RELEASE_ID", "invalid releaseId")
        else:
            request["releaseId"] = None
    return request


def pkcheck_args(request: dict[str, Any], pid: int, uid: int, start_time: str) -> list[str]:
    args = [
        "--action-id", SCOPE_ACTION[request["scope"]],
        "--process", f"{pid},{start_time},{uid}",
        "--detail", "swir.planDigest", request["planDigest"],
    ]
    if request["domain"] == "packages":
        args += [
            "--detail", "swir.scope", request["scope"],
            "--detail", "swir.packageId", request["packageId"],
            "--detail", "swir.operation", request["operation"],
        ]
    elif request["domain"] == "network":
        args += [
            "--detail", "swir.connectionUuid", request["connectionUuid"],
            "--detail", "swir.operation", request["operation"],
        ]
        if request.get("ifname"):
            args += ["--detail", "swir.ifname", request["ifname"]]
    else:
        args += [
            "--detail", "swir.deviceId", request["deviceId"],
            "--detail", "swir.operation", request["operation"],
        ]
        if request.get("releaseId"):
            args += ["--detail", "swir.releaseId", request["releaseId"]]
    if request["allowUserInteraction"]:
        args.append("--allow-user-interaction")
    return args


def make_envelope(request: dict[str, Any], actor: SessionActor, pid: int, uid: int, gid: int, start_time: str, ttl: int, key: bytes) -> dict[str, Any]:
    now_ms = int(time.time() * 1000)
    payload: dict[str, Any] = {
        "schema": PAYLOAD_SCHEMA,
        "issuer": ISSUER,
        "audience": AUDIENCE,
        "grantId": secrets.token_urlsafe(24),
        "authorized": True,
        "scope": request["scope"],
        "actionId": SCOPE_ACTION[request["scope"]],
        "planDigest": request["planDigest"],
        "operation": request["operation"],
        "actorId": f"uid:{uid}",
        "subject": {"pid": pid, "uid": uid, "gid": gid, "startTime": start_time},
        "session": {
            "id": actor.session_id,
            "uid": actor.uid,
            "username": actor.username,
            "seat": actor.seat,
            "type": actor.session_type,
            "local": True,
            "active": True,
        },
        "interactive": request["allowUserInteraction"],
        "issuedAtMs": now_ms,
        "expiresAtMs": now_ms + ttl * 1000,
    }
    if request["domain"] == "packages":
        payload["packageId"] = request["packageId"]
    elif request["domain"] == "network":
        payload["connectionUuid"] = request["connectionUuid"]
        payload["ifname"] = request.get("ifname")
    else:
        payload["deviceId"] = request["deviceId"]
        payload["releaseId"] = request.get("releaseId")
    mac = hmac.new(key, canonical_json(payload), hashlib.sha256).hexdigest()
    return {"schema": ENVELOPE_SCHEMA, "payload": payload, "mac": mac}


def response_error(code: str, message: str, *, denied: bool = False) -> dict[str, Any]:
    return {"schema": RESPONSE_SCHEMA, "authorized": False, "denied": denied, "error": {"code": code, "message": message[:300]}}


def handle_connection(conn: socket.socket, key: bytes, pkcheck: Path, loginctl: Path, ttl: int) -> dict[str, Any]:
    conn.settimeout(40.0)
    if not hasattr(socket, "SO_PEERCRED"):
        fail("SO_PEERCRED_UNAVAILABLE", "Linux SO_PEERCRED is unavailable")
    raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", raw)
    if pid <= 0 or uid <= 0 or gid < 0:
        fail("PEER_IDENTITY_INVALID", "peer credentials are invalid or privileged root")
    start_time = parse_proc_start_time(pid)
    actor = resolve_active_session(loginctl, uid)
    if actor.uid != uid:
        fail("SESSION_UID_MISMATCH", "active session uid does not match socket peer uid")

    data = bytearray()
    while len(data) <= MAX_REQUEST_BYTES:
        chunk = conn.recv(min(4096, MAX_REQUEST_BYTES + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in chunk:
            break
    if len(data) > MAX_REQUEST_BYTES:
        fail("REQUEST_TOO_LARGE", "authorization request exceeded size limit")
    if b"\n" not in data:
        fail("REQUEST_TERMINATOR_MISSING", "authorization request must be newline terminated")
    line, trailing = bytes(data).split(b"\n", 1)
    if trailing.strip():
        fail("MULTIPLE_REQUESTS_FORBIDDEN", "one authorization request is allowed per connection")
    try:
        parsed = json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BrokerError("REQUEST_JSON_INVALID", "authorization request is not valid UTF-8 JSON") from exc
    request = validate_request(parsed)

    args = pkcheck_args(request, pid, uid, start_time)
    result = run_command(pkcheck, args, timeout=30.0)
    if result.returncode != 0:
        code = "not-authorized" if result.returncode == 1 else "authorization-check-failed"
        return response_error(code, "Polkit did not authorize the peer subject", denied=result.returncode == 1)

    if parse_proc_start_time(pid) != start_time:
        fail("PEER_PROCESS_CHANGED", "peer process identity changed during authorization")
    envelope = make_envelope(request, actor, pid, uid, gid, start_time, ttl, key)
    return {"schema": RESPONSE_SCHEMA, "authorized": True, "envelope": envelope}


def send_response(conn: socket.socket, value: dict[str, Any]) -> None:
    data = canonical_json(value) + b"\n"
    if len(data) > MAX_REQUEST_BYTES:
        data = canonical_json(response_error("RESPONSE_TOO_LARGE", "broker response exceeded size limit")) + b"\n"
    conn.sendall(data)


def activated_socket() -> socket.socket | None:
    try:
        listen_pid = int(os.environ.get("LISTEN_PID", "0"))
        listen_fds = int(os.environ.get("LISTEN_FDS", "0"))
    except ValueError:
        return None
    if listen_pid != os.getpid() or listen_fds != 1:
        return None
    sock = socket.fromfd(3, socket.AF_UNIX, socket.SOCK_STREAM)
    sock.setblocking(True)
    return sock


def standalone_socket(path_value: str, test_mode: bool) -> socket.socket:
    ensure_secure_parent(path_value, test_mode)
    path = Path(path_value)
    try:
        info = path.lstat()
    except FileNotFoundError:
        info = None
    if info is not None:
        expected_uid = os.geteuid() if test_mode else 0
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != expected_uid:
            fail("STALE_SOCKET_UNTRUSTED", "refusing to replace non-socket or foreign socket path")
        path.unlink()
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(str(path))
    os.chmod(path, 0o666)
    sock.listen(64)
    return sock


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SWIR SO_PEERCRED Polkit authorization broker")
    parser.add_argument("--socket-path", default=DEFAULT_SOCKET)
    parser.add_argument("--key-path", default=DEFAULT_KEY)
    parser.add_argument("--pkcheck-path", default=DEFAULT_PKCHECK)
    parser.add_argument("--loginctl-path", default=DEFAULT_LOGINCTL)
    parser.add_argument("--ttl-seconds", type=int, default=10)
    parser.add_argument("--test-mode", action="store_true", help="allow non-production paths/owners for isolated self-tests")
    parser.add_argument("--once", action="store_true", help="serve a single connection then exit")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not 2 <= args.ttl_seconds <= 30:
        print("ttl must be between 2 and 30 seconds", file=sys.stderr)
        return 2
    if not args.test_mode and os.geteuid() != 0:
        print("production broker must run as root", file=sys.stderr)
        return 2
    try:
        pkcheck = validate_trusted_binary(args.pkcheck_path, DEFAULT_PKCHECK, args.test_mode)
        loginctl = validate_trusted_binary(args.loginctl_path, DEFAULT_LOGINCTL, args.test_mode)
        key = load_or_create_key(args.key_path, args.test_mode)
        server = activated_socket()
        owns_socket = server is None
        if server is None:
            server = standalone_socket(args.socket_path, args.test_mode)
    except BrokerError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 2

    stopping = False

    def stop(_signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
        try:
            server.close()
        except OSError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    served = 0
    try:
        while not stopping:
            try:
                conn, _ = server.accept()
            except OSError as exc:
                if stopping or exc.errno in (errno.EBADF, errno.EINVAL):
                    break
                raise
            with conn:
                try:
                    result = handle_connection(conn, key, pkcheck, loginctl, args.ttl_seconds)
                except BrokerError as exc:
                    result = response_error(exc.code, str(exc))
                except Exception:
                    result = response_error("BROKER_INTERNAL_ERROR", "authorization broker failed closed")
                try:
                    send_response(conn, result)
                except OSError:
                    pass
            served += 1
            if args.once and served >= 1:
                break
    finally:
        try:
            server.close()
        except OSError:
            pass
        if owns_socket:
            try:
                path = Path(args.socket_path)
                if path.exists() and stat.S_ISSOCK(path.lstat().st_mode):
                    path.unlink()
            except OSError:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
