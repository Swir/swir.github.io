#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="$ROOT_DIR/system/image/reference-image-profile.mjs"
READINESS_DIR="$ROOT_DIR/system/image"
HOST_NODE="${SWIR_HOST_NODE:-$(command -v node || true)}"

[[ -n "$HOST_NODE" && -x "$HOST_NODE" ]] || { echo "Missing host Node.js runtime" >&2; exit 2; }

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  exec sudo env "SWIR_HOST_NODE=$HOST_NODE" "SWIR_KEEP_ROOTFS=${SWIR_KEEP_ROOTFS:-0}" bash "$0" "$@"
fi

for command in debootstrap chroot mount umount; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 2; }
done

"$HOST_NODE" "$PROFILE" --validate >/dev/null
SUITE="$("$HOST_NODE" "$PROFILE" --suite)"
ARCH="$("$HOST_NODE" "$PROFILE" --architecture)"
MIRROR="$("$HOST_NODE" "$PROFILE" --mirror)"
SECURITY_MIRROR="$("$HOST_NODE" "$PROFILE" --security-mirror)"
COMPONENTS="$("$HOST_NODE" "$PROFILE" --components)"
PACKAGES="$("$HOST_NODE" "$PROFILE" --e2e-packages)"

[[ "$SUITE" == "noble" ]] || { echo "Unexpected suite: $SUITE" >&2; exit 3; }
[[ "$ARCH" == "amd64" ]] || { echo "Unexpected architecture: $ARCH" >&2; exit 3; }
[[ "$MIRROR" == "https://archive.ubuntu.com/ubuntu" ]] || { echo "Untrusted mirror: $MIRROR" >&2; exit 3; }
[[ "$SECURITY_MIRROR" == "https://security.ubuntu.com/ubuntu" ]] || { echo "Untrusted security mirror: $SECURITY_MIRROR" >&2; exit 3; }
[[ "$COMPONENTS" == "main universe" ]] || { echo "Unexpected archive components: $COMPONENTS" >&2; exit 3; }
[[ "$PACKAGES" =~ ^[a-z0-9+.,-]+$ ]] || { echo "Unsafe package list" >&2; exit 3; }

ROOTFS="$(mktemp -d /tmp/swir-reference-rootfs.XXXXXX)"
REPORT="$(mktemp /tmp/swir-reference-rootfs-report.XXXXXX.json)"
PROC_MOUNTED=0
SYS_MOUNTED=0

cleanup() {
  set +e
  if [[ "$SYS_MOUNTED" == 1 ]]; then umount -l "$ROOTFS/sys" >/dev/null 2>&1 || true; fi
  if [[ "$PROC_MOUNTED" == 1 ]]; then umount -l "$ROOTFS/proc" >/dev/null 2>&1 || true; fi
  if [[ "${SWIR_KEEP_ROOTFS:-0}" == "1" ]]; then
    echo "Keeping disposable rootfs for diagnostics: $ROOTFS" >&2
  else
    rm -rf --one-file-system "$ROOTFS"
  fi
  rm -f "$REPORT"
}
trap cleanup EXIT

printf 'Building SWIR reference rootfs: suite=%s arch=%s mirror=%s\n' "$SUITE" "$ARCH" "$MIRROR"
debootstrap --arch="$ARCH" --variant=minbase "$SUITE" "$ROOTFS" "$MIRROR"

cat > "$ROOTFS/usr/sbin/policy-rc.d" <<'POLICY'
#!/bin/sh
exit 101
POLICY
chmod 0755 "$ROOTFS/usr/sbin/policy-rc.d"

cat > "$ROOTFS/etc/apt/sources.list" <<APT
deb $MIRROR $SUITE $COMPONENTS
deb $MIRROR ${SUITE}-updates $COMPONENTS
deb $SECURITY_MIRROR ${SUITE}-security $COMPONENTS
APT

mount -t proc -o nosuid,nodev,noexec proc "$ROOTFS/proc"
PROC_MOUNTED=1
mount --rbind /sys "$ROOTFS/sys"
mount --make-rslave "$ROOTFS/sys"
mount -o remount,bind,ro,nosuid,nodev,noexec "$ROOTFS/sys"
SYS_MOUNTED=1

[[ -r "$ROOTFS/proc/self/status" ]] || { echo "procfs sentinel missing" >&2; exit 4; }
[[ -d "$ROOTFS/sys/kernel" ]] || { echo "sysfs sentinel missing" >&2; exit 4; }

chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGES//,/ }
chroot "$ROOTFS" /usr/bin/apt-get clean

install -d -m 0700 -o 0 -g 0 "$ROOTFS/var/lib/swir/security/catalog-trust"
install -d -m 0755 -o 0 -g 0 "$ROOTFS/opt/swir/system/image"
install -m 0644 -o 0 -g 0 "$READINESS_DIR/system-image-readiness.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness.mjs"
install -m 0755 -o 0 -g 0 "$READINESS_DIR/system-image-readiness-probe.mjs" "$ROOTFS/opt/swir/system/image/system-image-readiness-probe.mjs"

for binary in /usr/bin/apt-get /usr/bin/systemctl /usr/bin/pkcheck /usr/bin/nmcli /usr/bin/loginctl /usr/bin/node; do
  [[ -x "$ROOTFS$binary" ]] || { echo "Reference rootfs is missing required binary: $binary" >&2; exit 5; }
done

chroot "$ROOTFS" /usr/bin/node /opt/swir/system/image/system-image-readiness-probe.mjs --compact > "$REPORT"
"$HOST_NODE" - "$REPORT" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.schema !== 'swir.system-image-readiness/0.1') throw new Error('unexpected readiness schema');
if (report.readOnly !== true) throw new Error('readiness report must remain read-only');
if (report.distribution?.id !== 'ubuntu' || report.distribution?.versionId !== '24.04') throw new Error('reference rootfs distribution drifted');
if (report.summary?.systemImageReadyForE2E !== true) throw new Error(`reference rootfs failed readiness gates: ${(report.summary?.blockers || []).join(',')}`);
const gate = id => report.gates.find(item => item.id === id);
for (const id of ['trusted-package-manager', 'systemd-service-manager', 'polkit-broker', 'networkmanager-client', 'catalog-trust-state-root']) {
  if (gate(id)?.passed !== true) throw new Error(`required gate failed: ${id}`);
}
if (gate('fwupd-discovery')?.passed !== true) throw new Error('fwupd optional capability was provisioned but not detected');
if (gate('flatpak-runtime')?.passed !== true) throw new Error('Flatpak optional capability was provisioned but not detected');
console.log(`Reference rootfs readiness: ${report.summary.requiredPassed}/${report.summary.requiredTotal} required gates, ${report.summary.optionalPassed}/${report.summary.optionalTotal} optional capabilities`);
NODE

chroot "$ROOTFS" /usr/bin/dpkg-query -W -f='${Package}\t${Version}\n' systemd policykit-1 network-manager fwupd flatpak

printf 'SWIR reference rootfs E2E passed. This proves rootfs prerequisite integration only; bootable image claim remains false.\n'
