#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "debian13-graphical-session-vm-e2e.sh must run as root" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="$REPO_ROOT/system/image/system-base-debian-trixie.json"
WORK_ROOT="${SWIR_GRAPHICAL_VM_WORK_ROOT:-/tmp/swir-debian13-graphical-e2e}"
ARTIFACT_DIR="${SWIR_GRAPHICAL_VM_ARTIFACT_DIR:-$WORK_ROOT/artifacts}"
ROOTFS="$WORK_ROOT/rootfs"
DISK="$WORK_ROOT/swir-graphical-uefi.raw"
ROOT_MOUNT="$WORK_ROOT/root-mount"
ESP_MOUNT="$ROOT_MOUNT/boot/efi"
SERIAL_LOG="$ARTIFACT_DIR/serial.log"
EVIDENCE_OUT="$ARTIFACT_DIR/graphical-session-evidence.json"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS_TEMPLATE="/usr/share/OVMF/OVMF_VARS_4M.fd"
OVMF_VARS="$WORK_ROOT/OVMF_VARS_4M.fd"

case "$(readlink -m "$WORK_ROOT")" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var)
    echo "refusing unsafe work root: $WORK_ROOT" >&2; exit 3 ;;
esac
for command in chroot mount umount qemu-system-x86_64 mkfs.ext4 mkfs.vfat rsync timeout grep install stat losetup parted partprobe udevadm python3; do
  command -v "$command" >/dev/null || { echo "missing required host command: $command" >&2; exit 4; }
done
[[ -f "$PROFILE" && ! -L "$PROFILE" ]] || { echo "Debian profile missing" >&2; exit 5; }
[[ -f "$OVMF_CODE" && ! -L "$OVMF_CODE" ]] || { echo "OVMF code firmware missing" >&2; exit 5; }
[[ -f "$OVMF_VARS_TEMPLATE" && ! -L "$OVMF_VARS_TEMPLATE" ]] || { echo "OVMF vars template missing" >&2; exit 5; }
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo "graphical UEFI lane is amd64-only in 0.1" >&2; exit 6; }

rm -rf "$WORK_ROOT"
install -d -m 0700 "$WORK_ROOT" "$ARTIFACT_DIR" "$ROOTFS" "$ROOT_MOUNT"
loop_dev=""
root_mounted=0
esp_mounted=0
rootfs_mounts=0
cleanup() {
  set +e
  if [[ $rootfs_mounts -eq 1 ]]; then
    umount -R "$ROOTFS/dev" 2>/dev/null || true
    umount -R "$ROOTFS/sys" 2>/dev/null || true
    umount "$ROOTFS/proc" 2>/dev/null || true
    rootfs_mounts=0
  fi
  if [[ $esp_mounted -eq 1 ]]; then umount "$ESP_MOUNT" 2>/dev/null || true; esp_mounted=0; fi
  if [[ $root_mounted -eq 1 ]]; then umount "$ROOT_MOUNT" 2>/dev/null || true; root_mounted=0; fi
  if [[ -n "$loop_dev" ]]; then losetup -d "$loop_dev" 2>/dev/null || true; loop_dev=""; fi
}
trap cleanup EXIT

echo "[SWIR] Building Debian 13 graphical System Edition rootfs"
bash "$REPO_ROOT/system/image/build-debian-trixie-rootfs.sh" --rootfs "$ROOTFS" --profile "$PROFILE" --arch amd64
mount -t proc proc "$ROOTFS/proc"
mount --rbind /sys "$ROOTFS/sys"
mount --make-rslave "$ROOTFS/sys"
mount --rbind /dev "$ROOTFS/dev"
mount --make-rslave "$ROOTFS/dev"
rootfs_mounts=1

cat > "$ROOTFS/usr/sbin/policy-rc.d" <<'POLICY'
#!/bin/sh
exit 101
POLICY
chmod 0755 "$ROOTFS/usr/sbin/policy-rc.d"
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  systemd-boot-efi greetd weston plymouth plymouth-themes wayland-utils dbus-user-session
chroot "$ROOTFS" /usr/bin/systemd-machine-id-setup

