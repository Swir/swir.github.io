# SWIR System Desktop Shell UEFI E2E 0.1

## Purpose

This gate proves that the existing SWIR OS desktop is no longer only a browser-hosted Web Edition surface. The selected Debian 13 System Edition image stages the audited SWIR desktop runtime into the image and launches it as the authenticated graphical user's desktop shell through a distro-managed WPE WebKit container.

The runtime path is:

```text
UEFI -> systemd-boot -> Debian 13 -> systemd -> greetd/PAM -> logind
     -> Weston/Wayland -> Cog (WPE WebKit) -> file:///usr/share/swir-shell/swir-desktop.html
```

Cog is installed from the same signed Debian repositories as the selected System Edition base. SWIR does not download an external browser binary or execute the shell through a command shell.

## Shell bundle trust model

`provision-graphical-session.sh` installs only audited top-level SWIR runtime assets matching the desktop runtime classes (`swir-*.html`, `swir-*.js`, `swir-*.css`, `swir-icon.svg`, and `manifest.webmanifest`) into `/usr/share/swir-shell`.

The provisioner deliberately excludes legacy/history directories, PHP server endpoints, arbitrary repository files and symlinked source assets. Installed assets are root-owned, read-only to the graphical user, and covered by `/usr/share/swir-shell/.swir-integrity.sha256`.

`swir-session-launcher.sh` verifies that integrity manifest before starting the desktop runtime. It also verifies the distro Cog executable is root-owned and not writable by group/world.

## What the VM gate proves

The dedicated E2E reuses the already verified Debian 13 UEFI graphical image lane and requires all of the following before evidence is emitted:

1. greetd created a non-root authenticated PAM/logind session for `swir-e2e`;
2. Weston created the expected Wayland socket and a real Wayland client handshake succeeded;
3. the SWIR shell bundle passes SHA-256 integrity verification inside the guest;
4. `/usr/bin/cog` starts as the authenticated session UID, not root;
5. Cog receives only the local `file:///usr/share/swir-shell/swir-desktop.html` entry in its launch command;
6. a WPE/WebKit web process owned by the same user is observed while the session is alive;
7. the retained boot disk contains the same root-owned shell bundle and integrity manifest after shutdown;
8. the host re-verifies every shell asset against that manifest and confirms the desktop DOM root and platform bridge integration are present.

The older graphical-session evidence intentionally keeps `desktopShellClaim=false` for compatibility with its scoped 0.1 schema. The independent `swir.system-desktop-shell-e2e/0.1` evidence is the source of truth for the desktop-shell roadmap gate.

## Production behavior

Production uses the same `/usr/local/bin/swir-session` launcher. It starts Weston, validates the local shell bundle, launches Cog using argv (no shell), and ties the lifetime of the graphical session to the desktop runtime. If the desktop runtime exits, the compositor is stopped and control returns to the authenticated greeter instead of leaving a compositor-only session behind.

## Non-claims

This gate does **not** claim Secure Boot qualification, broad physical GPU/display qualification, installer/recovery completion, a final native replacement for the WebKit-hosted SWIR UI, or that every optional network-backed widget works without connectivity.

It proves the System Edition desktop-shell integration and its local boot path, while keeping the existing portable SWIR application model available for the later native adapter work.
