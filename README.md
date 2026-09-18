<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-83.1%25-2ea043?style=for-the-badge)
![Completed](https://img.shields.io/badge/DONE-54%2F65-1f6feb?style=for-the-badge)

<img width="100%" src="assets/readme/swir-os-progress-card.svg" alt="SWIR OS roadmap progress — 83.1%, 54 of 65 verified deliverables" />

</div>

`Swir/swir.github.io` hosts the public SWIR OS preview and synchronized development status. It is **not** a source repository for the operating system and does not own roadmap truth.

## Canonical project

All SWIR OS implementation is developed in **[Swir/SWIR_OS](https://github.com/Swir/SWIR_OS)**: Web Edition, Desktop Edition, System Edition, native applications, services, package/runtime infrastructure, Live USB/installer work, hardware and driver work, CI, roadmap, builds and releases.

The authoritative roadmap is [SWIR_OS/SWIR-OS-ARCHITECTURE.md](https://github.com/Swir/SWIR_OS/blob/main/SWIR-OS-ARCHITECTURE.md). This site mirrors verified values only after they are merged there.

## Current verified status

| Edition | Status |
|---|---|
| Web Edition | `1.7.13` |
| Desktop Edition | `0.5.7-preview` |
| System Edition | In development |
| Overall roadmap | **54 / 65 — 83.1%** |
| Release readiness | **Not ready** |

The current canonical System Edition milestone set includes verified **SWIR Browser**, **SWIR Player**, the basic-editing milestone for **SWIR Photo Studio**, the native **SWIR PDF Viewer**, and now **SWIR Calculator**. Calculator is a first-party unprivileged GTK4 utility using a strict arithmetic AST allowlist rather than Python `eval`/`exec`; it bounds expression complexity, exponent/result magnitude and history, is wired into the trusted System Edition image and SWIR Shell, and has dedicated Wayland plus Debian 13 runtime verification. This closes a real Product Baseline utility gap but does **not** complete the broader native daily-use application-suite roadmap deliverable, so the authoritative roadmap remains 54 / 65 — 83.1%.

The existing boot/install path remains verified in disposable UEFI VMs: the final image boots as QEMU USB mass storage, the native GTK4 installer requires exact target review and destructive confirmation, installs to a separate blank disk, and the installed system boots graphically with persistence after the source USB is removed. This is meaningful VM evidence, **not** a claim of broad physical-PC support. Physical Live USB boot/install qualification is still open, and Secure Boot plus legacy BIOS remain unclaimed until separately tested.

The canonical repo uses deterministic **SWIR Progress SVG PRO** assets generated from the authoritative roadmap. The card shown here is a presentation snapshot using the same visual language; its source of truth remains `Swir/SWIR_OS`. The canonical roadmap/README presentation is SVG-only for progress meters; text values remain as accessible data, not duplicate character-based bars.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical snapshot commit: [`f9cf7cc`](https://github.com/Swir/SWIR_OS/commit/f9cf7ccc94c6d15699889af2da3a7f567b162cb2).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts, System/Desktop/Web implementation, build tooling and authoritative progress calculations must be committed to `Swir/SWIR_OS`, not here.