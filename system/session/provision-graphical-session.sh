#!/usr/bin/env bash
set -euo pipefail

ROOTFS=""
MODE="production"
SOURCE_ROOT=""
while (($#)); do
  case "$1" in
    --rootfs) ROOTFS="${2:-}"; shift 2 ;;
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --e2e) MODE="e2e"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "graphical session provisioning requires root" >&2; exit 77; }
[[ -n "$ROOTFS" && "$ROOTFS" = /* && "$ROOTFS" != / ]] || { echo "--rootfs must be an absolute non-root path" >&2; exit 64; }
[[ -d "$ROOTFS" && ! -L "$ROOTFS" ]] || { echo "rootfs must be a real directory" >&2; exit 73; }
ROOTFS="$(readlink -f "$ROOTFS")"
[[ "$(stat -c '%u' "$ROOTFS")" = 0 ]] || { echo "rootfs must be root-owned" >&2; exit 78; }
(( (8#$(stat -c '%a' "$ROOTFS") & 8#022) == 0 )) || { echo "rootfs must not be group/world writable" >&2; exit 78; }

if [[ -z "$SOURCE_ROOT" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SOURCE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
[[ "$SOURCE_ROOT" = /* && -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]] || { echo "source root invalid" >&2; exit 64; }
SOURCE_ROOT="$(readlink -f "$SOURCE_ROOT")"

safe_target() {
  local rel="$1" dest current part
  [[ "$rel" == /* && "$rel" != / ]] || { echo "unsafe managed path: $rel" >&2; exit 73; }
  [[ "$rel" != *'/../'* && "$rel" != */.. && "$rel" != /..* ]] || { echo "unsafe managed path: $rel" >&2; exit 73; }
  dest="$ROOTFS$rel"
  current="$ROOTFS"
  IFS='/' read -r -a parts <<< "${rel#/}"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != . && "$part" != .. ]] || { echo "unsafe managed path component: $rel" >&2; exit 73; }
    current="$current/$part"
    if [[ -L "$current" ]]; then echo "refusing symlink traversal: $rel" >&2; exit 73; fi
  done
  printf '%s\n' "$dest"
}

for pkg in greetd weston plymouth plymouth-themes wayland-utils dbus-user-session; do
  chroot "$ROOTFS" dpkg-query -W -f='${db:Status-Abbrev}' "$pkg" 2>/dev/null | grep -qx 'ii ' || {
    echo "required graphical package is not installed: $pkg" >&2
    exit 69
  }
