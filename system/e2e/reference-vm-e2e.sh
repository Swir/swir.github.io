#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE="$ROOT_DIR/system/image/reference-image-profile.mjs"
READINESS_DIR="$ROOT_DIR/system/image"
ARTIFACT_DIR="${SWIR_VM_ARTIFACT_DIR:-}"
SSH_PORT="${SWIR_VM_SSH_PORT:-22222}"

for command in node curl gpgv sha256sum qemu-system-x86_64 qemu-img cloud-localds ssh scp ssh-keygen; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 2; }
done
[[ "$SSH_PORT" =~ ^[0-9]{2,5}$ ]] && (( SSH_PORT >= 1024 && SSH_PORT <= 65535 )) || { echo "Invalid SWIR_VM_SSH_PORT" >&2; exit 2; }

node "$PROFILE" --validate >/dev/null
BASE_URL="$(node "$PROFILE" --vm-base-url)"
IMAGE_NAME="$(node "$PROFILE" --vm-image)"
CHECKSUMS_NAME="$(node "$PROFILE" --vm-checksums)"
SIGNATURE_NAME="$(node "$PROFILE" --vm-signature)"
KEYRING="$(node "$PROFILE" --vm-keyring)"
[[ "$BASE_URL" == "https://cloud-images.ubuntu.com/releases/noble/release" ]] || { echo "Untrusted VM image source" >&2; exit 3; }
[[ "$IMAGE_NAME" == "ubuntu-24.04-server-cloudimg-amd64.img" ]] || { echo "Untrusted VM image filename" >&2; exit 3; }
[[ "$KEYRING" == "/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg" && -r "$KEYRING" ]] || { echo "Trusted Ubuntu cloud-image keyring is unavailable" >&2; exit 3; }

WORKDIR="$(mktemp -d /tmp/swir-reference-vm.XXXXXX)"
SERIAL="$WORKDIR/serial.log"
REPORT="$WORKDIR/readiness.json"
PIDFILE="$WORKDIR/qemu.pid"
SSH_KEY="$WORKDIR/id_ed25519"
QEMU_PID=''

publish_artifacts() {
  [[ -n "$ARTIFACT_DIR" ]] || return 0
  mkdir -p "$ARTIFACT_DIR"
  [[ -f "$SERIAL" ]] && cp "$SERIAL" "$ARTIFACT_DIR/serial.log" || true
  [[ -f "$REPORT" ]] && cp "$REPORT" "$ARTIFACT_DIR/readiness.json" || true
}

