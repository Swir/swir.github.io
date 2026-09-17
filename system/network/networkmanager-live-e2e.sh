#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "networkmanager-live-e2e.sh must run as root inside an isolated namespace" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${1:-/tmp/swir-networkmanager-live-e2e.json}"
UUID='7c3d5747-91f7-4dd6-8c41-78c9bc407e17'
IFNAME='swir0'
NM_LOG='/tmp/swir-networkmanager-live-e2e.log'

for command in mount dbus-daemon ip nmcli NetworkManager node; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 3; }
done

case "$(readlink -m "$OUTPUT")" in
  /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/usr|/var)
    echo "refusing unsafe output path: $OUTPUT" >&2; exit 4 ;;
esac

mount --make-rprivate /
install -d -m 0755 /run /var/lib/NetworkManager /etc/NetworkManager/system-connections
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /run
install -d -m 0755 /run/dbus /run/NetworkManager
mount -t tmpfs -o mode=0700,nosuid,nodev tmpfs /var/lib/NetworkManager
mount -t tmpfs -o mode=0700,nosuid,nodev tmpfs /etc/NetworkManager/system-connections

cleanup() {
  set +e
  [[ -n "${NM_PID:-}" ]] && kill "$NM_PID" 2>/dev/null || true
  [[ -n "${DBUS_PID:-}" ]] && kill "$DBUS_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

dbus-daemon --system --fork --nopidfile --print-pid=1 > /tmp/swir-dbus-pid
DBUS_PID="$(cat /tmp/swir-dbus-pid)"
[[ "$DBUS_PID" =~ ^[0-9]+$ ]] || { echo "invalid dbus pid" >&2; exit 5; }

ip link set lo up
ip link add "$IFNAME" type dummy
ip link set "$IFNAME" down

NetworkManager --no-daemon >"$NM_LOG" 2>&1 &
NM_PID=$!

ready=0
for _ in $(seq 1 60); do
  if nmcli --terse general status >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [[ $ready -ne 1 ]]; then
  echo "NetworkManager did not become ready" >&2
  tail -n 120 "$NM_LOG" >&2 || true
  exit 6
fi

nmcli connection add \
  type dummy \
  ifname "$IFNAME" \
  con-name swir-e2e \
  connection.uuid "$UUID" \
  connection.autoconnect no \
  ipv4.method disabled \
  ipv6.method disabled >/dev/null

node "$SCRIPT_DIR/networkmanager-live-e2e.mjs" --output "$OUTPUT"

node - "$OUTPUT" <<'NODE'
const fs = require('fs');
const evidence = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (evidence?.schema !== 'swir.networkmanager-live-e2e/0.1' || evidence?.passed !== true) process.exit(2);
if (!evidence.activationVerified || !evidence.deactivationVerified || !evidence.authorizationPlanDigestBound) process.exit(3);
if (evidence.externalNetworkRequired !== false || evidence.hostNetworkMutationClaim !== false) process.exit(4);
NODE

printf 'SWIR NetworkManager isolated live E2E passed\n'
