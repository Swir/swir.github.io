<!-- SWIR-README-STANDARD:v2 -->
<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-93.8%25-02050A?style=for-the-badge&logoColor=62E5FF)
![Completed](https://img.shields.io/badge/DONE-61%2F65-02050A?style=for-the-badge&logoColor=62E5FF)

<img width="100%" src="assets/readme/swir-os-progress-card.svg" alt="SWIR OS roadmap progress — 93.8%, 61 of 65 verified deliverables" />

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
| Overall roadmap | **61 / 65 — 93.8%** |
| Release readiness | **Not ready** |

The latest canonical milestone is merged **PR #95**. It adds a fail-closed physical Live USB review gate that binds the operator review to the exact Live and installed evidence pair, image SHA-256/source commit, privacy-minimized hardware scope, installer safety observations and post-install usability evidence. This improves the real-hardware qualification path without treating a CI harness, VM run or review schema as proof that physical Live USB qualification is complete.

The remaining authoritative roadmap gates are still separate and open: **Desktop production package signatures/integrity evidence**, **a signed GitHub-backed stable/preview update feed**, **supported-device fwupd/LVFS real-device qualification**, and **production physical Live USB boot/install qualification**. SWIR_OS currently has no published GitHub Release and no production `workflow_dispatch` evidence run, so Desktop release/signing readiness is not being overstated.

The existing boot/install path remains verified in disposable UEFI VMs: the final image boots as QEMU USB mass storage, the native GTK4 installer requires exact target review and destructive confirmation, installs to a separate blank disk, and the installed system boots graphically with persistence after the source USB is removed. This is meaningful VM evidence, **not** a claim of broad physical-PC support. Secure Boot plus legacy BIOS remain unclaimed until separately tested.

The canonical repo uses deterministic **SWIR Progress SVG PRO** assets generated from the authoritative roadmap. The card shown here is a presentation snapshot using the same visual language; its source of truth remains `Swir/SWIR_OS`. The canonical roadmap/README presentation is SVG-only for progress meters; text values remain as accessible data, not duplicate character-based bars.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical snapshot commit: [`bf13e8a8`](https://github.com/Swir/SWIR_OS/commit/bf13e8a89ae2b6fe2487a39cb1298ba14483b550).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts, System/Desktop/Web implementation, build tooling and authoritative progress calculations must be committed to `Swir/SWIR_OS`, not here.

## 🔎 Search Keywords

`SWIR OS` • `Linux desktop OS` • `hybrid desktop OS` • `bootable Linux system` • `Live USB Linux` • `Linux graphical installer` • `GTK4 desktop` • `Wine Proton compatibility` • `Linux package management` • `hardware driver center` • `fwupd LVFS` • `native Linux applications`

<div align="center">

### `BUILD • TEST • RELEASE • EVOLVE`

[**← SWIR profile**](https://github.com/Swir) · [**Canonical SWIR OS repository →**](https://github.com/Swir/SWIR_OS)

</div>
