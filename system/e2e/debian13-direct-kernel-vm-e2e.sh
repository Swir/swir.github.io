#!/usr/bin/env bash
set -euo pipefail

# Disposable, offline-at-boot System Edition base E2E. The host build stage uses
# only Debian's signed repositories; the guest has no network device.
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "debian13-direct-kernel-vm-e2e.sh must run as root" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="$REPO_ROOT/system/image/debian13-base-image-profile.json"
WORK_ROOT="${SWIR_VM_WORK_ROOT:-/tmp/swir-debian13-vm-e2e}"
ARTIFACT_DIR="${SWIR_VM_ARTIFACT_DIR:-$WORK_ROOT/artifacts}"
ROOTFS="$WORK_ROOT/rootfs"
DISK="$WORK_ROOT/swir-system-e2e.ext4"
MOUNT_DIR="$WORK_ROOT/disk-mount"
SERIAL_LOG="$ARTIFACT_DIR/serial.log"
READINESS_OUT="$ARTIFACT_DIR/readiness.json"
PROVISION_OUT="$ARTIFACT_DIR/provisioning.json"
PEER_PROVISION_OUT="$ARTIFACT_DIR/peer-authorization-provisioning.json"

case "$(readlink -m "$WORK_ROOT")" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var)
    echo "refusing unsafe work root: $WORK_ROOT" >&2; exit 3 ;;
esac

for command in debootstrap chroot mount umount mountpoint node qemu-system-x86_64 mkfs.ext4 rsync timeout grep install dpkg; do
  command -v "$command" >/dev/null || { echo "missing required host command: $command" >&2; exit 4; }
done
[[ -f /usr/share/keyrings/debian-archive-keyring.gpg ]] || { echo "Debian archive keyring missing on build host" >&2; exit 5; }
[[ "$(dpkg --print-architecture)" == "amd64" ]] || { echo "current VM lane is native amd64 only" >&2; exit 6; }
node "$REPO_ROOT/system/image/validate-debian13-base-image-profile.mjs"

rm -rf "$WORK_ROOT"
install -d -m 0700 "$WORK_ROOT" "$ARTIFACT_DIR" "$ROOTFS" "$MOUNT_DIR"
mounted=0
rootfs_mounts=0
cleanup() {
  set +e
  if [[ $rootfs_mounts -eq 1 ]]; then
    umount -R "$ROOTFS/dev" 2>/dev/null || true
    umount -R "$ROOTFS/sys" 2>/dev/null || true
    umount "$ROOTFS/proc" 2>/dev/null || true
    rootfs_mounts=0
  fi
  if [[ $mounted -eq 1 ]]; then umount "$MOUNT_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "[SWIR] Building signed Debian 13 rootfs"
debootstrap --variant=minbase --arch=amd64 --keyring=/usr/share/keyrings/debian-archive-keyring.gpg trixie "$ROOTFS" https://deb.debian.org/debian

cat > "$ROOTFS/etc/apt/sources.list" <<'EOF'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main non-free-firmware
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie-updates main non-free-firmware
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://security.debian.org/debian-security trixie-security main non-free-firmware
EOF
install -d -m 0755 "$ROOTFS/etc/apt/sources.list.d"
find "$ROOTFS/etc/apt/sources.list.d" -mindepth 1 -maxdepth 1 -type f -delete
cat > "$ROOTFS/usr/sbin/policy-rc.d" <<'EOF'
#!/bin/sh
exit 101
EOF
chmod 0755 "$ROOTFS/usr/sbin/policy-rc.d"

mount -t proc proc "$ROOTFS/proc"
mount --rbind /sys "$ROOTFS/sys"
mount --make-rslave "$ROOTFS/sys"
mount --rbind /dev "$ROOTFS/dev"
mount --make-rslave "$ROOTFS/dev"
rootfs_mounts=1

mapfile -t PACKAGES < <(node -e "const p=require(process.argv[1]); for (const x of [...p.requiredPackages,...p.hybridFoundationPackages,p.kernelPackages.amd64]) console.log(x)" "$PROFILE")
PACKAGES+=(debian-archive-keyring python3)
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"

# This is a fresh disposable VM instance, not a distributable golden image.
# Give only this test instance a valid machine identity so D-Bus/logind exercise
# their real boot path. A future reusable image builder must reset machine-id
# before distribution and regenerate it on first boot.
chroot "$ROOTFS" /usr/bin/systemd-machine-id-setup

REPO_POLICY="$WORK_ROOT/repository-trust-policy.json"
cat > "$REPO_POLICY" <<'EOF'
{
  "schema": "swir.system-repository-trust-policy/0.1",
  "defaultRepositoryId": "debian-main",
  "repositories": [
    {"id":"debian-main","manager":"apt","nativeId":"deb.debian.org/debian:trixie","sourceClass":"distribution-repository","distributions":["debian"],"signatureVerification":"native-required","allowInsecure":false,"enabled":true},
    {"id":"debian-security","manager":"apt","nativeId":"security.debian.org/debian-security:trixie-security","sourceClass":"distribution-repository","distributions":["debian"],"signatureVerification":"native-required","allowInsecure":false,"enabled":true}
  ]
}
EOF

node "$REPO_ROOT/system/image/system-image-provisioning-cli.mjs" stage \
  --rootfs "$ROOTFS" --source-root "$REPO_ROOT" --repository-policy "$REPO_POLICY" --production --compact > "$PROVISION_OUT"
node --input-type=module - "$REPO_ROOT" "$ROOTFS" > "$PEER_PROVISION_OUT" <<'EOF'
import path from 'node:path';
const [repoRoot, rootfs] = process.argv.slice(2);
const mod = await import(`file://${path.join(repoRoot, 'system/image/system-peer-authorization-provisioning.mjs')}`);
const report = await mod.stagePeerAuthorizationFoundation({ rootfs, sourceRoot: repoRoot, production: true });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ready) process.exit(2);
EOF

