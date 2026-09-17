#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "debian13-system-shell-vm-e2e.sh must run as root" >&2; exit 2; fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK_ROOT="${SWIR_SYSTEM_SHELL_VM_WORK_ROOT:-/tmp/swir-debian13-system-shell-e2e}"
ARTIFACT_DIR="${SWIR_SYSTEM_SHELL_VM_ARTIFACT_DIR:-$WORK_ROOT/artifacts}"
DISK="$WORK_ROOT/swir-graphical-uefi.raw"
ROOT_MOUNT="$WORK_ROOT/shell-proof-root"
EVIDENCE_OUT="$ARTIFACT_DIR/system-desktop-shell-evidence.json"
GUEST_EVIDENCE_REL="home/swir-e2e/.local/state/swir/system-desktop-shell-evidence.json"
case "$(readlink -m "$WORK_ROOT")" in /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var) echo "refusing unsafe work root: $WORK_ROOT" >&2; exit 3 ;; esac
for command in losetup mount umount sha256sum stat python3 grep; do command -v "$command" >/dev/null || { echo "missing required host command: $command" >&2; exit 4; }; done
export SWIR_GRAPHICAL_VM_WORK_ROOT="$WORK_ROOT"
export SWIR_GRAPHICAL_VM_ARTIFACT_DIR="$ARTIFACT_DIR"
bash "$REPO_ROOT/system/e2e/debian13-graphical-session-vm-e2e.sh"
[[ -f "$DISK" && ! -L "$DISK" ]] || { echo "graphical E2E disk was not retained" >&2; exit 5; }
install -d -m 0700 "$ROOT_MOUNT"
loop_dev=""; mounted=0
cleanup() { set +e; if [[ $mounted -eq 1 ]]; then umount "$ROOT_MOUNT" 2>/dev/null || true; mounted=0; fi; if [[ -n "$loop_dev" ]]; then losetup -d "$loop_dev" 2>/dev/null || true; loop_dev=""; fi; }
trap cleanup EXIT
loop_dev="$(losetup --find --show --partscan --read-only "$DISK")"
ROOT_PART="${loop_dev}p2"
[[ -b "$ROOT_PART" ]] || { echo "SWIR_ROOT partition missing from retained disk" >&2; exit 6; }
mount -o ro,noload "$ROOT_PART" "$ROOT_MOUNT"; mounted=1
GUEST_EVIDENCE="$ROOT_MOUNT/$GUEST_EVIDENCE_REL"
SHELL_ROOT="$ROOT_MOUNT/usr/share/swir-shell"
COG_BIN="$ROOT_MOUNT/usr/bin/cog"
[[ -s "$GUEST_EVIDENCE" && ! -L "$GUEST_EVIDENCE" ]] || { echo "desktop-shell guest evidence missing" >&2; exit 7; }
[[ -d "$SHELL_ROOT" && ! -L "$SHELL_ROOT" ]] || { echo "staged SWIR shell bundle missing" >&2; exit 7; }
[[ -f "$SHELL_ROOT/swir-desktop.html" && ! -L "$SHELL_ROOT/swir-desktop.html" ]] || { echo "staged SWIR shell entry missing" >&2; exit 7; }
[[ -f "$SHELL_ROOT/.swir-integrity.sha256" && ! -L "$SHELL_ROOT/.swir-integrity.sha256" ]] || { echo "shell integrity manifest missing" >&2; exit 7; }
[[ -x "$COG_BIN" && ! -L "$COG_BIN" ]] || { echo "trusted Cog executable missing" >&2; exit 7; }
[[ "$(stat -c '%u' "$COG_BIN")" == 0 ]] || { echo "Cog executable is not root-owned" >&2; exit 8; }
COG_MODE="$(stat -c '%a' "$COG_BIN")"; (( (8#$COG_MODE & 8#022) == 0 )) || { echo "Cog executable is writable by group/world" >&2; exit 8; }
( cd "$SHELL_ROOT"; sha256sum -c --strict .swir-integrity.sha256 >/dev/null )
grep -Fq '<main id="os-shell"' "$SHELL_ROOT/swir-desktop.html" || { echo "SWIR desktop shell DOM root missing" >&2; exit 9; }
grep -Fq './swir-platform-bridge.js' "$SHELL_ROOT/swir-desktop.html" || { echo "SWIR native/platform bridge integration missing from shell" >&2; exit 9; }
cp "$GUEST_EVIDENCE" "$EVIDENCE_OUT"
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$EVIDENCE_OUT" 2>/dev/null || true
chmod 0600 "$EVIDENCE_OUT"
python3 - "$EVIDENCE_OUT" "$SHELL_ROOT/.swir-integrity.sha256" <<'PY'
import hashlib, json, pathlib, sys
path = pathlib.Path(sys.argv[1]); manifest = pathlib.Path(sys.argv[2]); e = json.loads(path.read_text(encoding='utf-8'))
assert e.get('schema') == 'swir.system-desktop-shell-e2e/0.1' and e.get('passed') is True
assert e.get('user') == 'swir-e2e' and int(e.get('uid', 0)) >= 1000
assert e.get('sessionService') == 'greetd' and e.get('remoteSession') is False
assert e.get('waylandCompositor') == 'weston' and e.get('waylandBackend') == 'headless'
assert e.get('runtime') == 'cog-wpe-webkit' and e.get('runtimePackage') == 'cog'
assert e.get('runtimeUidMatchesSession') is True and e.get('webProcessObserved') is True
assert e.get('shellEntry') == '/usr/share/swir-shell/swir-desktop.html'
assert len(e.get('shellEntrySha256', '')) == 64 and len(e.get('integrityManifestSha256', '')) == 64
assert e.get('shellAssetCount', 0) >= 20 and e.get('shellIntegrityVerified') is True
assert e.get('localFileOrigin') is True and e.get('authenticatedGraphicalSession') is True
assert e.get('secureBootClaim') is False and e.get('hardwareQualificationClaim') is False
actual_manifest_sha = hashlib.sha256(manifest.read_bytes()).hexdigest(); assert e['integrityManifestSha256'] == actual_manifest_sha
assert e['shellAssetCount'] == len([line for line in manifest.read_text(encoding='utf-8').splitlines() if line.strip()])
PY
echo "SWIR Debian 13 System Desktop Shell UEFI E2E passed"
cat "$EVIDENCE_OUT"
