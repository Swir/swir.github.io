#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "debian13-uefi-vm-e2e.sh must run as root" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="$REPO_ROOT/system/image/system-base-debian-trixie.json"
REPO_POLICY="$REPO_ROOT/system/image/debian-trixie-repository-trust-policy.json"
WORK_ROOT="${SWIR_VM_WORK_ROOT:-/tmp/swir-debian13-uefi-e2e}"
ARTIFACT_DIR="${SWIR_VM_ARTIFACT_DIR:-$WORK_ROOT/artifacts}"
ROOTFS="$WORK_ROOT/rootfs"
DISK="$WORK_ROOT/swir-system-uefi.raw"
ROOT_MOUNT="$WORK_ROOT/root-mount"
ESP_MOUNT="$ROOT_MOUNT/boot/efi"
SERIAL_LOG="$ARTIFACT_DIR/serial.log"
READINESS_OUT="$ARTIFACT_DIR/readiness.json"
COMPAT_OUT="$ARTIFACT_DIR/compat-runtime-inventory.json"
NATIVE_OUT="$ARTIFACT_DIR/native-linux-execution.json"
BOOT_EVIDENCE_OUT="$ARTIFACT_DIR/bootable-image-evidence.json"
PROVISION_OUT="$ARTIFACT_DIR/provisioning.json"
PEER_PROVISION_OUT="$ARTIFACT_DIR/peer-authorization-provisioning.json"
OVMF_CODE="/usr/share/OVMF/OVMF_CODE_4M.fd"
OVMF_VARS_TEMPLATE="/usr/share/OVMF/OVMF_VARS_4M.fd"
OVMF_VARS="$WORK_ROOT/OVMF_VARS_4M.fd"

case "$(readlink -m "$WORK_ROOT")" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var)
    echo "refusing unsafe work root: $WORK_ROOT" >&2; exit 3 ;;
esac

for command in chroot mount umount node qemu-system-x86_64 mkfs.ext4 mkfs.vfat rsync timeout grep install sha256sum stat losetup parted partprobe udevadm; do
  command -v "$command" >/dev/null || { echo "missing required host command: $command" >&2; exit 4; }
done
[[ -f "$PROFILE" && ! -L "$PROFILE" ]] || { echo "selected Debian profile missing" >&2; exit 5; }
[[ -f "$REPO_POLICY" && ! -L "$REPO_POLICY" ]] || { echo "repository trust policy missing" >&2; exit 5; }
[[ -f "$OVMF_CODE" && ! -L "$OVMF_CODE" ]] || { echo "OVMF code firmware missing" >&2; exit 5; }
[[ -f "$OVMF_VARS_TEMPLATE" && ! -L "$OVMF_VARS_TEMPLATE" ]] || { echo "OVMF vars template missing" >&2; exit 5; }
[[ "$(dpkg --print-architecture)" == "amd64" ]] || { echo "current UEFI VM lane is native amd64 only" >&2; exit 6; }

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
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs systemd-boot-efi "${OPTIONAL_PACKAGES[@]}"
chroot "$ROOTFS" /usr/bin/systemd-machine-id-setup