install -d -m 0755 "$ROOTFS/opt/swir/system/image" "$ROOTFS/usr/local/lib/swir" "$ROOTFS/var/lib/swir/vm-e2e"
install -m 0644 "$REPO_ROOT/system/image/system-image-readiness.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness.mjs"
install -m 0755 "$REPO_ROOT/system/image/system-image-readiness-probe.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness-probe.mjs"
install -m 0644 "$PROFILE" "$ROOTFS/opt/swir/system/image/debian13-base-image-profile.json"

cat > "$ROOTFS/usr/local/lib/swir/vm-e2e-run" <<'EOF'
#!/bin/sh
set -eu
OUT=/var/lib/swir/vm-e2e/readiness.json
STATUS=/var/lib/swir/vm-e2e/status.txt
serial() { printf '%s\n' "$*" > /dev/ttyS0; }
diag() {
  serial "SWIR_VM_DIAGNOSTICS_BEGIN reason=$1"
  systemctl --no-pager --full status dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket > /dev/ttyS0 2>&1 || true
  journalctl -b --no-pager -n 160 -u dbus.service -u systemd-logind.service -u NetworkManager.service -u swir-peer-authorization.socket > /dev/ttyS0 2>&1 || true
  { printf 'runtime-root='; stat -c '%u:%g:%a' / 2>/dev/null || true; } > /dev/ttyS0
  { printf 'machine-id='; cat /etc/machine-id 2>/dev/null || true; } > /dev/ttyS0
  ls -ld / /run/dbus /run/swir /run/swir/peer-authorization.sock > /dev/ttyS0 2>&1 || true
  getent passwd messagebus > /dev/ttyS0 2>&1 || true
  serial "SWIR_VM_DIAGNOSTICS_END"
}
fail() { printf 'FAIL:%s\n' "$1" > "$STATUS"; diag "$1"; serial "SWIR_VM_E2E_FAIL $1"; sync; systemctl --no-block poweroff; exit 1; }
[ "$(stat -c '%u:%g:%a' /)" = '0:0:755' ] || fail runtime-root-mode
node /opt/swir/system/image/system-image-readiness-probe.mjs --compact > "$OUT" || fail readiness-probe
node -e "const r=require(process.argv[1]); if(!r.summary?.systemImageReadyForE2E) process.exit(2)" "$OUT" || fail readiness-gates
systemctl is-active --quiet dbus.service || fail dbus
systemctl is-active --quiet systemd-logind.service || fail logind
systemctl is-active --quiet NetworkManager.service || fail networkmanager
systemctl is-active --quiet swir-peer-authorization.socket || fail peer-authorization-socket
/usr/bin/loginctl list-sessions --no-legend >/dev/null || fail loginctl
/usr/bin/nmcli -t general status >/dev/null || fail nmcli
[ -x /usr/bin/fwupdmgr ] || fail fwupd-binary
[ -x /usr/bin/flatpak ] || fail flatpak-binary
([ -x /usr/bin/wine ] || [ -x /usr/bin/wine64 ]) || fail wine-binary
printf 'PASS\n' > "$STATUS"
serial 'SWIR_VM_E2E_PASS debian=13 direct-kernel=true network=disabled'
sync
systemctl --no-block poweroff
EOF
chmod 0755 "$ROOTFS/usr/local/lib/swir/vm-e2e-run"

