#!/bin/sh
set -eu

umask 077
UID_NOW="$(id -u)"
USER_NOW="$(id -un)"
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_NOW}"
export XDG_RUNTIME_DIR
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=SWIR
export XDG_SESSION_DESKTOP=swir
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-swir}"
BACKEND="${SWIR_WESTON_BACKEND:-drm}"
SHELL_MODE="${SWIR_WESTON_SHELL:-kiosk}"
WESTON_LOG="$XDG_RUNTIME_DIR/swir-weston.log"

[ -d "$XDG_RUNTIME_DIR" ] || { echo "missing XDG_RUNTIME_DIR: $XDG_RUNTIME_DIR" >&2; exit 70; }
[ "$(stat -c '%u' "$XDG_RUNTIME_DIR")" = "$UID_NOW" ] || { echo "runtime directory owner mismatch" >&2; exit 71; }
[ -x /usr/bin/weston ] || { echo "weston is not installed" >&2; exit 72; }

if [ "${SWIR_SESSION_E2E:-0}" = "1" ]; then
  EVIDENCE="$XDG_RUNTIME_DIR/swir-graphical-session-evidence.json"
  WAYLAND_INFO="$XDG_RUNTIME_DIR/swir-wayland-info.txt"
  rm -f "$EVIDENCE" "$WAYLAND_INFO" "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"

  /usr/bin/weston \
    --backend="$BACKEND" \
    --shell="$SHELL_MODE" \
    --socket="$WAYLAND_DISPLAY" \
    --idle-time=0 \
    --log="$WESTON_LOG" &
  WESTON_PID=$!
  cleanup() { kill "$WESTON_PID" 2>/dev/null || true; wait "$WESTON_PID" 2>/dev/null || true; }
  trap cleanup EXIT INT TERM

  ready=0
  i=0
  while [ "$i" -lt 80 ]; do
    if [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then ready=1; break; fi
    if ! kill -0 "$WESTON_PID" 2>/dev/null; then break; fi
    i=$((i + 1))
    sleep 0.25
  done
  [ "$ready" = "1" ] || { echo "weston Wayland socket did not become ready" >&2; exit 73; }

  [ -x /usr/bin/wayland-info ] || { echo "wayland-info is not installed" >&2; exit 74; }
  WAYLAND_DISPLAY="$WAYLAND_DISPLAY" /usr/bin/wayland-info > "$WAYLAND_INFO"
  grep -q 'interface:.*wl_compositor' "$WAYLAND_INFO" || grep -q 'wl_compositor' "$WAYLAND_INFO" || { echo "Wayland compositor global was not observed" >&2; exit 75; }

  SESSION_ID="${XDG_SESSION_ID:-}"
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(/usr/bin/loginctl list-sessions --no-legend 2>/dev/null | awk -v uid="$UID_NOW" '$2 == uid { print $1; exit }')"
  fi
  [ -n "$SESSION_ID" ] || { echo "logind session id not found" >&2; exit 76; }
  SESSION_SHOW="$(/usr/bin/loginctl show-session "$SESSION_ID" -p Id -p User -p Name -p Remote -p Active -p State -p Class -p Type -p Service -p Seat -p Leader 2>/dev/null)"
  printf '%s\n' "$SESSION_SHOW" | grep -q "^User=$UID_NOW$" || { echo "logind user mismatch" >&2; exit 77; }
  printf '%s\n' "$SESSION_SHOW" | grep -q '^Remote=no$' || { echo "session unexpectedly remote" >&2; exit 78; }
  printf '%s\n' "$SESSION_SHOW" | grep -q '^Service=greetd$' || { echo "session was not created by greetd" >&2; exit 79; }

  export SWIR_EVIDENCE_PATH="$EVIDENCE"
  export SWIR_EVIDENCE_USER="$USER_NOW"
  export SWIR_EVIDENCE_UID="$UID_NOW"
  export SWIR_EVIDENCE_SESSION="$SESSION_ID"
  export SWIR_EVIDENCE_BACKEND="$BACKEND"
  export SWIR_EVIDENCE_SOCKET="$WAYLAND_DISPLAY"
  export SWIR_EVIDENCE_WESTON_PID="$WESTON_PID"
  export SWIR_EVIDENCE_SESSION_SHOW="$SESSION_SHOW"
  /usr/bin/python3 - <<'PY'
import json, os, pathlib
props = {}
for line in os.environ['SWIR_EVIDENCE_SESSION_SHOW'].splitlines():
    if '=' in line:
        k, v = line.split('=', 1)
        props[k] = v
out = {
    'schema': 'swir.graphical-session-runtime-evidence/0.1',
    'passed': True,
    'user': os.environ['SWIR_EVIDENCE_USER'],
    'uid': int(os.environ['SWIR_EVIDENCE_UID']),
    'sessionId': os.environ['SWIR_EVIDENCE_SESSION'],
    'logind': {
        'service': props.get('Service'),
        'remote': props.get('Remote'),
        'active': props.get('Active'),
        'state': props.get('State'),
        'class': props.get('Class'),
        'type': props.get('Type'),
        'seat': props.get('Seat'),
        'leader': props.get('Leader'),
    },
    'wayland': {
        'compositor': 'weston',
        'backend': os.environ['SWIR_EVIDENCE_BACKEND'],
        'socket': os.environ['SWIR_EVIDENCE_SOCKET'],
        'socketObserved': True,
        'clientHandshakePassed': True,
        'westonPid': int(os.environ['SWIR_EVIDENCE_WESTON_PID']),
    },
    'desktopShellClaim': False,
}
path = pathlib.Path(os.environ['SWIR_EVIDENCE_PATH'])
path.write_text(json.dumps(out, sort_keys=True) + '\n', encoding='utf-8')
PY
  chmod 0600 "$EVIDENCE"

  # Keep the authenticated graphical session alive until the root E2E monitor
  # has copied and validated its evidence.
  while kill -0 "$WESTON_PID" 2>/dev/null; do sleep 1; done
  wait "$WESTON_PID"
  exit $?
fi

exec /usr/bin/weston \
  --backend="$BACKEND" \
  --shell="$SHELL_MODE" \
  --socket="$WAYLAND_DISPLAY" \
  --idle-time=0 \
  --log="$WESTON_LOG"