bash "$REPO_ROOT/system/session/provision-graphical-session.sh" \
  --rootfs "$ROOTFS" --source-root "$REPO_ROOT" --e2e

install -d -m 0700 "$ROOTFS/var/lib/swir/graphical-e2e"

cat > "$ROOTFS/usr/local/lib/swir/plymouth-e2e-proof" <<'GUEST'
#!/bin/sh
set -eu
OUT=/var/lib/swir/graphical-e2e/plymouth.json
THEME="$(/usr/sbin/plymouth-set-default-theme)"
CMDLINE="$(cat /proc/cmdline)"
[ "$THEME" = swir ] || exit 20
printf '%s\n' "$CMDLINE" | grep -Eq '(^| )splash( |$)' || exit 21
printf '%s\n' "$CMDLINE" | grep -Eq '(^| )quiet( |$)' || exit 22
ACTIVE=false
if /usr/bin/plymouth --ping; then ACTIVE=true; fi
[ "$ACTIVE" = true ] || exit 23
python3 - "$OUT" "$THEME" "$CMDLINE" <<'PY'
import json, pathlib, sys
path, theme, cmdline = sys.argv[1:]
pathlib.Path(path).write_text(json.dumps({
  'schema': 'swir.plymouth-boot-evidence/0.1',
  'passed': True,
  'selectedTheme': theme,
  'activeDuringBoot': True,
  'quietSplashKernelCommandLine': True,
  'cmdline': cmdline,
}, sort_keys=True) + '\n', encoding='utf-8')
PY
chmod 0600 "$OUT"
GUEST
chmod 0755 "$ROOTFS/usr/local/lib/swir/plymouth-e2e-proof"

cat > "$ROOTFS/etc/systemd/system/swir-plymouth-e2e-proof.service" <<'UNIT'
[Unit]
Description=SWIR Plymouth boot-splash E2E proof
DefaultDependencies=no
After=plymouth-start.service
Before=plymouth-quit.service plymouth-quit-wait.service greetd.service
Wants=plymouth-start.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/lib/swir/plymouth-e2e-proof

[Install]
WantedBy=multi-user.target
UNIT
install -d -m 0755 "$ROOTFS/etc/systemd/system/multi-user.target.wants"
ln -sfn ../swir-plymouth-e2e-proof.service "$ROOTFS/etc/systemd/system/multi-user.target.wants/swir-plymouth-e2e-proof.service"

cat > "$ROOTFS/usr/local/lib/swir/graphical-e2e-monitor" <<'GUEST'
#!/bin/sh
set -eu
OUTDIR=/var/lib/swir/graphical-e2e
STATUS="$OUTDIR/status.txt"
serial() { printf '%s\n' "$*" > /dev/ttyS0; }
fail() {
  printf 'FAIL:%s\n' "$1" > "$STATUS"
  serial "SWIR_GRAPHICAL_E2E_FAIL $1"
  systemctl --no-pager --full status greetd.service swir-plymouth-e2e-proof.service > /dev/ttyS0 2>&1 || true
  journalctl -b --no-pager -n 160 -u greetd.service -u swir-plymouth-e2e-proof.service > /dev/ttyS0 2>&1 || true
  sync
  systemctl --no-block poweroff
  exit 1
}

systemctl is-active --quiet greetd.service || fail greetd-inactive
systemctl is-active --quiet swir-plymouth-e2e-proof.service || fail plymouth-proof-inactive
[ -s "$OUTDIR/plymouth.json" ] || fail plymouth-evidence-missing
! grep -Fq '[initial_session]' /etc/greetd/config.toml || fail greetd-autologin-used
[ -f /etc/pam.d/greetd ] || fail greetd-pam-missing
grep -Fq 'greetd-e2e-greeter.py' /etc/greetd/config.toml || fail e2e-greeter-not-configured