cat > "$ROOTFS/etc/systemd/system/swir-vm-e2e.service" <<'EOF'
[Unit]
Description=SWIR disposable System Edition VM E2E gate
After=dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket
Wants=dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket
ConditionPathExists=/opt/swir/system/image/system-image-readiness-probe.mjs

[Service]
Type=oneshot
ExecStart=/usr/local/lib/swir/vm-e2e-run
TimeoutStartSec=90

[Install]
WantedBy=multi-user.target
EOF
install -d -m 0755 "$ROOTFS/etc/systemd/system/multi-user.target.wants" "$ROOTFS/etc/systemd/system/sockets.target.wants"
ln -sf ../swir-vm-e2e.service "$ROOTFS/etc/systemd/system/multi-user.target.wants/swir-vm-e2e.service"
ln -sf /usr/lib/systemd/system/swir-peer-authorization.socket "$ROOTFS/etc/systemd/system/sockets.target.wants/swir-peer-authorization.socket"
printf '/dev/vda / ext4 defaults 0 1\n' > "$ROOTFS/etc/fstab"
echo swir-e2e > "$ROOTFS/etc/hostname"
rm -f "$ROOTFS/usr/sbin/policy-rc.d"
chroot "$ROOTFS" apt-get clean
cleanup
trap cleanup EXIT

KERNEL="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'vmlinuz-*' | sort -V | tail -n1)"
INITRD="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'initrd.img-*' | sort -V | tail -n1)"
[[ -n "$KERNEL" && -n "$INITRD" ]] || { echo "kernel/initrd missing from composed rootfs" >&2; exit 7; }
cp "$KERNEL" "$ARTIFACT_DIR/vmlinuz"
cp "$INITRD" "$ARTIFACT_DIR/initrd.img"

# The staging root stays 0700 so privileged provisioning cannot leak through a
# shared build path. The deployed Linux filesystem root must instead be the
# conventional root:root 0755; copying the staging directory mode into `/`
# prevents non-root daemons (for example messagebus) from starting.
truncate -s 6G "$DISK"
mkfs.ext4 -q -F -L SWIR_E2E "$DISK"
mount -o loop "$DISK" "$MOUNT_DIR"
mounted=1
rsync -aHAX --numeric-ids "$ROOTFS/" "$MOUNT_DIR/"
chown 0:0 "$MOUNT_DIR"
chmod 0755 "$MOUNT_DIR"
[[ "$(stat -c '%u:%g:%a' "$MOUNT_DIR")" == '0:0:755' ]] || { echo 'runtime filesystem root mode is unsafe/incompatible' >&2; exit 7; }
sync
umount "$MOUNT_DIR"
mounted=0

set +e
timeout --signal=TERM --kill-after=15s 240s qemu-system-x86_64 \
  -machine accel=tcg -cpu max -smp 2 -m 2048 \
  -nographic -no-reboot -nodefaults \
  -serial stdio \
  -drive "file=$DISK,format=raw,if=virtio,cache=unsafe" \
  -kernel "$ARTIFACT_DIR/vmlinuz" -initrd "$ARTIFACT_DIR/initrd.img" \
  -append 'root=/dev/vda rw console=ttyS0,115200n8 systemd.unit=multi-user.target net.ifnames=0' \
  2>&1 | tee "$SERIAL_LOG"
qemu_status=${PIPESTATUS[0]}
set -e
if [[ $qemu_status -ne 0 && $qemu_status -ne 124 ]]; then
  echo "QEMU exited unexpectedly: $qemu_status" >&2
  exit 8
fi
grep -F 'SWIR_VM_E2E_PASS debian=13 direct-kernel=true network=disabled' "$SERIAL_LOG" >/dev/null || {
  echo "guest did not emit SWIR_VM_E2E_PASS" >&2
  tail -n 240 "$SERIAL_LOG" >&2 || true
  exit 9
}

mount -o loop,ro "$DISK" "$MOUNT_DIR"
mounted=1
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/readiness.json" "$READINESS_OUT"
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/status.txt" "$ARTIFACT_DIR/status.txt"
umount "$MOUNT_DIR"
mounted=0
node -e "const r=require(process.argv[1]); if(r.distribution?.id!=='debian'||r.distribution?.versionId!=='13'||!r.summary?.systemImageReadyForE2E||!r.summary?.sessionReady) process.exit(2); console.log(JSON.stringify({distribution:r.distribution,architecture:r.architecture,kernelRelease:r.kernelRelease,summary:r.summary},null,2))" "$READINESS_OUT"
grep -Fx 'PASS' "$ARTIFACT_DIR/status.txt" >/dev/null

echo "[SWIR] Debian 13 direct-kernel VM E2E: PASS"
echo "[SWIR] This proves a booted disposable base/rootfs path, not bootloader, graphical login, installer, Secure Boot or physical hardware readiness."
