<div align="center">

# 🖥️ SWIR OS — Public Status & Preview

**Presentation repository only**

[![Canonical Repository](https://img.shields.io/badge/CANONICAL-Swir%2FSWIR__OS-1f6feb?style=for-the-badge&logo=github)](https://github.com/Swir/SWIR_OS)
![Roadmap](https://img.shields.io/badge/ROADMAP-76.7%25-2ea043?style=for-the-badge)
![Completed](https://img.shields.io/badge/DONE-46%2F60-1f6feb?style=for-the-badge)

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
| Overall roadmap | **46 / 60 — 76.7%** |

Latest verified System Edition milestones now cover two connected recovery/safety layers. A dedicated **UEFI recovery entry** boots a hardened SWIR recovery target with the System root mounted read-only, normal fstab automounting disabled, no guest network interface and no automatic filesystem/package/firmware mutation. In addition, the **Driver Center mutation coordinator** now writes a private parent journal before delegating an exact selected `review-package` or trusted `review-fwupd` preview operation to the existing guarded package/firmware transaction service. It records child transaction identity and fail-closed recovery state instead of silently retrying or inventing rollback.

Direct kernel-module mutation remains disabled, Windows kernel drivers are not treated as Linux drivers, and arbitrary driver downloads remain forbidden. Real supported-device `fwupd`/LVFS mutation qualification and exceptional official-vendor repository policy are still open roadmap gates, so this status does not claim broad physical-hardware qualification.

Public progress here is updated only after the corresponding implementation is merged and verified in `Swir/SWIR_OS`. Current canonical milestone commit: [`b5569bd`](https://github.com/Swir/SWIR_OS/commit/b5569bd629f87b9499a9a64e07576306ce727ce8).

## Repository role

This repository may contain website assets and older independent web/retro experiments. New SWIR OS product code, architecture contracts and System/Desktop implementation must be committed to `Swir/SWIR_OS`, not here.
