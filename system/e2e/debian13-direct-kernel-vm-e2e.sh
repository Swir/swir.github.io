#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "debian13-direct-kernel-vm-e2e.sh must run as root" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="$REPO_ROOT/system/image/system-base-debian-trixie.json"
REPO_POLICY="$REPO_ROOT/system/image/debian-trixie-repository-trust-policy.json"
WORK_ROOT="${SWIR_VM_WORK_ROOT:-/tmp/swir-debian13-direct-kernel-e2e}"
ARTIFACT_DIR="${SWIR_VM_ARTIFACT_DIR:-$WORK_ROOT/artifacts}"
BOOT_DIR="$WORK_ROOT/boot"
ROOTFS="$WORK_ROOT/rootfs"
DISK="$WORK_ROOT/swir-system-e2e.ext4"
MOUNT_DIR="$WORK_ROOT/disk-mount"
SERIAL_LOG="$ARTIFACT_DIR/serial.log"
READINESS_OUT="$ARTIFACT_DIR/readiness.json"
COMPAT_OUT="$ARTIFACT_DIR/compat-runtime-inventory.json"
HARDWARE_OUT="$ARTIFACT_DIR/hardware-live-e2e.json"
BOOT_EVIDENCE_OUT="$ARTIFACT_DIR/direct-kernel-boot-evidence.json"
PROVISION_OUT="$ARTIFACT_DIR/provisioning.json"
PEER_PROVISION_OUT="$ARTIFACT_DIR/peer-authorization-provisioning.json"

case "$(readlink -m "$WORK_ROOT")" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var)
    echo "refusing unsafe work root: $WORK_ROOT" >&2; exit 3 ;;
esac

for command in chroot mount umount node qemu-system-x86_64 mkfs.ext4 rsync timeout grep install sha256sum stat; do
  command -v "$command" >/dev/null || { echo "missing required host command: $command" >&2; exit 4; }
done
[[ -f "$PROFILE" && ! -L "$PROFILE" ]] || { echo "selected Debian profile missing" >&2; exit 5; }
[[ -f "$REPO_POLICY" && ! -L "$REPO_POLICY" ]] || { echo "repository trust policy missing" >&2; exit 5; }
[[ "$(dpkg --print-architecture)" == "amd64" ]] || { echo "current VM lane is native amd64 only" >&2; exit 6; }

