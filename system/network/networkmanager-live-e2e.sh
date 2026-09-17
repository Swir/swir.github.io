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
PEER_IFNAME='swir-peer'
NM_LOG='/tmp/swir-networkmanager-live-e2e.log'
NM_CONFIG='/tmp/swir-NetworkManager.conf'
NM_CONFIG_DIR='/tmp/swir-networkmanager-conf.d'
NM_SYSTEM_CONFIG_DIR='/tmp/swir-networkmanager-system-conf.d'

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
# Keep all test links inside this private network namespace. A veth pair gives
# NetworkManager a standard Ethernet device without attaching it to any host or
# external network.
ip link add "$IFNAME" type veth peer name "$PEER_IFNAME"
ip link set "$IFNAME" down
ip link set "$PEER_IFNAME" down

# Hosted runners may carry udev/cloud policy that marks synthetic links
# unmanaged. The NetworkManager device section is the documented higher-
# priority mechanism for explicitly managing a selected interface. We also
# isolate runtime/system drop-in directories so host policy does not determine
# the test result.
install -d -m 0755 "$NM_CONFIG_DIR" "$NM_SYSTEM_CONFIG_DIR"
cat >"$NM_CONFIG" <<EOF
[main]
plugins=keyfile
no-auto-default=*
ignore-carrier=interface-name:$IFNAME
dns=none
rc-manager=unmanaged

[device-swir-e2e]
match-device=interface-name:$IFNAME
managed=1

[device-swir-peer]
match-device=interface-name:$PEER_IFNAME
managed=0
EOF
chmod 0600 "$NM_CONFIG"

NetworkManager \
  --no-daemon \
  --config "$NM_CONFIG" \
  --config-dir "$NM_CONFIG_DIR" \
  --system-config-dir "$NM_SYSTEM_CONFIG_DIR" \
  >"$NM_LOG" 2>&1 &
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

# Make the managed state observable before creating the profile. If policy still
# marks the device strictly unmanaged, fail here with diagnostics rather than
# weakening the production service or touching host networking.
if ! nmcli --terse --fields GENERAL.MANAGED device show "$IFNAME" | grep -Eq '(^|:)yes$'; then
  echo "isolated E2E interface is not managed by NetworkManager" >&2
  nmcli --terse device status >&2 || true
  NetworkManager --print-config --config "$NM_CONFIG" --config-dir "$NM_CONFIG_DIR" --system-config-dir "$NM_SYSTEM_CONFIG_DIR" >&2 || true
  tail -n 120 "$NM_LOG" >&2 || true
  exit 7
fi

nmcli connection add \
  type ethernet \
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
