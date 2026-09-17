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
SHELL_MODE="${SWIR_WESTON_SHELL:-kiosk-shell.so}"
WESTON_LOG="$XDG_RUNTIME_DIR/swir-weston.log"
COG_LOG="$XDG_RUNTIME_DIR/swir-cog.log"
SHELL_ROOT="/usr/share/swir-shell"
SHELL_ENTRY="$SHELL_ROOT/swir-desktop.html"
SHELL_INTEGRITY="$SHELL_ROOT/.swir-integrity.sha256"
SHELL_URI="file://$SHELL_ENTRY"

[ -d "$XDG_RUNTIME_DIR" ] || { echo "missing XDG_RUNTIME_DIR: $XDG_RUNTIME_DIR" >&2; exit 70; }
[ "$(stat -c '%u' "$XDG_RUNTIME_DIR")" = "$UID_NOW" ] || { echo "runtime directory owner mismatch" >&2; exit 71; }
[ -x /usr/bin/weston ] || { echo "weston is not installed" >&2; exit 72; }
[ -x /usr/bin/cog ] || { echo "cog is not installed" >&2; exit 80; }
[ ! -L /usr/bin/cog ] && [ "$(stat -c '%u' /usr/bin/cog)" = 0 ] || { echo "cog binary trust check failed" >&2; exit 81; }
COG_MODE="$(stat -c '%a' /usr/bin/cog)"
case "$COG_MODE" in
  *[2367][0-7]|*[0-7][2367]) echo "cog binary is writable by group/world" >&2; exit 81 ;;
esac
[ -d "$SHELL_ROOT" ] && [ ! -L "$SHELL_ROOT" ] || { echo "SWIR shell bundle missing" >&2; exit 82; }
[ -f "$SHELL_ENTRY" ] && [ ! -L "$SHELL_ENTRY" ] || { echo "SWIR shell entry missing" >&2; exit 82; }
[ -f "$SHELL_INTEGRITY" ] && [ ! -L "$SHELL_INTEGRITY" ] || { echo "SWIR shell integrity manifest missing" >&2; exit 82; }
[ "$(stat -c '%u' "$SHELL_ROOT")" = 0 ] && [ "$(stat -c '%u' "$SHELL_ENTRY")" = 0 ] && [ "$(stat -c '%u' "$SHELL_INTEGRITY")" = 0 ] || {
  echo "SWIR shell bundle must be root-owned" >&2; exit 83;
}
(
  cd "$SHELL_ROOT"
  /usr/bin/sha256sum -c --strict .swir-integrity.sha256 >/dev/null
) || { echo "SWIR shell bundle integrity verification failed" >&2; exit 84; }

start_weston() {
  rm -f "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
  if [ "${SWIR_SESSION_E2E:-0}" = "1" ]; then
    /usr/bin/weston --no-config --backend="$BACKEND" --shell="$SHELL_MODE" --renderer=pixman --socket="$WAYLAND_DISPLAY" --idle-time=0 --log="$WESTON_LOG" &
  else
    /usr/bin/weston --no-config --backend="$BACKEND" --shell="$SHELL_MODE" --socket="$WAYLAND_DISPLAY" --idle-time=0 --log="$WESTON_LOG" &
  fi
  WESTON_PID=$!
  ready=0; i=0
  while [ "$i" -lt 100 ]; do
    if [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; then ready=1; break; fi
    if ! kill -0 "$WESTON_PID" 2>/dev/null; then break; fi
    i=$((i + 1)); sleep 0.25
  done
  [ "$ready" = "1" ] || { echo "weston Wayland socket did not become ready" >&2; exit 73; }
}

start_shell() {
  export COG_PLATFORM_WL_VIEW_FULLSCREEN=1
  WAYLAND_DISPLAY="$WAYLAND_DISPLAY" /usr/bin/cog --platform=wl "$SHELL_URI" >"$COG_LOG" 2>&1 &
  COG_PID=$!
  ready=0; web_process=0; i=0
  while [ "$i" -lt 120 ]; do
    if ! kill -0 "$COG_PID" 2>/dev/null; then
      echo "SWIR desktop shell exited before readiness" >&2
      tail -n 80 "$COG_LOG" >&2 2>/dev/null || true
      exit 85
    fi
    for proc in /proc/[0-9]*; do
      [ -r "$proc/cmdline" ] || continue
      [ "$(stat -c '%u' "$proc" 2>/dev/null || printf x)" = "$UID_NOW" ] || continue
      PROC_CMD="$(tr '\0' ' ' < "$proc/cmdline" 2>/dev/null || true)"
      case "$PROC_CMD" in
        *WebKitWebProcess*|*WPEWebProcess*) web_process=1; ready=1; break ;;
      esac
    done
    [ "$ready" = "1" ] && break
    i=$((i + 1)); sleep 0.25
  done
  [ "$ready" = "1" ] || { echo "SWIR desktop shell web process was not observed" >&2; tail -n 80 "$COG_LOG" >&2 2>/dev/null || true; exit 86; }
  [ "$web_process" = "1" ] || exit 86
  COG_UID="$(stat -c '%u' "/proc/$COG_PID")"
  [ "$COG_UID" = "$UID_NOW" ] || { echo "SWIR desktop shell uid mismatch" >&2; exit 87; }
  COG_CMDLINE="$(tr '\0' ' ' < "/proc/$COG_PID/cmdline")"
  printf '%s\n' "$COG_CMDLINE" | grep -Fq "$SHELL_URI" || { echo "SWIR desktop shell local entry not present in cog argv" >&2; exit 88; }
  printf '%s\n' "$COG_CMDLINE" | grep -Eq 'https?://' && { echo "SWIR desktop shell unexpectedly depends on a network URL" >&2; exit 89; }
}

