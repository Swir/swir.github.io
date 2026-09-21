<!-- SWIR-README-STANDARD:v2 -->
<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-87.7%25-02050A?style=for-the-badge&logoColor=62E5FF)
![Completed](https://img.shields.io/badge/DONE-57%2F65-02050A?style=for-the-badge&logoColor=62E5FF)

<img width="100%" src="assets/readme/swir-os-progress-card.svg" alt="SWIR OS roadmap progress — 87.7%, 57 of 65 verified deliverables" />

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
| Overall roadmap | **57 / 65 — 87.7%** |
| Release readiness | **Not ready** |

The latest canonical milestone is merged **PR #70**, which adds a bounded shared native i18n runtime for System Edition, reviewed English/Polish/Norwegian Bokmål catalogs, first-profile POSIX locale detection, real localized GTK4 Settings surfaces, safe English fallback, installed-rootfs staging and headless Wayland locale verification. This improves the native daily-use foundation without claiming the entire native application suite is complete.

The native daily-use application suite therefore remains open: suite-wide locale/accessibility depth and final daily-use integration still require verification across the supported first-party applications. Existing verified native foundations include SWIR Browser, SWIR Player, Photo Studio, PDF Viewer, Text Editor, Settings, Files, Calculator, Task Manager/Diagnostics and the other capabilities documented in the canonical repository.

The existing boot/install path remains verified in disposable UEFI VMs: the final image boots as QEMU USB mass storage, the native GTK4 installer requires exact target review and destructive confirmation, installs to a separate blank disk, and the installed system boots graphically with persistence after the source USB is removed. This is meaningful VM evidence, **not** a claim of broad physical-PC support. Physical Live USB boot/install qualification is still open, and Secure Boot plus legacy BIOS remain unclaimed until separately tested.

Desktop Update Center also retains the merged Manual / Notify only / Automatic policy enforcement and signed-feed security foundations; trusted-shell UI/scheduler integration and final release/install E2E remain separate open work.

The canonical repo uses deterministic **SWIR Progress SVG PRO** assets generated from the authoritative roadmap. The card shown here is a presentation snapshot using the same visual language; its source of truth remains `Swir/SWIR_OS`. The canonical roadmap/README presentation is SVG-only for progress meters; text values remain as accessible data, not duplicate character-based bars.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical snapshot commit: [`8335d447`](https://github.com/Swir/SWIR_OS/commit/8335d447aae0fca8eadf691d944b15657127a458).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts, System/Desktop/Web implementation, build tooling and authoritative progress calculations must be committed to `Swir/SWIR_OS`, not here.
