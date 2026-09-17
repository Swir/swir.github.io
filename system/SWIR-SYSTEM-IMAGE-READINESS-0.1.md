# SWIR System Image Readiness Gate 0.1

## Goal

Before SWIR OS calls a Linux image a System Edition test target, the host must provide evidence for the services our current architecture actually depends on. This gate is intentionally read-only and cannot make a host ready by installing or reconfiguring anything.

## Required E2E host gates

The 0.1 gate checks:

- Linux host, distribution identity and visible kernel;
- `/proc` and `/sys` availability;
- one trusted base-distribution package manager from the current allowlist;
- a trusted `systemctl`/systemd client;
- a trusted `loginctl` client for the `systemd-logind` session identity boundary;
- Polkit `pkcheck` for the privileged broker boundary;
- NetworkManager `nmcli` for the native network adapter;
- the root-owned persistent catalog trust state directory at `/var/lib/swir/security/catalog-trust`.

Optional capability evidence is collected for `fwupdmgr`, Flatpak and Wine. Those optional providers do not decide whether the **core** host can enter System-image E2E; their individual scenario tests still remain separate gates.

The readiness summary separates `baseReady`, `securityReady`, `networkReady` and `sessionReady`. `systemImageReadyForE2E` is true only if every required gate passes.

## Safety

The probe executes no package manager, firmware, network, service-manager, login/session or compatibility command. It only reads `/etc/os-release`, kernel/platform metadata and filesystem metadata for known absolute paths. The report always states `readOnly=true` and the policy explicitly keeps `bootableImageClaim=false`.

A green readiness result means only that the host contains the prerequisites for the next E2E stage. It does **not** prove bootability, installer correctness, hardware support, Secure Boot, successful package mutations or recovery.

## Current base candidate

The first maintained rootfs candidate is Debian 13 `trixie` stable, described by `system/image/debian13-base-image-profile.json`. The dedicated rootfs E2E lane provisions the required binaries and persistent trust directory, then runs this same readiness gate from inside the Debian rootfs. That is stronger than a mocked contract test but still not a booted VM.

## Why this matters

The roadmap requires selecting a maintained Linux base from evidence rather than preference. This gate gives disposable rootfs/VM jobs a stable machine-readable preflight while preserving the distinction between **prerequisites present** and **a bootable SWIR System Edition actually verified**.
