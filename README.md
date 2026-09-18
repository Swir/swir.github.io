<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-84.6%25-2ea043?style=for-the-badge)
![Completed](https://img.shields.io/badge/DONE-55%2F65-1f6feb?style=for-the-badge)

<img width="100%" src="assets/readme/swir-os-progress-card.svg" alt="SWIR OS roadmap progress — 84.6%, 55 of 65 verified deliverables" />

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
| Overall roadmap | **55 / 65 — 84.6%** |
| Release readiness | **Not ready** |

The latest canonical milestone closes the installable **SWIR Shell Theme/Skin framework** after its implementation and post-merge validation completed successfully. Bounded data-only `.swirtheme` packages use an exact visual-token allowlist, accessibility contrast validation, owner-only atomic storage, Settings import/select/reset controls and fail-safe recovery to immutable `builtin.swir-dark`. Theme packages cannot inject CSS selectors, scripts, commands, URLs or privileged code. This verified implementation advances the authoritative roadmap to **55 / 65 — 84.6%**; the visual presentation itself does not add progress.

The native daily-use application suite remains incomplete, so release readiness is still **not ready**. Existing verified native foundations include SWIR Browser, SWIR Player, Photo Studio, PDF Viewer, Calculator and other System Edition applications documented in the canonical repository.

The existing boot/install path remains verified in disposable UEFI VMs: the final image boots as QEMU USB mass storage, the native GTK4 installer requires exact target review and destructive confirmation, installs to a separate blank disk, and the installed system boots graphically with persistence after the source USB is removed. This is meaningful VM evidence, **not** a claim of broad physical-PC support. Physical Live USB boot/install qualification is still open, and Secure Boot plus legacy BIOS remain unclaimed until separately tested.

The canonical repo uses deterministic **SWIR Progress SVG PRO** assets generated from the authoritative roadmap. The card shown here is a presentation snapshot using the same visual language; its source of truth remains `Swir/SWIR_OS`. The canonical roadmap/README presentation is SVG-only for progress meters; text values remain as accessible data, not duplicate character-based bars.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical snapshot commit: [`031b6ef`](https://github.com/Swir/SWIR_OS/commit/031b6ef4d375813ea05a066fd321ccb1d86e93a9).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts, System/Desktop/Web implementation, build tooling and authoritative progress calculations must be committed to `Swir/SWIR_OS`, not here.
