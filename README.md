<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-73.3%25-2ea043?style=for-the-badge)
![Completed](https://img.shields.io/badge/DONE-44%2F60-1f6feb?style=for-the-badge)

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
| Overall roadmap | **44 / 60 — 73.3%** |

Latest verified System Edition milestone: the **dependency-aware System package manager/updater** now resolves the APT dependency closure read-only before authorization, binds that closure into the durable transaction plan, and has a real disposable Debian 13 image E2E that performs and verifies a journaled APT installation plus update/remove planning. Interrupted-update recovery remains a separate open milestone.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical milestone commit: [`a1a0962`](https://github.com/Swir/SWIR_OS/commit/a1a0962c520ceedecf62f21f303716ee04a1ad9c).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts and System/Desktop implementation must be committed to `Swir/SWIR_OS`, not here.
