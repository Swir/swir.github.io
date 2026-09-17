#!/usr/bin/env bash
set -euo pipefail

PROFILE_DEFAULT="system/image/system-base-debian-trixie.json"
ROOTFS=""
PROFILE="$PROFILE_DEFAULT"
ARCH="amd64"
MIRROR="https://deb.debian.org/debian"
HOST_KEYRING="/usr/share/keyrings/debian-archive-keyring.gpg"

usage() {
  cat <<'EOF'
Usage: build-debian-trixie-rootfs.sh --rootfs <absolute-path> [--profile <json>] [--arch amd64]

Builds a disposable SWIR System Edition foundation rootfs from official Debian 13 (trixie)
repositories using mmdebstrap. This creates a rootfs foundation only; it does not claim a
bootable SWIR OS image, Secure Boot qualification, hardware qualification, or installer readiness.
EOF
}

while (($#)); do
  case "$1" in
    --rootfs) ROOTFS="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[[ -n "$ROOTFS" ]] || { echo "--rootfs is required" >&2; exit 64; }
[[ "$ROOTFS" = /* ]] || { echo "rootfs path must be absolute" >&2; exit 64; }
[[ "$ROOTFS" != "/" ]] || { echo "refusing to use / as rootfs" >&2; exit 64; }
[[ "$ARCH" == "amd64" ]] || { echo "only the verified amd64 builder is enabled in 0.1" >&2; exit 64; }
[[ -f "$PROFILE" && ! -L "$PROFILE" ]] || { echo "base profile must be a regular non-symlink file" >&2; exit 66; }
[[ "${EUID}" -eq 0 ]] || { echo "root privileges are required for the production rootfs builder" >&2; exit 77; }
command -v mmdebstrap >/dev/null || { echo "mmdebstrap is required" >&2; exit 69; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 69; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 69; }
command -v stat >/dev/null || { echo "stat is required" >&2; exit 69; }
[[ -f "$HOST_KEYRING" && ! -L "$HOST_KEYRING" ]] || { echo "trusted Debian archive keyring is required at $HOST_KEYRING" >&2; exit 69; }
[[ "$(stat -c '%u' "$HOST_KEYRING")" == "0" ]] || { echo "Debian archive keyring must be root-owned" >&2; exit 78; }
KEYRING_MODE="$(stat -c '%a' "$HOST_KEYRING")"
(( (8#$KEYRING_MODE & 8#022) == 0 )) || { echo "Debian archive keyring must not be group/world writable" >&2; exit 78; }

python3 - "$PROFILE" "$ARCH" "$MIRROR" <<'PY'
import json, pathlib, sys
profile_path, arch, mirror = sys.argv[1:]
p = json.loads(pathlib.Path(profile_path).read_text(encoding='utf-8'))
assert p.get('schema') == 'swir.system-base-profile/0.1', 'unexpected base profile schema'
assert p.get('id') == 'debian-13-trixie', 'unexpected base profile id'
d = p.get('distribution', {})
assert d.get('id') == 'debian' and d.get('suite') == 'trixie' and d.get('majorVersion') == 13, 'profile is not Debian 13 trixie'
assert arch in p.get('architectures', {}).get('imageBuilder', []), 'architecture is not enabled for image building'
repos = p.get('repositories', [])
assert repos and repos[0].get('uri') == mirror, 'builder mirror must match the selected official profile'
policy = p.get('policy', {})
assert policy.get('officialRepositoriesOnly') is True
assert policy.get('nativeAptSignatureVerificationRequired') is True
assert policy.get('thirdPartyRepositoriesEnabled') is False
assert policy.get('randomDriverDownloadsAllowed') is False
assert policy.get('windowsKernelDriversSupported') is False
assert policy.get('bootableImageClaim') is False
required = set(p.get('requiredPackages', []))
for package in ('linux-image-amd64', 'firmware-linux', 'systemd-sysv', 'dbus', 'polkitd', 'network-manager', 'fwupd', 'python3', 'ca-certificates', 'debian-archive-keyring'):
    assert package in required, f'required base package missing from profile: {package}'
for repo in repos:
    assert repo.get('uri', '').startswith('https://'), 'repositories must use HTTPS'
    assert repo.get('signedBy') == '/usr/share/keyrings/debian-archive-keyring.gpg', 'repository must use Debian archive keyring'
    assert repo.get('sourceClass') == 'distribution-repository', 'repository must remain distribution-managed'
assert any('non-free-firmware' in repo.get('components', []) for repo in repos), 'firmware component must be explicit'
print('SWIR Debian base profile validation OK')
PY

if [[ -e "$ROOTFS" ]]; then
  [[ -d "$ROOTFS" && ! -L "$ROOTFS" ]] || { echo "rootfs must be a real directory" >&2; exit 73; }
  if find "$ROOTFS" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "rootfs directory must be empty" >&2
    exit 73
  fi
else
  install -d -m 0700 "$ROOTFS"
fi

PROFILE_SHA256="$(sha256sum "$PROFILE" | awk '{print $1}')"
KEYRING_SHA256="$(sha256sum "$HOST_KEYRING" | awk '{print $1}')"
INCLUDE="linux-image-amd64,firmware-linux,systemd-sysv,dbus,polkitd,network-manager,fwupd,python3,ca-certificates,debian-archive-keyring"

# Keep Debian's native archive-key signature verification enabled. The builder has no caller-
# supplied mirror, insecure APT option, arbitrary package source, or third-party repository input.
# Debian's firmware-linux metapackage is resolved only from the signed non-free-firmware component
# and pulls the distro-maintained free/non-free firmware sets used by in-tree Linux drivers.
mmdebstrap \
  --variant=minbase \
  --architectures="$ARCH" \
  --components='main non-free-firmware' \
  --keyring="$HOST_KEYRING" \
  --include="$INCLUDE" \
  trixie "$ROOTFS" "$MIRROR"

install -d -m 0755 "$ROOTFS/etc/apt/sources.list.d"
cat > "$ROOTFS/etc/apt/sources.list.d/swir-debian.sources" <<'EOF'
Types: deb
URIs: https://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://security.debian.org/debian-security
Suites: trixie-security
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
chmod 0644 "$ROOTFS/etc/apt/sources.list.d/swir-debian.sources"
rm -f "$ROOTFS/etc/apt/sources.list"

install -d -m 0700 "$ROOTFS/var/lib/swir/image"
PACKAGE_LIST="$(chroot "$ROOTFS" dpkg-query -W -f='${Package}\t${Version}\n' | LC_ALL=C sort)"
for package in linux-image-amd64 firmware-linux firmware-linux-free firmware-linux-nonfree systemd-sysv dbus polkitd network-manager fwupd python3 ca-certificates debian-archive-keyring; do
  chroot "$ROOTFS" dpkg-query -W -f='${db:Status-Abbrev}' "$package" | grep -qx 'ii ' || {
    echo "required package is not installed: $package" >&2
    exit 70
  }
done

KERNEL_VERSION="$(chroot "$ROOTFS" dpkg-query -W -f='${Version}' linux-image-amd64)"
FIRMWARE_VERSION="$(chroot "$ROOTFS" dpkg-query -W -f='${Version}' firmware-linux)"
SYSTEMD_VERSION="$(chroot "$ROOTFS" dpkg-query -W -f='${Version}' systemd)"
PACKAGE_SET_SHA256="$(printf '%s\n' "$PACKAGE_LIST" | sha256sum | awk '{print $1}')"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$ROOTFS/var/lib/swir/image/base-build-state.json" "$PROFILE_SHA256" "$KEYRING_SHA256" "$PACKAGE_SET_SHA256" "$ARCH" "$KERNEL_VERSION" "$FIRMWARE_VERSION" "$SYSTEMD_VERSION" "$BUILT_AT" <<'PY'
import json, pathlib, sys
path, profile_sha, keyring_sha, package_sha, arch, kernel, firmware, systemd, built_at = sys.argv[1:]
state = {
  'schema': 'swir.system-base-build-state/0.1',
  'profile': 'debian-13-trixie',
  'suite': 'trixie',
  'architecture': arch,
  'profileSha256': profile_sha,
  'bootstrapKeyringSha256': keyring_sha,
  'packageSetSha256': package_sha,
  'kernelMetaPackageVersion': kernel,
  'firmwareMetaPackageVersion': firmware,
  'systemdVersion': systemd,
  'builtAt': built_at,
  'nativeAptSignatureVerification': True,
  'officialRepositoriesOnly': True,
  'driverPolicy': {
    'primaryDriverSourceClass': 'kernel-in-tree',
    'primaryFirmwareSourceClass': 'linux-firmware',
    'randomDriverDownloadsAllowed': False,
    'windowsKernelDriversSupported': False
  },
  'bootableImageClaim': False,
  'secureBootClaim': False,
  'hardwareQualificationClaim': False
}
pathlib.Path(path).write_text(json.dumps(state, indent=2) + '\n', encoding='utf-8')
PY
chmod 0600 "$ROOTFS/var/lib/swir/image/base-build-state.json"

echo "SWIR Debian 13 rootfs foundation built successfully at $ROOTFS"
echo "Kernel meta-package: $KERNEL_VERSION"
echo "Firmware meta-package: $FIRMWARE_VERSION"
echo "systemd: $SYSTEMD_VERSION"
echo "Bootstrap keyring SHA-256: $KEYRING_SHA256"
echo "Package-set SHA-256: $PACKAGE_SET_SHA256"
