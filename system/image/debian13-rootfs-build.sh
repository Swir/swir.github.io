#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <rootfs-directory>" >&2
  exit 2
fi

ROOTFS="$(readlink -m "$1")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PROFILE="$SCRIPT_DIR/debian13-base-image-profile.json"

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "debian13-rootfs-build.sh must run as root" >&2
  exit 3
fi
for command in debootstrap chroot mount umount node install cp; do
  command -v "$command" >/dev/null || { echo "missing required host command: $command" >&2; exit 4; }
done
[[ -f /usr/share/keyrings/debian-archive-keyring.gpg ]] || { echo "host Debian archive keyring is missing" >&2; exit 5; }
node "$SCRIPT_DIR/validate-debian13-base-image-profile.mjs"

ARCH="${SWIR_ROOTFS_ARCH:-amd64}"
case "$ARCH" in
  amd64|arm64) ;;
  *) echo "unsupported rootfs architecture: $ARCH" >&2; exit 6 ;;
esac
HOST_ARCH="$(dpkg --print-architecture 2>/dev/null || true)"
if [[ "$ARCH" != "$HOST_ARCH" ]]; then
  echo "cross-architecture rootfs requires an explicit emulation pipeline; refusing $HOST_ARCH -> $ARCH" >&2
  exit 7
fi

KERNEL_PACKAGE="$(node -e "const p=require(process.argv[1]); process.stdout.write(p.kernelPackages[process.argv[2]] || '')" "$PROFILE" "$ARCH")"
mapfile -t BASE_PACKAGES < <(node -e "const p=require(process.argv[1]); for (const x of [...p.requiredPackages,...p.hybridFoundationPackages]) console.log(x)" "$PROFILE")
[[ -n "$KERNEL_PACKAGE" ]] || { echo "kernel package missing for $ARCH" >&2; exit 8; }
BASE_PACKAGES+=("$KERNEL_PACKAGE" "debian-archive-keyring")

rm -rf "$ROOTFS"
mkdir -p "$ROOTFS"
device_cleanup=0
proc_cleanup=0
sys_cleanup=0
cleanup() {
  set +e
  if [[ $device_cleanup -eq 1 ]]; then umount -R "$ROOTFS/dev" 2>/dev/null || true; fi
  if [[ $sys_cleanup -eq 1 ]]; then umount -R "$ROOTFS/sys" 2>/dev/null || true; fi
  if [[ $proc_cleanup -eq 1 ]]; then umount "$ROOTFS/proc" 2>/dev/null || true; fi
}
trap cleanup EXIT

echo "[SWIR] debootstrap Debian 13 trixie ($ARCH)"
debootstrap \
  --variant=minbase \
  --arch="$ARCH" \
  --keyring=/usr/share/keyrings/debian-archive-keyring.gpg \
  trixie "$ROOTFS" https://deb.debian.org/debian

install -d -o root -g root -m 0755 "$ROOTFS/etc/apt/sources.list.d"
find "$ROOTFS/etc/apt/sources.list.d" -mindepth 1 -maxdepth 1 -type f -delete
cat > "$ROOTFS/etc/apt/sources.list" <<'SOURCES'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main non-free-firmware
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie-updates main non-free-firmware
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://security.debian.org/debian-security trixie-security main non-free-firmware
SOURCES

cat > "$ROOTFS/usr/sbin/policy-rc.d" <<'POLICY'
#!/bin/sh
exit 101
POLICY
chmod 0755 "$ROOTFS/usr/sbin/policy-rc.d"

mount -t proc proc "$ROOTFS/proc"
proc_cleanup=1
mount --rbind /sys "$ROOTFS/sys"
mount --make-rslave "$ROOTFS/sys"
sys_cleanup=1
mount --rbind /dev "$ROOTFS/dev"
mount --make-rslave "$ROOTFS/dev"
device_cleanup=1

chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${BASE_PACKAGES[@]}"

install -d -o root -g root -m 0700 "$ROOTFS/var/lib/swir/security/catalog-trust"
install -d -o root -g root -m 0700 "$ROOTFS/var/lib/swir/transactions/packages"
install -d -o root -g root -m 0700 "$ROOTFS/var/lib/swir/transactions/firmware"
install -d -o root -g root -m 0755 "$ROOTFS/usr/share/polkit-1/actions"
for policy in \
  org.swir.system.packages.policy \
  org.swir.system.network.policy \
  org.swir.system.firmware.policy; do
  install -o root -g root -m 0644 "$REPO_ROOT/system/security/$policy" "$ROOTFS/usr/share/polkit-1/actions/$policy"
done

install -d -o root -g root -m 0755 "$ROOTFS/opt/swir/system/image"
install -o root -g root -m 0644 "$REPO_ROOT/system/image/system-image-readiness.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness.mjs"
install -o root -g root -m 0755 "$REPO_ROOT/system/image/system-image-readiness-probe.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness-probe.mjs"
install -o root -g root -m 0644 "$PROFILE" "$ROOTFS/opt/swir/system/image/debian13-base-image-profile.json"

chroot "$ROOTFS" node /opt/swir/system/image/system-image-readiness-probe.mjs --compact > "$ROOTFS/var/lib/swir/system-image-readiness.json"
chroot "$ROOTFS" apt-get -s upgrade > "$ROOTFS/var/log/swir-rootfs-apt-simulation.log"

rm -f "$ROOTFS/usr/sbin/policy-rc.d"
chroot "$ROOTFS" apt-get clean

echo "[SWIR] Debian 13 rootfs built at $ROOTFS"
echo "[SWIR] This is a rootfs E2E artifact, not a bootable disk/image claim."
