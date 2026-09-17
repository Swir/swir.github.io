# SWIR Debian 13 Direct-Kernel Boot E2E 0.1

Status: **implemented disposable VM gate / bootloader and distributable image pending**

This lane boots the selected `system-base-debian-trixie.json` foundation in QEMU after applying the same production SWIR image and peer-authorization provisioning used by the rootfs CI.

## What the gate proves

The job builds a fresh Debian 13 `trixie` rootfs only from Debian's signed repositories and pinned archive keyring. The E2E package set is derived from the selected base profile, so Flatpak and the standard Debian Wine suite cannot drift away from the declared System foundation. It then applies SWIR production provisioning, copies the rootfs into an ext4 disk and boots it under QEMU with the Debian kernel/initramfs.

Inside the guest the gate requires:

- a real systemd boot to `multi-user.target`;
- active D-Bus and `systemd-logind`;
- active NetworkManager;
- the hardened `swir-peer-authorization.socket` created by the image provisioner;
- a green System Image Readiness report including the `systemd-session-manager` gate;
- distro-provided `fwupdmgr`, Flatpak and Wine binaries;
- the real `WindowsCompatibilityRuntimeRegistry` to discover, trust-check and execute the Wine `--version` health probe with root ownership and writable-bit policy enforced.

The managed Wine inventory emitted by the guest is retained as CI evidence. This proves that the same runtime registry used by SWIR's Windows compatibility layer can consume the distro-provided Wine runtime on the selected System base; it still does not claim that an arbitrary Windows application has been successfully executed.

The guest has no network interface. Network access exists only on the GitHub Actions build host while Debian packages are fetched through native APT signature verification.

## Security boundary

The E2E harness refuses unsafe work roots and `/` as a staging target, reuses the selected Debian profile and repository trust policy, embeds no peer-authorization HMAC key in the image, and uploads only short-lived diagnostics/evidence.

The generated evidence contract keeps these claims **false**:

- `bootableImageClaim` — QEMU receives kernel/initramfs directly;
- `bootloaderE2EClaim` — no UEFI/GPT/GRUB/systemd-boot path is tested;
- `secureBootClaim` — no Secure Boot signing/enrollment chain is tested;
- `hardwareQualificationClaim` — TCG/QEMU is not physical hardware coverage.

Therefore this lane is a major System Edition integration gate but is not sufficient to mark `maintained Linux base/kernel and bootable image` or `managed Wine/Proton compatibility service` complete on the roadmap.

## Next production gate

Build a reproducible GPT/UEFI disk image, install a controlled bootloader, boot that exact image in QEMU/OVMF, add recovery/rollback partitions or snapshots, and extend the hybrid E2E from runtime discovery to a known signed Windows test application inside an isolated SWIR prefix. After that, move to representative physical-hardware qualification.
