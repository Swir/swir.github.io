# SWIR System Image Readiness Gate 0.1

## Goal

Before SWIR OS calls a Linux image a System Edition test target, the host must provide evidence for the services our current architecture actually depends on. This gate is intentionally read-only and cannot make a host ready by installing or reconfiguring anything.

## Required E2E host gates

The 0.1 gate checks:

- Linux host, distribution identity and visible kernel;
- `/proc` and `/sys` availability;
- one trusted base-distribution package manager from the current allowlist;
- a trusted `systemctl`/systemd client;
- Polkit `pkcheck` for the privileged broker boundary;
- NetworkManager `nmcli` for the planned native network adapter;
- the root-owned persistent catalog trust state directory at `/var/lib/swir/security/catalog-trust`.

Optional capability evidence is collected for `fwupdmgr`, Flatpak and Wine. Those optional providers do not decide whether the **core** host can enter System-image E2E; their individual scenario tests still remain separate gates.

## Safety

The probe executes no package manager, firmware, network, service-manager or compatibility command. It only reads `/etc/os-release`, kernel/platform metadata and filesystem metadata for known absolute paths. The report always states `readOnly=true` and the policy explicitly keeps `bootableImageClaim=false`.

A green readiness result means only that the host contains the prerequisites for the next E2E stage. It does **not** prove bootability, installer correctness, hardware support, Secure Boot, successful package mutations or recovery.

## Why this matters

The roadmap requires selecting a maintained Linux base from evidence rather than preference. This gate gives upcoming disposable VM jobs a stable machine-readable preflight so Ubuntu/Fedora/immutable candidates can be compared using the same required services and security boundary.
