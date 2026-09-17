#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <rootfs-directory>" >&2
  exit 2
fi
ROOTFS="$(readlink -m "$1")"
[[ -d "$ROOTFS" ]] || { echo "rootfs does not exist: $ROOTFS" >&2; exit 3; }

node - "$ROOTFS" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const readiness = JSON.parse(fs.readFileSync(path.join(root, 'var/lib/swir/system-image-readiness.json'), 'utf8'));
if (readiness.schema !== 'swir.system-image-readiness/0.1') throw new Error('readiness schema mismatch');
if (readiness.readOnly !== true) throw new Error('readiness report must remain read-only');
if (readiness.distribution?.id !== 'debian' || !String(readiness.distribution?.versionId || '').startsWith('13')) throw new Error('rootfs is not Debian 13');
if (readiness.summary?.systemImageReadyForE2E !== true) throw new Error(`required readiness gates failed: ${(readiness.summary?.blockers || []).join(',')}`);
for (const gate of readiness.gates.filter(item => item.required)) {
  if (gate.passed !== true) throw new Error(`required gate failed: ${gate.id}`);
}
if (readiness.summary?.optionalPassed < 3) throw new Error('fwupd, Flatpak and Wine optional provider gates must pass in the hybrid rootfs');
console.log('Readiness:', readiness.summary.requiredPassed + '/' + readiness.summary.requiredTotal, 'required; optional=', readiness.summary.optionalPassed + '/' + readiness.summary.optionalTotal);
NODE

source_file="$ROOTFS/etc/apt/sources.list"
[[ -f "$source_file" ]] || { echo "apt source list missing" >&2; exit 4; }
expected_sources=$(cat <<'EOF'
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main non-free-firmware
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie-updates main non-free-firmware
deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://security.debian.org/debian-security trixie-security main non-free-firmware
EOF
)
actual_sources=$(grep -Ev '^[[:space:]]*(#|$)' "$source_file")
if [[ "$actual_sources" != "$expected_sources" ]]; then
  echo "apt sources differ from the signed Debian 13 allowlist" >&2
  cat "$source_file" >&2
  exit 5
fi

if [[ -d "$ROOTFS/etc/apt/sources.list.d" ]]; then
  while IFS= read -r -d '' source_fragment; do
    if grep -Ev '^[[:space:]]*(#|$)' "$source_fragment" | grep -q .; then
      echo "unapproved active apt source fragment: $source_fragment" >&2
      cat "$source_fragment" >&2
      exit 5
    fi
  done < <(find "$ROOTFS/etc/apt/sources.list.d" -mindepth 1 -maxdepth 1 -type f -print0)
fi

for policy in org.swir.system.packages.policy org.swir.system.network.policy org.swir.system.firmware.policy; do
  file="$ROOTFS/usr/share/polkit-1/actions/$policy"
  [[ -f "$file" && ! -L "$file" ]] || { echo "Polkit policy missing or symlinked: $policy" >&2; exit 6; }
  [[ "$(stat -c '%u:%g:%a' "$file")" == "0:0:644" ]] || { echo "unsafe Polkit policy ownership/mode: $policy" >&2; exit 7; }
done

[[ "$(stat -c '%u:%g:%a' "$ROOTFS/var/lib/swir/security/catalog-trust")" == "0:0:700" ]] || { echo "unsafe catalog trust root" >&2; exit 8; }
[[ -f "$ROOTFS/usr/share/keyrings/debian-archive-keyring.gpg" ]] || { echo "Debian archive keyring missing" >&2; exit 9; }
compgen -G "$ROOTFS/boot/vmlinuz-*" >/dev/null || { echo "Debian kernel image missing" >&2; exit 10; }

for package in systemd-sysv dbus policykit-1 network-manager fwupd flatpak wine wine64 firmware-linux-free; do
  chroot "$ROOTFS" dpkg-query -W -f='${db:Status-Abbrev}\n' "$package" | grep -q '^ii ' || { echo "package not installed: $package" >&2; exit 11; }
done
for binary in /usr/bin/systemctl /usr/bin/pkcheck /usr/bin/nmcli /usr/bin/fwupdmgr /usr/bin/flatpak; do
  [[ -x "$ROOTFS$binary" ]] || { echo "required trusted binary missing: $binary" >&2; exit 12; }
  [[ ! -L "$ROOTFS$binary" || "$(readlink -f "$ROOTFS$binary")" == "$ROOTFS/usr/"* ]] || { echo "binary symlink escapes /usr: $binary" >&2; exit 13; }
done
[[ -x "$ROOTFS/usr/bin/wine64" || -x "$ROOTFS/usr/bin/wine" ]] || { echo "Wine runtime missing" >&2; exit 14; }

echo "SWIR Debian 13 rootfs verification: OK"
echo "Bootable image claim: false"