EFI_SOURCE="$ROOTFS/usr/lib/systemd/boot/efi/systemd-bootx64.efi"
[[ -f "$EFI_SOURCE" && ! -L "$EFI_SOURCE" ]] || { echo "Debian systemd-boot EFI binary missing" >&2; exit 7; }
[[ "$(stat -c '%u' "$EFI_SOURCE")" == "0" ]] || { echo "systemd-boot EFI binary must be root-owned" >&2; exit 7; }
EFI_MODE="$(stat -c '%a' "$EFI_SOURCE")"
(( (8#$EFI_MODE & 8#022) == 0 )) || { echo "systemd-boot EFI binary must not be group/world writable" >&2; exit 7; }
EFI_SHA256="$(sha256sum "$EFI_SOURCE" | awk '{print $1}')"

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

install -d -m 0755 "$ROOTFS/opt/swir/system/image" "$ROOTFS/opt/swir/system/runtime" "$ROOTFS/usr/local/lib/swir" "$ROOTFS/var/lib/swir/vm-e2e"
install -m 0644 "$REPO_ROOT/system/image/system-image-readiness.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness.mjs"
install -m 0755 "$REPO_ROOT/system/image/system-image-readiness-probe.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness-probe.mjs"
install -m 0644 "$REPO_ROOT/system/runtime/windows-compat-runtime-registry.mjs" "$ROOTFS/opt/swir/system/runtime/windows-compat-runtime-registry.mjs"
install -m 0644 "$REPO_ROOT/system/runtime/native-package-execution-service.mjs" "$ROOTFS/opt/swir/system/runtime/native-package-execution-service.mjs"
install -m 0644 "$REPO_ROOT/system/runtime/native-app-supervisor.mjs" "$ROOTFS/opt/swir/system/runtime/native-app-supervisor.mjs"
install -m 0644 "$REPO_ROOT/system/runtime/native-app-launcher.mjs" "$ROOTFS/opt/swir/system/runtime/native-app-launcher.mjs"

cat > "$ROOTFS/usr/local/lib/swir/vm-e2e-run" <<'GUEST'
#!/bin/sh
set -eu
OUT=/var/lib/swir/vm-e2e/readiness.json
COMPAT=/var/lib/swir/vm-e2e/compat-runtime-inventory.json
NATIVE=/var/lib/swir/vm-e2e/native-linux-execution.json
STATUS=/var/lib/swir/vm-e2e/status.txt
KERNEL=/var/lib/swir/vm-e2e/kernel-release.txt
serial() { printf '%s\n' "$*" > /dev/ttyS0; }
diag() {
  serial "SWIR_UEFI_VM_DIAGNOSTICS_BEGIN reason=$1"
  systemctl --no-pager --full status dbus.service systemd-logind.service NetworkManager.service swir-peer-authorization.socket > /dev/ttyS0 2>&1 || true
  journalctl -b --no-pager -n 180 -u dbus.service -u systemd-logind.service -u NetworkManager.service -u swir-peer-authorization.socket > /dev/ttyS0 2>&1 || true
  serial "SWIR_UEFI_VM_DIAGNOSTICS_END"
}
fail() { printf 'FAIL:%s\n' "$1" > "$STATUS"; diag "$1"; serial "SWIR_UEFI_VM_E2E_FAIL $1"; sync; systemctl --no-block poweroff; exit 1; }
[ "$(stat -c '%u:%g:%a' /)" = '0:0:755' ] || fail runtime-root-mode
node /opt/swir/system/image/system-image-readiness-probe.mjs --compact > "$OUT" || fail readiness-probe
node -e "const r=require(process.argv[1]); if(!r.summary?.systemImageReadyForE2E||!r.summary?.sessionReady) process.exit(2)" "$OUT" || fail readiness-gates
systemctl is-active --quiet dbus.service || fail dbus
systemctl is-active --quiet systemd-logind.service || fail logind
systemctl is-active --quiet NetworkManager.service || fail networkmanager
systemctl is-active --quiet swir-peer-authorization.socket || fail peer-authorization-socket
/usr/bin/loginctl list-sessions --no-legend >/dev/null || fail loginctl
/usr/bin/nmcli -t general status >/dev/null || fail nmcli
[ -x /usr/bin/wine ] || fail wine-binary
node --input-type=module > "$COMPAT" <<'NODE' || fail wine-runtime-registry
import { WindowsCompatibilityRuntimeRegistry } from 'file:///opt/swir/system/runtime/windows-compat-runtime-registry.mjs';
const registry = new WindowsCompatibilityRuntimeRegistry();
const inventory = registry.discover();
const wine = registry.select('swir.compat.wine');
if (!wine.healthy || wine.provider !== 'swir.compat.wine' || wine.trust?.rootOwned !== true || wine.trust?.writableByGroupOrWorld !== false || typeof wine.version !== 'string' || wine.version.length === 0) process.exit(2);
process.stdout.write(`${JSON.stringify(inventory)}\n`);
NODE
node --input-type=module > "$NATIVE" <<'NODE' || fail native-linux-execution
import { once } from 'node:events';
import { NativePackageExecutionService } from 'file:///opt/swir/system/runtime/native-package-execution-service.mjs';
const manifest = {
  schema: 'swir.package-provider/0.2',
  id: 'swir.e2e.native.true',
  targetEditions: ['system'],
  executionClass: 'linux-native',
  provider: 'swir.package.system',
  package: { nativeEntryPoint: '/usr/bin/true' },
  trust: { signatureRequired: true }
};
const service = new NativePackageExecutionService();
const exited = once(service, 'exited');
const started = service.launch(manifest, {
  trustVerified: true,
  allowedRoots: ['/usr/bin'],
  environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
});
const [record] = await exited;
if (!Number.isInteger(started.pid) || started.pid <= 1 || record.state !== 'exited' || record.exitCode !== 0 || record.signal !== null) process.exit(2);
process.stdout.write(`${JSON.stringify({ schema: 'swir.native-linux-boot-e2e/0.1', provider: manifest.provider, executable: started.executable, exitCode: record.exitCode, supervised: true, shellExecution: false })}\n`);
NODE
uname -r > "$KERNEL"
printf 'PASS\n' > "$STATUS"
serial 'SWIR_UEFI_VM_E2E_PASS debian=13 uefi=systemd-boot network=disabled native-linux=true wine-registry=true'
sync
systemctl --no-block poweroff
GUEST
chmod 0755 "$ROOTFS/usr/local/lib/swir/vm-e2e-run"

cat > "$ROOTFS/etc/systemd/system/swir-vm-e2e.service" <<'UNIT'
[Unit]
Description=SWIR disposable System Edition UEFI bootable-image E2E gate
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
printf 'LABEL=SWIR_ROOT / ext4 defaults 0 1\nLABEL=SWIR_ESP /boot/efi vfat umask=0077 0 2\n' > "$ROOTFS/etc/fstab"
echo swir-uefi-e2e > "$ROOTFS/etc/hostname"
rm -f "$ROOTFS/usr/sbin/policy-rc.d"
chroot "$ROOTFS" apt-get clean
cleanup
trap cleanup EXIT

KERNEL="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'vmlinuz-*' | sort -V | tail -n1)"
INITRD="$(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'initrd.img-*' | sort -V | tail -n1)"
[[ -n "$KERNEL" && -n "$INITRD" ]] || { echo "kernel/initrd missing from composed rootfs" >&2; exit 7; }

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
[[ -b "$ESP_PART" && -b "$ROOT_PART" ]] || { echo "partition devices were not created" >&2; exit 8; }
mkfs.vfat -F 32 -n SWIR_ESP "$ESP_PART" >/dev/null
mkfs.ext4 -q -F -L SWIR_ROOT "$ROOT_PART"
mount "$ROOT_PART" "$ROOT_MOUNT"
root_mounted=1
install -d -m 0755 "$ESP_MOUNT"
mount "$ESP_PART" "$ESP_MOUNT"
esp_mounted=1
rsync -aHAX --numeric-ids --exclude='/boot/efi/*' "$ROOTFS/" "$ROOT_MOUNT/"
chown 0:0 "$ROOT_MOUNT"
chmod 0755 "$ROOT_MOUNT"
[[ "$(stat -c '%u:%g:%a' "$ROOT_MOUNT")" == '0:0:755' ]] || { echo 'runtime filesystem root mode is unsafe/incompatible' >&2; exit 8; }

install -d -m 0755 "$ESP_MOUNT/EFI/BOOT" "$ESP_MOUNT/EFI/systemd" "$ESP_MOUNT/EFI/Linux" "$ESP_MOUNT/loader/entries"
install -m 0644 "$EFI_SOURCE" "$ESP_MOUNT/EFI/BOOT/BOOTX64.EFI"
install -m 0644 "$EFI_SOURCE" "$ESP_MOUNT/EFI/systemd/systemd-bootx64.efi"
install -m 0644 "$KERNEL" "$ESP_MOUNT/EFI/Linux/swir-vmlinuz"
install -m 0644 "$INITRD" "$ESP_MOUNT/EFI/Linux/swir-initrd.img"
cat > "$ESP_MOUNT/loader/loader.conf" <<'LOADER'
default swir-system.conf
timeout 0
console-mode keep
editor no
LOADER
cat > "$ESP_MOUNT/loader/entries/swir-system.conf" <<'ENTRY'
title SWIR OS System Edition E2E
linux /EFI/Linux/swir-vmlinuz
initrd /EFI/Linux/swir-initrd.img
options root=LABEL=SWIR_ROOT rw console=ttyS0,115200n8 systemd.unit=multi-user.target net.ifnames=0
ENTRY
sync
umount "$ESP_MOUNT"
esp_mounted=0
umount "$ROOT_MOUNT"
root_mounted=0
losetup -d "$loop_dev"
loop_dev=""

cp "$OVMF_VARS_TEMPLATE" "$OVMF_VARS"
chmod 0600 "$OVMF_VARS"
set +e
timeout --signal=TERM --kill-after=15s 240s qemu-system-x86_64 \
  -machine q35,accel=tcg -cpu max -smp 2 -m 2048 \
  -nographic -no-reboot -nodefaults \
  -serial stdio \
  -drive "if=pflash,format=raw,readonly=on,file=$OVMF_CODE" \
  -drive "if=pflash,format=raw,file=$OVMF_VARS" \
  -drive "file=$DISK,format=raw,if=virtio,cache=unsafe" \
  2>&1 | tee "$SERIAL_LOG"
qemu_status=${PIPESTATUS[0]}
set -e
if [[ $qemu_status -ne 0 && $qemu_status -ne 124 ]]; then
  echo "QEMU exited unexpectedly: $qemu_status" >&2
  exit 9
fi
grep -F 'SWIR_UEFI_VM_E2E_PASS debian=13 uefi=systemd-boot network=disabled native-linux=true wine-registry=true' "$SERIAL_LOG" >/dev/null || {
  echo "guest did not emit SWIR_UEFI_VM_E2E_PASS" >&2
  tail -n 240 "$SERIAL_LOG" >&2 || true
  exit 10
}

loop_dev="$(losetup --find --show --partscan "$DISK")"
udevadm settle
ROOT_PART="${loop_dev}p2"
mount -o ro "$ROOT_PART" "$ROOT_MOUNT"
root_mounted=1
cp "$ROOT_MOUNT/var/lib/swir/vm-e2e/readiness.json" "$READINESS_OUT"
cp "$ROOT_MOUNT/var/lib/swir/vm-e2e/compat-runtime-inventory.json" "$COMPAT_OUT"
cp "$ROOT_MOUNT/var/lib/swir/vm-e2e/native-linux-execution.json" "$NATIVE_OUT"
cp "$ROOT_MOUNT/var/lib/swir/vm-e2e/status.txt" "$ARTIFACT_DIR/status.txt"
cp "$ROOT_MOUNT/var/lib/swir/vm-e2e/kernel-release.txt" "$ARTIFACT_DIR/kernel-release.txt"
umount "$ROOT_MOUNT"
root_mounted=0
losetup -d "$loop_dev"
loop_dev=""

grep -Fx 'PASS' "$ARTIFACT_DIR/status.txt" >/dev/null
IMAGE_SHA256="$(sha256sum "$DISK" | awk '{print $1}')"
OVMF_SHA256="$(sha256sum "$OVMF_CODE" | awk '{print $1}')"
"$NODE_BIN" - "$READINESS_OUT" "$COMPAT_OUT" "$NATIVE_OUT" "$ARTIFACT_DIR/kernel-release.txt" "$BOOT_EVIDENCE_OUT" "$EFI_SHA256" "$IMAGE_SHA256" "$OVMF_SHA256" <<'NODE'
const fs = require('fs');
const [readinessPath, compatPath, nativePath, kernelPath, outputPath, efiSha256, imageSha256, ovmfSha256] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(readinessPath, 'utf8'));
const compat = JSON.parse(fs.readFileSync(compatPath, 'utf8'));
const native = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
if (r.distribution?.id !== 'debian' || r.distribution?.versionId !== '13' || !r.summary?.systemImageReadyForE2E || !r.summary?.sessionReady) process.exit(2);
const wine = compat.runtimes?.find(runtime => runtime.provider === 'swir.compat.wine' && runtime.healthy === true && runtime.trust?.rootOwned === true && runtime.trust?.writableByGroupOrWorld === false);
if (!wine || typeof wine.version !== 'string' || wine.version.length === 0) process.exit(3);
if (native?.schema !== 'swir.native-linux-boot-e2e/0.1' || native.provider !== 'swir.package.system' || native.exitCode !== 0 || native.supervised !== true || native.shellExecution !== false) process.exit(4);
const report = {
  schema: 'swir.system-bootable-image-e2e/0.1',
  generatedAt: new Date().toISOString(),
  distribution: 'debian-13-trixie',
  architecture: 'amd64',
  kernelRelease: fs.readFileSync(kernelPath, 'utf8').trim(),
  bootPath: 'uefi-systemd-boot',
  partitionTable: 'gpt',
  rootFilesystem: 'ext4',
  rootFilesystemLabel: 'SWIR_ROOT',
  espFilesystem: 'fat32',
  espFilesystemLabel: 'SWIR_ESP',
  bootloaderPackage: 'systemd-boot-efi',
  bootloaderSha256: efiSha256,
  imageSha256,
  ovmfSha256,
  directKernelBoot: false,
  uefiBootClaim: true,
  bootableImageClaim: true,
  bootloaderE2EClaim: true,
  guestNetworkDisabled: true,
  systemdBooted: true,
  logindActive: true,
  networkManagerActive: true,
  peerAuthorizationSocketActive: true,
  readinessPassed: true,
  wineRuntimeRegistryPassed: true,
  wineRuntimeProvider: wine.provider,
  wineRuntimeVersion: wine.version,
  nativeLinuxExecutionPassed: true,
  nativeLinuxExecutionProvider: native.provider,
  nativeLinuxExecutable: native.executable,
  secureBootClaim: false,
  hardwareQualificationClaim: false,
  installerClaim: false,
  recoveryModeClaim: false
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
NODE
"$NODE_BIN" "$REPO_ROOT/system/image/validate-bootable-image-evidence.mjs" "$BOOT_EVIDENCE_OUT"
sha256sum "$DISK" > "$ARTIFACT_DIR/bootable-image.sha256"
rm -f "$DISK" "$OVMF_VARS"

echo "SWIR Debian 13 UEFI bootable-image E2E passed"