SESSION_SRC=''
i=0
while [ "$i" -lt 120 ]; do
  for candidate in /run/user/*/swir-graphical-session-evidence.json; do
    if [ -s "$candidate" ]; then SESSION_SRC="$candidate"; break 2; fi
  done
  i=$((i + 1))
  sleep 1
done
[ -n "$SESSION_SRC" ] || fail session-evidence-timeout
cp "$SESSION_SRC" "$OUTDIR/session.json"
chmod 0600 "$OUTDIR/session.json"

python3 - "$OUTDIR/session.json" "$OUTDIR/plymouth.json" <<'PY' || fail evidence-validation
import json, sys
session = json.load(open(sys.argv[1], encoding='utf-8'))
plymouth = json.load(open(sys.argv[2], encoding='utf-8'))
assert session.get('schema') == 'swir.graphical-session-runtime-evidence/0.1'
assert session.get('passed') is True and session.get('user') == 'swir-e2e'
assert session.get('logind', {}).get('service') == 'greetd'
assert session.get('logind', {}).get('remote') == 'no'
assert session.get('wayland', {}).get('compositor') == 'weston'
assert session.get('wayland', {}).get('backend') == 'headless'
assert session.get('wayland', {}).get('socketObserved') is True
assert session.get('wayland', {}).get('clientHandshakePassed') is True
assert session.get('desktopShellClaim') is False
assert plymouth.get('selectedTheme') == 'swir' and plymouth.get('activeDuringBoot') is True
PY

printf 'PASS\n' > "$STATUS"
serial 'SWIR_GRAPHICAL_E2E_PASS plymouth=swir login=greetd pam=true wayland=weston desktop-shell=false'
sync
systemctl --no-block poweroff
GUEST
chmod 0755 "$ROOTFS/usr/local/lib/swir/graphical-e2e-monitor"

cat > "$ROOTFS/etc/systemd/system/swir-graphical-e2e-monitor.service" <<'UNIT'
[Unit]
Description=SWIR graphical login/session E2E monitor
After=greetd.service swir-plymouth-e2e-proof.service
Wants=greetd.service swir-plymouth-e2e-proof.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/swir/graphical-e2e-monitor
TimeoutStartSec=150

[Install]
WantedBy=graphical.target
UNIT
install -d -m 0755 "$ROOTFS/etc/systemd/system/graphical.target.wants"
ln -sfn ../swir-graphical-e2e-monitor.service "$ROOTFS/etc/systemd/system/graphical.target.wants/swir-graphical-e2e-monitor.service"

printf 'LABEL=SWIR_ROOT / ext4 defaults 0 1\nLABEL=SWIR_ESP /boot/efi vfat umask=0077 0 2\n' > "$ROOTFS/etc/fstab"
echo swir-graphical-e2e > "$ROOTFS/etc/hostname"
rm -f "$ROOTFS/usr/sbin/policy-rc.d"

KERNEL="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'vmlinuz-*' | sort -V | tail -n1)"
INITRD="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'initrd.img-*' | sort -V | tail -n1)"
[[ -n "$KERNEL" && -n "$INITRD" ]] || { echo "kernel/initrd missing" >&2; exit 7; }
chroot "$ROOTFS" /usr/bin/lsinitramfs "/boot/$(basename "$INITRD")" | grep -Fq 'usr/share/plymouth/themes/swir/swir.plymouth' || {
  echo "SWIR Plymouth theme is not embedded in initramfs" >&2; exit 7;
}

EFI_SOURCE="$ROOTFS/usr/lib/systemd/boot/efi/systemd-bootx64.efi"
[[ -f "$EFI_SOURCE" && ! -L "$EFI_SOURCE" ]] || { echo "systemd-boot EFI binary missing" >&2; exit 7; }
[[ "$(stat -c '%u' "$EFI_SOURCE")" == 0 ]] || { echo "EFI binary must be root-owned" >&2; exit 7; }
EFI_MODE="$(stat -c '%a' "$EFI_SOURCE")"
(( (8#$EFI_MODE & 8#022) == 0 )) || { echo "EFI binary must not be group/world writable" >&2; exit 7; }

chroot "$ROOTFS" apt-get clean
cleanup
trap cleanup EXIT

truncate -s 8G "$DISK"
loop_dev="$(losetup --find --show --partscan "$DISK")"
parted -s "$loop_dev" mklabel gpt
parted -s "$loop_dev" mkpart ESP fat32 1MiB 513MiB
parted -s "$loop_dev" set 1 esp on
parted -s "$loop_dev" mkpart SWIR_ROOT ext4 513MiB 100%
partprobe "$loop_dev"
udevadm settle
ESP_PART="${loop_dev}p1"
ROOT_PART="${loop_dev}p2"
[[ -b "$ESP_PART" && -b "$ROOT_PART" ]] || { echo "partition devices missing" >&2; exit 8; }
mkfs.vfat -F 32 -n SWIR_ESP "$ESP_PART" >/dev/null
mkfs.ext4 -q -F -L SWIR_ROOT "$ROOT_PART"
mount "$ROOT_PART" "$ROOT_MOUNT"; root_mounted=1
install -d -m 0755 "$ESP_MOUNT"
mount "$ESP_PART" "$ESP_MOUNT"; esp_mounted=1
rsync -aHAX --numeric-ids "$ROOTFS/" "$ROOT_MOUNT/"
install -d -m 0700 "$ESP_MOUNT/loader/entries" "$ESP_MOUNT/EFI/BOOT" "$ESP_MOUNT/EFI/SWIR"
install -m 0644 "$EFI_SOURCE" "$ESP_MOUNT/EFI/BOOT/BOOTX64.EFI"
install -m 0644 "$KERNEL" "$ESP_MOUNT/EFI/SWIR/vmlinuz"
install -m 0644 "$INITRD" "$ESP_MOUNT/EFI/SWIR/initrd.img"
cat > "$ESP_MOUNT/loader/loader.conf" <<'EOF'
default swir
timeout 0
console-mode keep
editor no
EOF
cat > "$ESP_MOUNT/loader/entries/swir.conf" <<'EOF'
title SWIR OS System Edition graphical E2E
linux /EFI/SWIR/vmlinuz
initrd /EFI/SWIR/initrd.img
options root=LABEL=SWIR_ROOT rw quiet splash console=ttyS0,115200n8
EOF
sync
cleanup
trap cleanup EXIT

cp "$OVMF_VARS_TEMPLATE" "$OVMF_VARS"
chmod 0600 "$OVMF_VARS"
set +e
timeout --signal=TERM --kill-after=15s 240s qemu-system-x86_64 \
  -machine q35,accel=tcg \
  -cpu max \
  -m 2048 \
  -smp 2 \
  -drive if=pflash,format=raw,readonly=on,file="$OVMF_CODE" \
  -drive if=pflash,format=raw,file="$OVMF_VARS" \
  -drive file="$DISK",format=raw,if=virtio \
  -device virtio-vga \
  -display none \
  -serial file:"$SERIAL_LOG" \
  -monitor none \
  -no-reboot
QEMU_RC=$?
set -e
[[ $QEMU_RC -eq 0 ]] || { echo "QEMU exited with status $QEMU_RC" >&2; tail -n 120 "$SERIAL_LOG" >&2 || true; exit 9; }
grep -Fq 'SWIR_GRAPHICAL_E2E_PASS' "$SERIAL_LOG" || { echo "graphical pass marker missing" >&2; tail -n 160 "$SERIAL_LOG" >&2 || true; exit 10; }

loop_dev="$(losetup --find --show --partscan "$DISK")"
partprobe "$loop_dev"; udevadm settle
ROOT_PART="${loop_dev}p2"
mount "$ROOT_PART" "$ROOT_MOUNT"; root_mounted=1
for file in status.txt plymouth.json session.json; do
  [[ -s "$ROOT_MOUNT/var/lib/swir/graphical-e2e/$file" ]] || { echo "guest evidence missing: $file" >&2; exit 11; }
  cp "$ROOT_MOUNT/var/lib/swir/graphical-e2e/$file" "$ARTIFACT_DIR/$file"
done
grep -qx PASS "$ARTIFACT_DIR/status.txt" || { echo "guest status is not PASS" >&2; exit 11; }

GREETD_VERSION="$(chroot "$ROOT_MOUNT" dpkg-query -W -f='${Version}' greetd)"
WESTON_VERSION="$(chroot "$ROOT_MOUNT" dpkg-query -W -f='${Version}' weston)"
PLYMOUTH_VERSION="$(chroot "$ROOT_MOUNT" dpkg-query -W -f='${Version}' plymouth)"
python3 - "$ARTIFACT_DIR/session.json" "$ARTIFACT_DIR/plymouth.json" "$EVIDENCE_OUT" "$GREETD_VERSION" "$WESTON_VERSION" "$PLYMOUTH_VERSION" <<'PY'
import json, pathlib, sys
session = json.load(open(sys.argv[1], encoding='utf-8'))
plymouth = json.load(open(sys.argv[2], encoding='utf-8'))
out = {
  'schema': 'swir.system-graphical-session-e2e/0.1',
  'passed': True,
  'base': {'distribution': 'debian', 'majorVersion': 13, 'bootPath': 'uefi-systemd-boot'},
  'bootSplash': {
    'provider': 'plymouth',
    'version': sys.argv[6],
    'theme': plymouth['selectedTheme'],
    'themeEmbeddedInInitramfs': True,
    'activeDuringBoot': plymouth['activeDuringBoot'],
    'quietSplashKernelCommandLine': plymouth['quietSplashKernelCommandLine'],
  },
  'loginManager': {
    'provider': 'greetd',
    'version': sys.argv[4],
    'pamPolicyInstalled': True,
    'interactivePamAuthenticationPassed': True,
    'autologinUsed': False,
    'sessionService': session['logind']['service'],
    'remoteSession': session['logind']['remote'] == 'yes',
  },
  'session': {
    'user': session['user'],
    'uid': session['uid'],
    'logindSessionId': session['sessionId'],
    'waylandCompositor': session['wayland']['compositor'],
    'westonVersion': sys.argv[5],
    'backend': session['wayland']['backend'],
    'waylandSocketObserved': session['wayland']['socketObserved'],
    'waylandClientHandshakePassed': session['wayland']['clientHandshakePassed'],
  },
  'productionDefaults': {
    'greeter': 'agreety',
    'sessionCommand': '/usr/local/bin/swir-session',
    'testCredentialEmbeddedInProductionImage': False,
  },
  'desktopShellClaim': False,
  'secureBootClaim': False,
  'hardwareQualificationClaim': False,
}
pathlib.Path(sys.argv[3]).write_text(json.dumps(out, indent=2, sort_keys=True) + '\n', encoding='utf-8')
PY

python3 - "$EVIDENCE_OUT" <<'PY'
import json, sys
e = json.load(open(sys.argv[1], encoding='utf-8'))
assert e['schema'] == 'swir.system-graphical-session-e2e/0.1' and e['passed'] is True
assert e['base']['bootPath'] == 'uefi-systemd-boot'
assert e['bootSplash']['theme'] == 'swir' and e['bootSplash']['activeDuringBoot'] is True
assert e['bootSplash']['themeEmbeddedInInitramfs'] is True
assert e['loginManager']['provider'] == 'greetd' and e['loginManager']['pamPolicyInstalled'] is True
assert e['loginManager']['interactivePamAuthenticationPassed'] is True and e['loginManager']['autologinUsed'] is False
assert e['loginManager']['remoteSession'] is False and e['loginManager']['sessionService'] == 'greetd'
assert e['session']['waylandCompositor'] == 'weston' and e['session']['backend'] == 'headless'
assert e['session']['waylandSocketObserved'] is True and e['session']['waylandClientHandshakePassed'] is True
assert e['productionDefaults']['testCredentialEmbeddedInProductionImage'] is False
assert e['desktopShellClaim'] is False and e['secureBootClaim'] is False and e['hardwareQualificationClaim'] is False
PY

echo "SWIR Debian 13 graphical login/session UEFI E2E passed"
cat "$EVIDENCE_OUT"