mapfile -t OPTIONAL_PACKAGES < <(node - "$PROFILE" <<'NODE'
const fs = require('fs');
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (profile?.schema !== 'swir.system-base-profile/0.1' || profile?.id !== 'debian-13-trixie') process.exit(2);
for (const name of profile.optionalPackages || []) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9+.-]*$/.test(name)) process.exit(3);
  process.stdout.write(`${name}\n`);
}
NODE
)
[[ ${#OPTIONAL_PACKAGES[@]} -gt 0 ]] || { echo "selected Debian profile has no validated optional packages" >&2; exit 6; }

rm -rf "$WORK_ROOT"
install -d -m 0700 "$WORK_ROOT" "$ARTIFACT_DIR" "$BOOT_DIR" "$ROOTFS" "$MOUNT_DIR"
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

echo "[SWIR] Building selected Debian 13 rootfs through the production foundation builder"
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
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs "${OPTIONAL_PACKAGES[@]}"
chroot "$ROOTFS" /usr/bin/systemd-machine-id-setup

NODE_BIN="$(command -v node)"
"$NODE_BIN" "$REPO_ROOT/system/image/system-image-provisioning-cli.mjs" stage \
  --rootfs "$ROOTFS" --source-root "$REPO_ROOT" --repository-policy "$REPO_POLICY" --production --compact > "$PROVISION_OUT"
"$NODE_BIN" --input-type=module - "$REPO_ROOT" "$ROOTFS" > "$PEER_PROVISION_OUT" <<'NODE'
import path from 'node:path';
const [repoRoot, rootfs] = process.argv.slice(2);
const mod = await import(`file://${path.join(repoRoot, 'system/image/system-peer-authorization-provisioning.mjs')}`);
const report = await mod.stagePeerAuthorizationFoundation({ rootfs, sourceRoot: repoRoot, production: true });
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ready || report.bootableImageClaim !== false || report.runtimeKeyEmbeddedInImage !== false) process.exit(2);
NODE

install -d -m 0755 \
  "$ROOTFS/opt/swir/system/image" \
  "$ROOTFS/opt/swir/system/runtime" \
  "$ROOTFS/opt/swir/system/hardware" \
  "$ROOTFS/opt/swir/system/contracts" \
  "$ROOTFS/usr/local/lib/swir" \
  "$ROOTFS/var/lib/swir/vm-e2e"
install -m 0644 "$REPO_ROOT/system/image/system-image-readiness.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness.mjs"
install -m 0755 "$REPO_ROOT/system/image/system-image-readiness-probe.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness-probe.mjs"
install -m 0644 "$REPO_ROOT/system/runtime/windows-compat-runtime-registry.mjs" "$ROOTFS/opt/swir/system/runtime/windows-compat-runtime-registry.mjs"
install -m 0644 "$REPO_ROOT/system/hardware/hardware-service.mjs" "$ROOTFS/opt/swir/system/hardware/hardware-service.mjs"
install -m 0644 "$REPO_ROOT/system/hardware/driver-resolver.mjs" "$ROOTFS/opt/swir/system/hardware/driver-resolver.mjs"
install -m 0644 "$REPO_ROOT/system/hardware/driver-center-service.mjs" "$ROOTFS/opt/swir/system/hardware/driver-center-service.mjs"
install -m 0644 "$REPO_ROOT/system/hardware/hardware-live-e2e.mjs" "$ROOTFS/opt/swir/system/hardware/hardware-live-e2e.mjs"
install -m 0644 "$REPO_ROOT/system/hardware/hardware-catalog.json" "$ROOTFS/opt/swir/system/hardware/hardware-catalog.json"
install -m 0644 "$REPO_ROOT/system/contracts/trusted-sources.json" "$ROOTFS/opt/swir/system/contracts/trusted-sources.json"

cat > "$ROOTFS/usr/local/lib/swir/vm-e2e-run" <<'GUEST'
#!/bin/sh
set -eu
OUT=/var/lib/swir/vm-e2e/readiness.json
COMPAT=/var/lib/swir/vm-e2e/compat-runtime-inventory.json
HARDWARE=/var/lib/swir/vm-e2e/hardware-live-e2e.json
STATUS=/var/lib/swir/vm-e2e/status.txt
KERNEL=/var/lib/swir/vm-e2e/kernel-release.txt
serial() { printf '%s\n' "$*" > /dev/ttyS0; }
diag() {
  serial "SWIR_VM_DIAGNOSTICS_BEGIN reason=$1"
  systemctl --no-pager --full status dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket > /dev/ttyS0 2>&1 || true
  journalctl -b --no-pager -n 180 -u dbus.service -u systemd-logind.service -u NetworkManager.service -u swir-peer-authorization.socket > /dev/ttyS0 2>&1 || true
  ls -ld / /run/dbus /run/swir /run/swir/peer-authorization.sock /sys/bus/pci/devices > /dev/ttyS0 2>&1 || true
  serial "SWIR_VM_DIAGNOSTICS_END"
}
fail() { printf 'FAIL:%s\n' "$1" > "$STATUS"; diag "$1"; serial "SWIR_VM_E2E_FAIL $1"; sync; systemctl --no-block poweroff; exit 1; }
[ "$(stat -c '%u:%g:%a' /)" = '0:0:755' ] || fail runtime-root-mode
node /opt/swir/system/image/system-image-readiness-probe.mjs --compact > "$OUT" || fail readiness-probe
node -e "const r=require(process.argv[1]); if(!r.summary?.systemImageReadyForE2E||!r.summary?.sessionReady) process.exit(2)" "$OUT" || fail readiness-gates
systemctl is-active --quiet dbus.service || fail dbus
systemctl is-active --quiet systemd-logind.service || fail logind
systemctl is-active --quiet NetworkManager.service || fail networkmanager
systemctl is-active --quiet swir-peer-authorization.socket || fail peer-authorization-socket
/usr/bin/loginctl list-sessions --no-legend >/dev/null || fail loginctl
/usr/bin/nmcli -t general status >/dev/null || fail nmcli
[ -x /usr/bin/fwupdmgr ] || fail fwupd-binary
[ -x /usr/bin/flatpak ] || fail flatpak-binary
[ -x /usr/bin/wine ] || fail wine-binary
node --input-type=module > "$COMPAT" <<'NODE' || fail wine-runtime-registry
import { WindowsCompatibilityRuntimeRegistry } from 'file:///opt/swir/system/runtime/windows-compat-runtime-registry.mjs';
const registry = new WindowsCompatibilityRuntimeRegistry();
const inventory = registry.discover();
const wine = registry.select('swir.compat.wine');
if (!wine.healthy || wine.provider !== 'swir.compat.wine' || wine.trust?.rootOwned !== true || wine.trust?.writableByGroupOrWorld !== false || typeof wine.version !== 'string' || wine.version.length === 0) process.exit(2);
process.stdout.write(`${JSON.stringify(inventory)}\n`);
NODE
node /opt/swir/system/hardware/hardware-live-e2e.mjs --output "$HARDWARE" >/dev/null || fail hardware-service-live
node -e "const e=require(process.argv[1]); if(e.schema!=='swir.hardware-live-e2e/0.1'||e.passed!==true||e.readOnly!==true||e.devices?.pci<1||e.devices?.loadedDrivers<1||e.driverCenterViolations!==0||e.hardwareQualificationClaim!==false) process.exit(2)" "$HARDWARE" || fail hardware-service-evidence
uname -r > "$KERNEL"
printf 'PASS\n' > "$STATUS"
serial 'SWIR_VM_E2E_PASS debian=13 direct-kernel=true network=disabled wine-registry=true hardware-service=true'
sync
systemctl --no-block poweroff
GUEST
chmod 0755 "$ROOTFS/usr/local/lib/swir/vm-e2e-run"

cat > "$ROOTFS/etc/systemd/system/swir-vm-e2e.service" <<'UNIT'
[Unit]
Description=SWIR disposable System Edition direct-kernel VM E2E gate
After=dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket
Wants=dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket
ConditionPathExists=/opt/swir/system/image/system-image-readiness-probe.mjs

[Service]
Type=oneshot
ExecStart=/usr/local/lib/swir/vm-e2e-run
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
UNIT
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
cp "$KERNEL" "$BOOT_DIR/vmlinuz"
cp "$INITRD" "$BOOT_DIR/initrd.img"
sha256sum "$BOOT_DIR/vmlinuz" "$BOOT_DIR/initrd.img" > "$ARTIFACT_DIR/kernel-initrd.sha256"

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
  -kernel "$BOOT_DIR/vmlinuz" -initrd "$BOOT_DIR/initrd.img" \
  -append 'root=/dev/vda rw console=ttyS0,115200n8 systemd.unit=multi-user.target net.ifnames=0' \
  2>&1 | tee "$SERIAL_LOG"
qemu_status=${PIPESTATUS[0]}
set -e
if [[ $qemu_status -ne 0 && $qemu_status -ne 124 ]]; then
  echo "QEMU exited unexpectedly: $qemu_status" >&2
  exit 8
fi
grep -F 'SWIR_VM_E2E_PASS debian=13 direct-kernel=true network=disabled wine-registry=true hardware-service=true' "$SERIAL_LOG" >/dev/null || {
  echo "guest did not emit SWIR_VM_E2E_PASS" >&2
  tail -n 240 "$SERIAL_LOG" >&2 || true
  exit 9
}

mount -o loop,ro "$DISK" "$MOUNT_DIR"
mounted=1
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/readiness.json" "$READINESS_OUT"
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/compat-runtime-inventory.json" "$COMPAT_OUT"
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/hardware-live-e2e.json" "$HARDWARE_OUT"
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/status.txt" "$ARTIFACT_DIR/status.txt"
cp "$MOUNT_DIR/var/lib/swir/vm-e2e/kernel-release.txt" "$ARTIFACT_DIR/kernel-release.txt"
umount "$MOUNT_DIR"
mounted=0

grep -Fx 'PASS' "$ARTIFACT_DIR/status.txt" >/dev/null
"$NODE_BIN" - "$READINESS_OUT" "$COMPAT_OUT" "$HARDWARE_OUT" "$ARTIFACT_DIR/kernel-release.txt" "$BOOT_EVIDENCE_OUT" <<'NODE'
const fs = require('fs');
const [readinessPath, compatPath, hardwarePath, kernelPath, outputPath] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(readinessPath, 'utf8'));
const compat = JSON.parse(fs.readFileSync(compatPath, 'utf8'));
const hardware = JSON.parse(fs.readFileSync(hardwarePath, 'utf8'));
if (r.distribution?.id !== 'debian' || r.distribution?.versionId !== '13' || !r.summary?.systemImageReadyForE2E || !r.summary?.sessionReady) process.exit(2);
const wine = compat.runtimes?.find(runtime => runtime.provider === 'swir.compat.wine' && runtime.healthy === true && runtime.trust?.rootOwned === true && runtime.trust?.writableByGroupOrWorld === false);
if (!wine || typeof wine.version !== 'string' || wine.version.length === 0) process.exit(3);
if (hardware.schema !== 'swir.hardware-live-e2e/0.1' || hardware.passed !== true || hardware.readOnly !== true || hardware.inventoryProvider !== 'linux-sysfs' || hardware.devices?.pci < 1 || hardware.devices?.loadedDrivers < 1 || hardware.driverCenterViolations !== 0 || hardware.hardwareQualificationClaim !== false) process.exit(4);
const report = {
  schema: 'swir.system-direct-kernel-boot-e2e/0.1',
  generatedAt: new Date().toISOString(),
  distribution: 'debian-13-trixie',
  architecture: 'amd64',
  kernelRelease: fs.readFileSync(kernelPath, 'utf8').trim(),
  directKernelBoot: true,
  guestNetworkDisabled: true,
  systemdBooted: true,
  logindActive: true,
  networkManagerActive: true,
  peerAuthorizationSocketActive: true,
  readinessPassed: true,
  wineRuntimeRegistryPassed: true,
  wineRuntimeProvider: wine.provider,
  wineRuntimeVersion: wine.version,
  hardwareServicePassed: true,
  hardwareInventoryProvider: hardware.inventoryProvider,
  hardwareDevicesObserved: hardware.devices.total,
  hardwareLoadedDriversObserved: hardware.devices.loadedDrivers,
  bootableImageClaim: false,
  bootloaderE2EClaim: false,
  secureBootClaim: false,
  hardwareQualificationClaim: false
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
NODE
"$NODE_BIN" "$REPO_ROOT/system/image/validate-direct-kernel-boot-evidence.mjs" "$BOOT_EVIDENCE_OUT"

echo "[SWIR] Debian 13 direct-kernel VM E2E: PASS"
echo "[SWIR] Managed Wine runtime registry: PASS"
echo "[SWIR] Production Hardware Service against guest kernel sysfs: PASS"
echo "[SWIR] Bootloader/UEFI, Secure Boot, installer/recovery and physical hardware qualification remain open."