cleanup() {
  status=$?
  set +e
  publish_artifacts
  if [[ -f "$PIDFILE" ]]; then QEMU_PID="$(cat "$PIDFILE" 2>/dev/null || true)"; fi
  if [[ "$QEMU_PID" =~ ^[0-9]+$ ]]; then kill "$QEMU_PID" >/dev/null 2>&1 || true; fi
  if (( status != 0 )) && [[ -f "$SERIAL" ]]; then
    echo '--- VM serial tail ---' >&2
    tail -n 120 "$SERIAL" >&2 || true
  fi
  rm -rf --one-file-system "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT

cd "$WORKDIR"
CURL=(curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2)
"${CURL[@]}" -o "$CHECKSUMS_NAME" "$BASE_URL/$CHECKSUMS_NAME"
"${CURL[@]}" -o "$SIGNATURE_NAME" "$BASE_URL/$SIGNATURE_NAME"
gpgv --keyring "$KEYRING" "$SIGNATURE_NAME" "$CHECKSUMS_NAME"

checksum_line="$(grep -E "^[a-f0-9]{64} [*]?${IMAGE_NAME}$" "$CHECKSUMS_NAME" | head -n 1 || true)"
[[ -n "$checksum_line" ]] || { echo "Signed checksum list does not contain $IMAGE_NAME" >&2; exit 4; }
printf '%s\n' "$checksum_line" > image.sha256
"${CURL[@]}" -o "$IMAGE_NAME" "$BASE_URL/$IMAGE_NAME"
sha256sum -c image.sha256

qemu-img create -q -f qcow2 -F qcow2 -b "$WORKDIR/$IMAGE_NAME" "$WORKDIR/swir-overlay.qcow2" 12G
ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY"
SSH_PUBLIC="$(cat "$SSH_KEY.pub")"

cat > user-data <<CLOUD
#cloud-config
users:
  - name: swir
    gecos: SWIR E2E
    groups: [adm, sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - $SSH_PUBLIC
package_update: true
packages:
  - ca-certificates
  - policykit-1
  - network-manager
  - nodejs
  - fwupd
  - flatpak
runcmd:
  - [install, -d, -m, '0700', -o, root, -g, root, /var/lib/swir/security/catalog-trust]
  - [systemctl, enable, --now, NetworkManager]
final_message: "SWIR reference VM cloud-init complete"
CLOUD
cat > meta-data <<'META'
instance-id: swir-reference-vm-e2e
local-hostname: swir-reference
META
cloud-localds seed.img user-data meta-data

if [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]; then
  ACCEL=(-accel kvm -cpu host)
else
  ACCEL=(-accel tcg,thread=multi -cpu max)
fi

qemu-system-x86_64 \
  "${ACCEL[@]}" \
  -machine q35 \
  -m 2048 -smp 2 \
  -drive "file=$WORKDIR/swir-overlay.qcow2,format=qcow2,if=virtio,discard=unmap" \
  -drive "file=$WORKDIR/seed.img,format=raw,if=virtio,readonly=on" \
  -device virtio-net-pci,netdev=net0 \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
  -display none -serial "file:$SERIAL" \
  -no-reboot -daemonize -pidfile "$PIDFILE"

SSH=(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null swir@127.0.0.1)
SCP=(scp -q -i "$SSH_KEY" -P "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
ssh_ready=0
for _ in $(seq 1 120); do
  if "${SSH[@]}" true >/dev/null 2>&1; then ssh_ready=1; break; fi
  sleep 2
done
(( ssh_ready == 1 )) || { echo "SSH did not become ready in the reference VM" >&2; exit 5; }

"${SSH[@]}" sudo cloud-init status --wait
"${SSH[@]}" 'test "$(. /etc/os-release; printf %s "$ID")" = ubuntu && test "$(. /etc/os-release; printf %s "$VERSION_ID")" = 24.04'
"${SSH[@]}" 'test "$(systemctl is-active NetworkManager)" = active'
"${SSH[@]}" 'test "$(systemctl is-active systemd-logind)" = active'
"${SSH[@]}" 'command -v pkcheck >/dev/null && command -v nmcli >/dev/null && command -v loginctl >/dev/null && command -v fwupdmgr >/dev/null && command -v flatpak >/dev/null'

"${SCP[@]}" "$READINESS_DIR/system-image-readiness.mjs" "$READINESS_DIR/system-image-readiness-probe.mjs" swir@127.0.0.1:/tmp/
"${SSH[@]}" 'sudo install -d -m 0755 -o root -g root /opt/swir/system/image && sudo install -m 0644 -o root -g root /tmp/system-image-readiness.mjs /opt/swir/system/image/system-image-readiness.mjs && sudo install -m 0755 -o root -g root /tmp/system-image-readiness-probe.mjs /opt/swir/system/image/system-image-readiness-probe.mjs'
"${SSH[@]}" 'sudo node /opt/swir/system/image/system-image-readiness-probe.mjs --compact' > "$REPORT"

node - "$REPORT" <<'NODE'
const fs = require('fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (report.schema !== 'swir.system-image-readiness/0.1' || report.readOnly !== true) throw new Error('invalid VM readiness report');
if (report.distribution?.id !== 'ubuntu' || report.distribution?.versionId !== '24.04') throw new Error('reference VM distribution drifted');
if (report.summary?.systemImageReadyForE2E !== true) throw new Error(`reference VM readiness failed: ${(report.summary?.blockers || []).join(',')}`);
if (report.summary?.sessionReady !== true || report.summary?.networkReady !== true || report.summary?.securityReady !== true) throw new Error('native System service prerequisite summary is incomplete');
const gate = id => report.gates.find(item => item.id === id);
for (const id of ['trusted-package-manager', 'systemd-service-manager', 'session-identity-client', 'polkit-broker', 'networkmanager-client', 'catalog-trust-state-root']) {
  if (gate(id)?.passed !== true) throw new Error(`required VM gate failed: ${id}`);
}
if (gate('fwupd-discovery')?.passed !== true || gate('flatpak-runtime')?.passed !== true) throw new Error('provisioned optional providers were not detected');
console.log(`Reference VM readiness: ${report.summary.requiredPassed}/${report.summary.requiredTotal} required gates; session/network/security ready`);
NODE

"${SSH[@]}" 'printf "kernel=%s\n" "$(uname -r)"; loginctl list-sessions --no-legend || true; nmcli -t -f GENERAL.STATE general status; fwupdmgr --version | head -n 4; flatpak --version'

printf 'SWIR reference VM E2E passed: signed Ubuntu base booted under QEMU and native System prerequisites passed. SWIR-built bootable-image claim remains false.\n'
