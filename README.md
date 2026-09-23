<!-- SWIR-README-STANDARD:v2 -->
<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-89.2%25-02050A?style=for-the-badge&logoColor=62E5FF)
![Completed](https://img.shields.io/badge/DONE-58%2F65-02050A?style=for-the-badge&logoColor=62E5FF)

<img width="100%" src="assets/readme/swir-os-progress-card.svg" alt="SWIR OS roadmap progress — 89.2%, 58 of 65 verified deliverables" />

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
| Overall roadmap | **58 / 65 — 89.2%** |
| Release readiness | **Not ready** |

The latest canonical milestone is merged **PR #86**, which closes the roadmap item **essential native Linux application suite for dependable daily use**. Browser, Player, Photo Studio, Task Manager/Diagnostics and Default Apps now carry verified English, Polish and Norwegian Bokmål runtime surfaces, deterministic English fallback and accessibility evidence alongside the already verified native daily-use applications. Existing privilege, package, local-file and process-safety boundaries remain in force.

The native daily-use suite milestone is complete in the authoritative roadmap, but this does **not** mean the full System Edition is release-ready. Physical Live USB boot/install qualification and supported-device fwupd/LVFS validation remain separate open hardware gates; Desktop package signing/integrity and the signed GitHub stable/preview update feed also remain open roadmap work.

The existing boot/install path remains verified in disposable UEFI VMs: the final image boots as QEMU USB mass storage, the native GTK4 installer requires exact target review and destructive confirmation, installs to a separate blank disk, and the installed system boots graphically with persistence after the source USB is removed. This is meaningful VM evidence, **not** a claim of broad physical-PC support. Secure Boot plus legacy BIOS remain unclaimed until separately tested.

The canonical repo uses deterministic **SWIR Progress SVG PRO** assets generated from the authoritative roadmap. The card shown here is a presentation snapshot using the same visual language; its source of truth remains `Swir/SWIR_OS`. The canonical roadmap/README presentation is SVG-only for progress meters; text values remain as accessible data, not duplicate character-based bars.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical snapshot commit: [`ad1c6f0a`](https://github.com/Swir/SWIR_OS/commit/ad1c6f0ab3f026350501bb86dc88c7d88b6101e2).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts, System/Desktop/Web implementation, build tooling and authoritative progress calculations must be committed to `Swir/SWIR_OS`, not here.

## 🔎 Search Keywords

`SWIR OS` • `Linux desktop OS` • `hybrid desktop OS` • `bootable Linux system` • `Live USB Linux` • `Linux graphical installer` • `GTK4 desktop` • `Wine Proton compatibility` • `Linux package management` • `hardware driver center` • `fwupd LVFS` • `native Linux applications`

<div align="center">

### `BUILD • TEST • RELEASE • EVOLVE`

[**← SWIR profile**](https://github.com/Swir) · [**Canonical SWIR OS repository →**](https://github.com/Swir/SWIR_OS)

</div>