done
for file in /usr/sbin/greetd /usr/sbin/agreety /usr/bin/weston /usr/bin/wayland-info /usr/bin/plymouth /usr/sbin/plymouth-set-default-theme; do
  target="$(safe_target "$file")"
  [[ -f "$target" && ! -L "$target" && -x "$target" ]] || { echo "required trusted executable missing: $file" >&2; exit 69; }
  [[ "$(stat -c '%u' "$target")" = 0 ]] || { echo "required executable must be root-owned: $file" >&2; exit 78; }
  file_mode="$(stat -c '%a' "$target")"
  (( (8#$file_mode & 8#022) == 0 )) || { echo "required executable writable by group/world: $file" >&2; exit 78; }
done

install -d -m 0755 \
  "$(safe_target /etc/greetd)" \
  "$(safe_target /usr/local/bin)" \
  "$(safe_target /usr/local/lib/swir)" \
  "$(safe_target /usr/share/wayland-sessions)" \
  "$(safe_target /usr/share/plymouth/themes/swir)" \
  "$(safe_target /etc/systemd/system/graphical.target.wants)"

install -m 0755 "$SOURCE_ROOT/system/session/swir-session-launcher.sh" "$(safe_target /usr/local/bin/swir-session)"
install -m 0644 "$SOURCE_ROOT/system/boot/plymouth/swir.plymouth" "$(safe_target /usr/share/plymouth/themes/swir/swir.plymouth)"
install -m 0644 "$SOURCE_ROOT/system/boot/plymouth/swir.script" "$(safe_target /usr/share/plymouth/themes/swir/swir.script)"

cat > "$(safe_target /usr/share/wayland-sessions/swir.desktop)" <<'EOF'
[Desktop Entry]
Name=SWIR OS
Comment=SWIR OS System Edition Wayland session
Exec=/usr/local/bin/swir-session
TryExec=/usr/local/bin/swir-session
Type=Application
DesktopNames=SWIR
EOF
chmod 0644 "$(safe_target /usr/share/wayland-sessions/swir.desktop)"

if [[ "$MODE" == production ]]; then
  cat > "$(safe_target /etc/greetd/config.toml)" <<'EOF'
[terminal]
vt = 7

[default_session]
command = "/usr/sbin/agreety --cmd /usr/local/bin/swir-session"
user = "_greetd"
EOF
else
  # The E2E image exercises greetd IPC and PAM with a disposable account. No
  # auto-login section is used; the session must pass the real auth exchange.
  if ! chroot "$ROOTFS" /usr/bin/id -u swir-e2e >/dev/null 2>&1; then
    chroot "$ROOTFS" /usr/sbin/useradd --create-home --shell /bin/bash --user-group swir-e2e
  fi
  [[ "$(chroot "$ROOTFS" /usr/bin/id -u swir-e2e)" -ge 1000 ]] || { echo "E2E session account must be unprivileged" >&2; exit 70; }
  printf '%s\n' 'swir-e2e:SWIR-E2E-Only-2026!' | chroot "$ROOTFS" /usr/sbin/chpasswd
  install -m 0755 "$SOURCE_ROOT/system/session/greetd-e2e-greeter.py" "$(safe_target /usr/local/lib/swir/greetd-e2e-greeter.py)"
  cat > "$(safe_target /etc/greetd/config.toml)" <<'EOF'
[terminal]
vt = 7

[default_session]
command = "/usr/bin/env SWIR_E2E_USERNAME=swir-e2e SWIR_E2E_PASSWORD=SWIR-E2E-Only-2026! /usr/local/lib/swir/greetd-e2e-greeter.py"
user = "_greetd"
EOF
fi
chmod 0644 "$(safe_target /etc/greetd/config.toml)"

ln -sfn /usr/lib/systemd/system/greetd.service "$(safe_target /etc/systemd/system/display-manager.service)"
ln -sfn /usr/lib/systemd/system/greetd.service "$(safe_target /etc/systemd/system/graphical.target.wants/greetd.service)"
ln -sfn /usr/lib/systemd/system/graphical.target "$(safe_target /etc/systemd/system/default.target)"

# Install the SWIR theme into initramfs using Debian's packaged tooling.
chroot "$ROOTFS" /usr/sbin/plymouth-set-default-theme swir
[[ "$(chroot "$ROOTFS" /usr/sbin/plymouth-set-default-theme)" == swir ]] || { echo "SWIR Plymouth theme was not selected" >&2; exit 70; }
chroot "$ROOTFS" /usr/sbin/update-initramfs -u -k all

# Production retains an authenticated greeter path and never embeds test creds.
if [[ "$MODE" == production ]]; then
  grep -Fq '/usr/sbin/agreety --cmd /usr/local/bin/swir-session' "$ROOTFS/etc/greetd/config.toml" || {
    echo "production greetd configuration lost authenticated greeter path" >&2; exit 70;
  }
  ! grep -Fq 'SWIR-E2E-Only-2026!' "$ROOTFS/etc/greetd/config.toml" || { echo "test credential leaked into production config" >&2; exit 70; }
fi
! grep -Fq '[initial_session]' "$ROOTFS/etc/greetd/config.toml" || { echo "autologin initial_session is forbidden" >&2; exit 70; }
[[ -f "$ROOTFS/etc/pam.d/greetd" && ! -L "$ROOTFS/etc/pam.d/greetd" ]] || { echo "greetd PAM policy missing" >&2; exit 70; }

echo "SWIR graphical session foundation staged: mode=$MODE theme=swir login=greetd compositor=weston"
