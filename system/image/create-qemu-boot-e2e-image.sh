#!/usr/bin/env bash
set -euo pipefail

ROOTFS=""
SOURCE_ROOT=""
OUTPUT=""
SIZE_MIB="3072"
LABEL="SWIRROOT"

usage() {
  cat <<'EOF'
Usage: create-qemu-boot-e2e-image.sh --rootfs <absolute-dir> --source-root <absolute-repo> --output <absolute-ext4-image> [--size-mib 3072]

Creates a disposable ext4 guest filesystem for SWIR System Edition boot E2E. The resulting
filesystem is booted by CI with an explicitly supplied Debian kernel/initramfs. It is NOT a
standalone bootloader image and does not establish Secure Boot or hardware qualification.
EOF
}

while (($#)); do
  case "$1" in
    --rootfs) ROOTFS="${2:-}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --output) OUTPUT="${2:-}"; shift 2 ;;
    --size-mib) SIZE_MIB="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ -n "$ROOTFS" && "$ROOTFS" = /* ]] || { echo "--rootfs must be an absolute path" >&2; exit 64; }
[[ -n "$SOURCE_ROOT" && "$SOURCE_ROOT" = /* ]] || { echo "--source-root must be an absolute path" >&2; exit 64; }
[[ -n "$OUTPUT" && "$OUTPUT" = /* ]] || { echo "--output must be an absolute path" >&2; exit 64; }
[[ "$ROOTFS" != "/" && "$OUTPUT" != "/" ]] || { echo "refusing live filesystem root" >&2; exit 64; }
[[ "$SIZE_MIB" =~ ^[0-9]+$ ]] && (( SIZE_MIB >= 2048 && SIZE_MIB <= 8192 )) || { echo "--size-mib must be an integer from 2048 through 8192" >&2; exit 64; }
[[ "${EUID}" -eq 0 ]] || { echo "root privileges are required" >&2; exit 77; }
[[ -d "$ROOTFS" && ! -L "$ROOTFS" ]] || { echo "rootfs must be a real directory" >&2; exit 73; }
[[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || { echo "source root must be a real directory" >&2; exit 73; }
[[ "$(realpath "$ROOTFS")" == "$ROOTFS" ]] || { echo "rootfs must resolve exactly to the requested path" >&2; exit 73; }
[[ "$(realpath "$SOURCE_ROOT")" == "$SOURCE_ROOT" ]] || { echo "source root must resolve exactly to the requested path" >&2; exit 73; }
[[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] || { echo "output image must not already exist" >&2; exit 73; }
command -v mke2fs >/dev/null || { echo "mke2fs is required" >&2; exit 69; }
command -v e2fsck >/dev/null || { echo "e2fsck is required" >&2; exit 69; }
command -v systemctl >/dev/null || { echo "systemctl is required" >&2; exit 69; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 69; }

for required in \
  "$ROOTFS/etc/swir/repository-trust-policy.json" \
  "$ROOTFS/usr/lib/systemd/system/swir-peer-authorization.socket" \
  "$ROOTFS/usr/lib/systemd/system/swir-peer-authorization.service" \
  "$ROOTFS/usr/libexec/swir/swir-peer-authorization-broker"; do
  [[ -f "$required" && ! -L "$required" ]] || { echo "required SWIR foundation artifact missing or unsafe: $required" >&2; exit 66; }
done

SMOKE_SOURCE="$SOURCE_ROOT/system/image/swir-qemu-boot-smoke.py"
UNIT_SOURCE="$SOURCE_ROOT/system/image/swir-qemu-boot-smoke.service"
for source in "$SMOKE_SOURCE" "$UNIT_SOURCE"; do
  [[ -f "$source" && ! -L "$source" ]] || { echo "smoke source must be a regular non-symlink file: $source" >&2; exit 66; }
  resolved="$(realpath "$source")"
  [[ "$resolved" == "$SOURCE_ROOT"/* ]] || { echo "smoke source escaped repository root" >&2; exit 66; }
done

mapfile -t KERNELS < <(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'vmlinuz-*' -printf '%f\n' | LC_ALL=C sort -V)
mapfile -t INITRDS < <(find "$ROOTFS/boot" -maxdepth 1 -type f -name 'initrd.img-*' -printf '%f\n' | LC_ALL=C sort -V)
(( ${#KERNELS[@]} > 0 )) || { echo "no kernel image found in rootfs" >&2; exit 70; }
(( ${#INITRDS[@]} > 0 )) || { echo "no initramfs found in rootfs" >&2; exit 70; }
KERNEL_BASENAME="${KERNELS[-1]}"
KERNEL_VERSION="${KERNEL_BASENAME#vmlinuz-}"
INITRD_BASENAME="initrd.img-$KERNEL_VERSION"
[[ -f "$ROOTFS/boot/$INITRD_BASENAME" ]] || { echo "matching initramfs not found for kernel $KERNEL_VERSION" >&2; exit 70; }

install -d -m 0755 "$ROOTFS/usr/libexec/swir" "$ROOTFS/usr/lib/systemd/system" "$ROOTFS/etc/systemd/system/multi-user.target.wants"
install -o root -g root -m 0755 "$SMOKE_SOURCE" "$ROOTFS/usr/libexec/swir/swir-qemu-boot-smoke"
install -o root -g root -m 0644 "$UNIT_SOURCE" "$ROOTFS/usr/lib/systemd/system/swir-qemu-boot-smoke.service"

cat > "$ROOTFS/etc/fstab" <<EOF
LABEL=$LABEL / ext4 defaults 0 1
EOF
chmod 0644 "$ROOTFS/etc/fstab"
printf '%s\n' 'swir-qemu-ci' > "$ROOTFS/etc/hostname"
chmod 0644 "$ROOTFS/etc/hostname"
cat > "$ROOTFS/etc/hosts" <<'EOF'
127.0.0.1 localhost
127.0.1.1 swir-qemu-ci
::1 localhost ip6-localhost ip6-loopback
EOF
chmod 0644 "$ROOTFS/etc/hosts"

# A cloned build-time machine-id must never become the identity of emitted guest images.
install -o root -g root -m 0444 /dev/null "$ROOTFS/etc/machine-id"
if [[ -e "$ROOTFS/var/lib/dbus/machine-id" && ! -L "$ROOTFS/var/lib/dbus/machine-id" ]]; then
  rm -f "$ROOTFS/var/lib/dbus/machine-id"
fi

systemctl --root="$ROOTFS" enable NetworkManager.service >/dev/null
systemctl --root="$ROOTFS" enable swir-peer-authorization.socket >/dev/null
systemctl --root="$ROOTFS" enable swir-qemu-boot-smoke.service >/dev/null
systemctl --root="$ROOTFS" mask systemd-networkd-wait-online.service >/dev/null 2>&1 || true

install -d -o root -g root -m 0700 "$ROOTFS/var/lib/swir/image"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
python3 - "$ROOTFS/var/lib/swir/image/qemu-boot-e2e-state.json" "$KERNEL_BASENAME" "$INITRD_BASENAME" "$LABEL" "$BUILT_AT" <<'PY'
import json, pathlib, sys
path, kernel, initrd, label, built_at = sys.argv[1:]
state = {
  "schema": "swir.system-qemu-boot-image-state/0.1",
  "kernel": f"/boot/{kernel}",
  "initrd": f"/boot/{initrd}",
  "rootLabel": label,
  "builtAt": built_at,
  "directKernelBootHarness": True,
  "bootloaderInstalled": False,
  "standaloneBootableImageClaim": False,
  "secureBootClaim": False,
  "hardwareQualificationClaim": False,
  "disposableCiImage": True,
}
pathlib.Path(path).write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
PY
chmod 0600 "$ROOTFS/var/lib/swir/image/qemu-boot-e2e-state.json"

mkdir -p "$(dirname "$OUTPUT")"
truncate -s "${SIZE_MIB}M" "$OUTPUT"
mke2fs -q -t ext4 -F -L "$LABEL" -d "$ROOTFS" "$OUTPUT"
e2fsck -fn "$OUTPUT" >/dev/null
chmod 0600 "$OUTPUT"

printf 'KERNEL=%s\n' "$ROOTFS/boot/$KERNEL_BASENAME"
printf 'INITRD=%s\n' "$ROOTFS/boot/$INITRD_BASENAME"
printf 'IMAGE=%s\n' "$OUTPUT"
printf 'ROOT_LABEL=%s\n' "$LABEL"
printf 'SWIR QEMU direct-kernel guest image created; standalone bootloader claim remains false.\n'
