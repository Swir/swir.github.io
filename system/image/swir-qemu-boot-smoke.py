#!/usr/bin/python3
"""Read-only in-guest boot probe for the disposable SWIR System Edition QEMU image."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time

SCHEMA = "swir.system-qemu-boot-e2e/0.1"
SERIAL = pathlib.Path("/dev/ttyS0")
REPORT = pathlib.Path("/run/swir/qemu-boot-e2e.json")
REQUIRED_FILES = (
    "/etc/swir/repository-trust-policy.json",
    "/usr/share/polkit-1/actions/org.swir.system.packages.policy",
    "/usr/share/polkit-1/actions/org.swir.system.network.policy",
    "/usr/share/polkit-1/actions/org.swir.system.firmware.policy",
    "/usr/lib/systemd/system/swir-peer-authorization.socket",
    "/usr/lib/systemd/system/swir-peer-authorization.service",
    "/usr/libexec/swir/swir-peer-authorization-broker",
)
REQUIRED_ACTIVE_UNITS = (
    "dbus.service",
    "systemd-logind.service",
    "NetworkManager.service",
    "swir-peer-authorization.socket",
)


def serial_write(message: str) -> None:
    line = f"{message}\n"
    try:
        with SERIAL.open("a", encoding="utf-8", buffering=1) as stream:
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
    except OSError:
        sys.stderr.write(line)
        sys.stderr.flush()


def command(args: list[str], timeout: int = 10) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=False,
        shell=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
    )


def os_release() -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in pathlib.Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
        if "=" not in raw or raw.startswith("#"):
            continue
        key, value = raw.split("=", 1)
        result[key] = value.strip().strip('"')
    return result


def main() -> int:
    checks: list[dict[str, object]] = []

    release = os_release()
    checks.append({
        "id": "debian-13",
        "passed": release.get("ID") == "debian" and release.get("VERSION_ID", "").split(".", 1)[0] == "13",
        "detail": {"id": release.get("ID"), "versionId": release.get("VERSION_ID")},
    })

    for name in REQUIRED_FILES:
        item = pathlib.Path(name)
        checks.append({
            "id": f"file:{name}",
            "passed": item.is_file() and not item.is_symlink(),
            "detail": {"exists": item.exists(), "symlink": item.is_symlink()},
        })

    for unit in REQUIRED_ACTIVE_UNITS:
        result = command(["/usr/bin/systemctl", "is-active", unit])
        checks.append({
            "id": f"unit:{unit}",
            "passed": result.returncode == 0 and result.stdout.strip() == "active",
            "detail": {"exitCode": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()[:256]},
        })

    expected_tools = (
        "/usr/bin/loginctl",
        "/usr/bin/pkcheck",
        "/usr/bin/nmcli",
        "/usr/bin/fwupdmgr",
        "/usr/bin/apt-get",
        "/usr/bin/python3",
    )
    for name in expected_tools:
        target = pathlib.Path(name)
        checks.append({
            "id": f"tool:{name}",
            "passed": target.exists() and os.access(target, os.X_OK),
            "detail": {"exists": target.exists(), "executable": os.access(target, os.X_OK)},
        })

    key_path = pathlib.Path("/run/swir/peer-authorization.key")
    checks.append({
        "id": "peer-runtime-key-not-prebaked",
        "passed": not key_path.exists(),
        "detail": {"existsBeforeBrokerActivation": key_path.exists()},
    })

    blockers = [str(check["id"]) for check in checks if not check["passed"]]
    report = {
        "schema": SCHEMA,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "readOnlyProbe": True,
        "directKernelBootHarness": True,
        "bootloaderVerified": False,
        "secureBootVerified": False,
        "hardwareQualified": False,
        "ready": not blockers,
        "checks": checks,
        "blockers": blockers,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    REPORT.write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")

    if blockers:
        serial_write("SWIR_QEMU_BOOT_E2E_FAIL " + ",".join(blockers))
        return 2

    serial_write("SWIR_QEMU_BOOT_E2E_OK schema=swir.system-qemu-boot-e2e/0.1")
    return 0


if __name__ == "__main__":
    exit_code = 1
    try:
        exit_code = main()
    except Exception as exc:  # Fail closed and leave evidence on the serial console.
        serial_write(f"SWIR_QEMU_BOOT_E2E_ERROR {type(exc).__name__}: {exc}")
        exit_code = 1
    finally:
        # This file only exists in disposable CI guest images. Power off after the probe so the
        # host can distinguish a completed guest run from a hung boot without interactive login.
        try:
            subprocess.run(
                ["/usr/bin/systemctl", "poweroff", "--no-block"],
                check=False,
                shell=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            )
        except Exception:
            pass
    raise SystemExit(exit_code)
