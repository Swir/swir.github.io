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

Latest verified System Edition milestone: the **dependency-aware APT package transaction path now has fail-closed interrupted-transaction reconciliation**. A real disposable Debian 13 image E2E performs a package mutation, deliberately loses the acknowledgement after APT succeeds, verifies the durable `failed-needs-recovery` state, then reconciles it only after a fresh recovery authorization, exact live package-state verification, `dpkg --audit`, `apt-get check`, and native package health. Recovery does **not** perform an automatic inverse package mutation.

The wider roadmap item for journaled **driver + firmware + package** transactions remains open until the driver/firmware mutation and recovery paths are implemented and verified too, so the public roadmap stays truthfully at **44 / 60 — 73.3%**.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical milestone commit: [`2fa61bd`](https://github.com/Swir/SWIR_OS/commit/2fa61bd3035841c30882ba05d3d30a5b7a7119c1).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts and System/Desktop implementation must be committed to `Swir/SWIR_OS`, not here.
