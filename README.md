<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-71.7%25-2ea043?style=for-the-badge)
![Completed](https://img.shields.io/badge/DONE-43%2F60-1f6feb?style=for-the-badge)

</div>

`Swir/swir.github.io` hosts the public SWIR OS preview and synchronized development status. It is **not** a source repository for the operating system.

## Canonical project

All SWIR OS implementation is developed in **[Swir/SWIR_OS](https://github.com/Swir/SWIR_OS)**: Web Edition, Desktop Edition, System Edition, native apps, services, package/runtime infrastructure, hardware and driver work, CI, roadmap, builds and releases.

The authoritative roadmap is [SWIR_OS/SWIR-OS-ARCHITECTURE.md](https://github.com/Swir/SWIR_OS/blob/main/SWIR-OS-ARCHITECTURE.md).

## Current verified status

| Edition | Status |
|---|---|
| Web Edition | `1.7.13` |
| Desktop Edition | `0.5.7-preview` |
| System Edition | In development |
| Overall roadmap | **43 / 60 — 71.7%** |

Latest verified System Edition milestone: the **common Package Provider layer** now has a production distribution-provider gate executed inside the selected Debian 13 System rootfs. The production path remains distribution-package based; Flatpak and AppImage adapters are still experimental and are not silently enabled.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical milestone commit: [`5ea9bef`](https://github.com/Swir/SWIR_OS/commit/5ea9befb394811594fc059b2c18cd45148a999a7).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts and System/Desktop implementation must be committed to `Swir/SWIR_OS`, not here.
