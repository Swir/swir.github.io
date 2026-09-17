<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-76.9%25-2ea043?style=for-the-badge)
![Completed](https://img.shields.io/badge/DONE-50%2F65-1f6feb?style=for-the-badge)

<img width="100%" src="assets/readme/swir-os-progress-card.svg" alt="SWIR OS roadmap progress — 76.9%, 50 of 65 verified deliverables" />

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
| Overall roadmap | **50 / 65 — 76.9%** |
| Release readiness | **Not ready** |

The latest verified System Edition milestone closes the **native graphical Live installer VM gate**. The real GTK4 installer now drives the complete disposable UEFI test path: exact stable target selection and read-only review, deliberate rejection of a wrong destructive confirmation token, account/locale/keyboard/time-zone setup, the normal narrow privileged helper, installation to a separate blank disk, source USB detachment, then standalone graphical boot from the installed disk with persistent data.

The project also verifies the Live image as QEMU USB mass storage and keeps the target disk unchanged through idle/preview/cancel rejection paths. This is meaningful UEFI VM evidence, **not** a claim of broad physical-PC support. Physical Live USB boot/install qualification is still open, and Secure Boot plus legacy BIOS remain unclaimed until separately tested.

The canonical repo now also uses deterministic **SWIR Progress SVG PRO** assets generated from the authoritative roadmap. The card shown here is a presentation snapshot using the same visual language; its source of truth remains `Swir/SWIR_OS`.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical milestone commit: [`b282e53`](https://github.com/Swir/SWIR_OS/commit/b282e53733b146e2737c4bd4d70fd1d5e97a5ed4).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts, System/Desktop/Web implementation, build tooling and authoritative progress calculations must be committed to `Swir/SWIR_OS`, not here.