start_weston
COG_PID=""
cleanup() {
  if [ -n "${COG_PID:-}" ]; then kill "$COG_PID" 2>/dev/null || true; wait "$COG_PID" 2>/dev/null || true; fi
  kill "$WESTON_PID" 2>/dev/null || true
  wait "$WESTON_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

[ -x /usr/bin/wayland-info ] || { echo "wayland-info is not installed" >&2; exit 74; }
WAYLAND_INFO="$XDG_RUNTIME_DIR/swir-wayland-info.txt"
WAYLAND_DISPLAY="$WAYLAND_DISPLAY" /usr/bin/wayland-info > "$WAYLAND_INFO"
grep -q 'interface:.*wl_compositor' "$WAYLAND_INFO" || grep -q 'wl_compositor' "$WAYLAND_INFO" || { echo "Wayland compositor global was not observed" >&2; exit 75; }
SESSION_ID="${XDG_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then SESSION_ID="$(/usr/bin/loginctl list-sessions --no-legend 2>/dev/null | awk -v uid="$UID_NOW" '$2 == uid { print $1; exit }')"; fi
[ -n "$SESSION_ID" ] || { echo "logind session id not found" >&2; exit 76; }
SESSION_SHOW="$(/usr/bin/loginctl show-session "$SESSION_ID" -p Id -p User -p Name -p Remote -p Active -p State -p Class -p Type -p Service -p Seat -p Leader 2>/dev/null)"
printf '%s\n' "$SESSION_SHOW" | grep -q "^User=$UID_NOW$" || { echo "logind user mismatch" >&2; exit 77; }
printf '%s\n' "$SESSION_SHOW" | grep -q '^Remote=no$' || { echo "session unexpectedly remote" >&2; exit 78; }
printf '%s\n' "$SESSION_SHOW" | grep -q '^Service=greetd$' || { echo "session was not created by greetd" >&2; exit 79; }
start_shell

if [ "${SWIR_SESSION_E2E:-0}" = "1" ]; then
  EVIDENCE="$XDG_RUNTIME_DIR/swir-graphical-session-evidence.json"
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/swir"
  SHELL_EVIDENCE="$STATE_DIR/system-desktop-shell-evidence.json"
  mkdir -p "$STATE_DIR"
  chmod 0700 "$(dirname "$STATE_DIR")" "$STATE_DIR" 2>/dev/null || true
  SHELL_ENTRY_SHA="$(sha256sum "$SHELL_ENTRY" | awk '{print $1}')"
  INTEGRITY_SHA="$(sha256sum "$SHELL_INTEGRITY" | awk '{print $1}')"
  ASSET_COUNT="$(wc -l < "$SHELL_INTEGRITY" | tr -d ' ')"
  COG_VERSION="$(dpkg-query -W -f='${Version}' cog)"
  export SWIR_EVIDENCE_PATH="$EVIDENCE" SWIR_SHELL_EVIDENCE_PATH="$SHELL_EVIDENCE" SWIR_EVIDENCE_USER="$USER_NOW" SWIR_EVIDENCE_UID="$UID_NOW" SWIR_EVIDENCE_SESSION="$SESSION_ID" SWIR_EVIDENCE_BACKEND="$BACKEND" SWIR_EVIDENCE_SOCKET="$WAYLAND_DISPLAY" SWIR_EVIDENCE_WESTON_PID="$WESTON_PID" SWIR_EVIDENCE_SESSION_SHOW="$SESSION_SHOW" SWIR_SHELL_COG_PID="$COG_PID" SWIR_SHELL_ENTRY="$SHELL_ENTRY" SWIR_SHELL_ENTRY_SHA="$SHELL_ENTRY_SHA" SWIR_SHELL_INTEGRITY_SHA="$INTEGRITY_SHA" SWIR_SHELL_ASSET_COUNT="$ASSET_COUNT" SWIR_SHELL_COG_VERSION="$COG_VERSION"
  /usr/bin/python3 - <<'PY'
import datetime, json, os, pathlib
props = {}
for line in os.environ['SWIR_EVIDENCE_SESSION_SHOW'].splitlines():
    if '=' in line:
        k, v = line.split('=', 1); props[k] = v
session = {
    'schema': 'swir.graphical-session-runtime-evidence/0.1', 'passed': True,
    'user': os.environ['SWIR_EVIDENCE_USER'], 'uid': int(os.environ['SWIR_EVIDENCE_UID']),
    'sessionId': os.environ['SWIR_EVIDENCE_SESSION'],
    'logind': {'service': props.get('Service'), 'remote': props.get('Remote'), 'active': props.get('Active'), 'state': props.get('State'), 'class': props.get('Class'), 'type': props.get('Type'), 'seat': props.get('Seat'), 'leader': props.get('Leader')},
    'wayland': {'compositor': 'weston', 'backend': os.environ['SWIR_EVIDENCE_BACKEND'], 'socket': os.environ['SWIR_EVIDENCE_SOCKET'], 'socketObserved': True, 'clientHandshakePassed': True, 'westonPid': int(os.environ['SWIR_EVIDENCE_WESTON_PID'])},
    'desktopShellClaim': False,
}
pathlib.Path(os.environ['SWIR_EVIDENCE_PATH']).write_text(json.dumps(session, sort_keys=True) + '\n', encoding='utf-8')
shell = {
    'schema': 'swir.system-desktop-shell-e2e/0.1',
    'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'passed': True, 'user': os.environ['SWIR_EVIDENCE_USER'], 'uid': int(os.environ['SWIR_EVIDENCE_UID']),
    'sessionId': os.environ['SWIR_EVIDENCE_SESSION'], 'sessionService': props.get('Service'), 'remoteSession': props.get('Remote') == 'yes',
    'waylandCompositor': 'weston', 'waylandBackend': os.environ['SWIR_EVIDENCE_BACKEND'], 'waylandSocket': os.environ['SWIR_EVIDENCE_SOCKET'],
    'runtime': 'cog-wpe-webkit', 'runtimePackage': 'cog', 'runtimeVersion': os.environ['SWIR_SHELL_COG_VERSION'], 'runtimePid': int(os.environ['SWIR_SHELL_COG_PID']),
    'runtimeUidMatchesSession': True, 'webProcessObserved': True, 'shellEntry': os.environ['SWIR_SHELL_ENTRY'], 'shellEntrySha256': os.environ['SWIR_SHELL_ENTRY_SHA'],
    'integrityManifestSha256': os.environ['SWIR_SHELL_INTEGRITY_SHA'], 'shellAssetCount': int(os.environ['SWIR_SHELL_ASSET_COUNT']), 'shellIntegrityVerified': True,
    'localFileOrigin': True, 'remoteShellUrlRequired': False, 'authenticatedGraphicalSession': True, 'secureBootClaim': False, 'hardwareQualificationClaim': False,
}
pathlib.Path(os.environ['SWIR_SHELL_EVIDENCE_PATH']).write_text(json.dumps(shell, sort_keys=True) + '\n', encoding='utf-8')
PY
  chmod 0600 "$EVIDENCE" "$SHELL_EVIDENCE"
  while kill -0 "$WESTON_PID" 2>/dev/null && kill -0 "$COG_PID" 2>/dev/null; do sleep 1; done
  if ! kill -0 "$COG_PID" 2>/dev/null; then echo "SWIR desktop shell exited while the graphical session was active" >&2; exit 90; fi
  wait "$WESTON_PID"
  exit $?
fi
if wait "$COG_PID"; then COG_RC=0; else COG_RC=$?; fi
kill "$WESTON_PID" 2>/dev/null || true
wait "$WESTON_PID" 2>/dev/null || true
exit "$COG_RC"
