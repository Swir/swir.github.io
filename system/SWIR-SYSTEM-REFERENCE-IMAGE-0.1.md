# SWIR System Reference Image 0.1

Status: **reference rootfs + CI E2E implemented / bootable image pending**

## Purpose

SWIR OS now has one explicit System Edition reference base instead of an undefined “some Linux” target. The 0.1 reference profile is **Ubuntu 24.04 LTS (`noble`), amd64**, using only pinned official Ubuntu archive/security mirrors and the `main` + `universe` components needed by the declared package set. This is a test/build reference, not yet a claim that SWIR OS ships a bootable Ubuntu-derived image.

The machine-readable source of truth is `system/image/reference-image-profile.json`, validated by `reference-image-profile.mjs` and its JSON Schema contract.

## Trust policy

The reference profile deliberately keeps the supply-chain boundary narrow:

- distribution packages come only from `https://archive.ubuntu.com/ubuntu` and `https://security.ubuntu.com/ubuntu`;
- enabled archive components are limited to Ubuntu `main` and `universe`;
- package signature verification remains mandatory;
- arbitrary mirrors and third-party repositories are disabled;
- the kernel path is the distribution `linux-generic` meta-package with in-tree Linux drivers preferred;
- firmware sources are limited to `linux-firmware` and `fwupd-lvfs`;
- random firmware/driver binary downloads are forbidden;
- Windows user applications remain a Wine/Proton compatibility concern; Windows kernel drivers are not treated as Linux drivers.

The current profile sets `bootableImageClaim=false` and the validator rejects attempts to flip that bit before boot E2E exists.

## Disposable rootfs E2E

`system/image/reference-rootfs-e2e.sh` creates a fresh Ubuntu 24.04 minbase rootfs with `debootstrap`, installs only the profile-controlled E2E package set, mounts read-only sysfs plus procfs for evidence, provisions the root-owned SWIR catalog-trust directory, copies the existing System Image Readiness probe into the rootfs, and executes the probe **inside the chroot**.

The test requires the rootfs to expose trusted paths for APT, systemd, Polkit, NetworkManager and loginctl. It also installs and verifies fwupd and Flatpak capability discovery. Service starts are blocked during image construction with `policy-rc.d`; the E2E is about package/image composition and binary trust, not pretending a chroot is a booted machine.

The harness never accepts a caller-provided mirror or arbitrary package string. Both come from the validated reference profile.

## What this proves

A green run proves that the selected reference distribution can be composed with the prerequisite packages expected by SWIR's current System Edition contracts and that the existing read-only readiness probe accepts the resulting rootfs.

It does **not** prove:

- kernel or bootloader boot success;
- graphical login/session startup;
- NetworkManager daemon connectivity;
- real Polkit interactive authorization;
- package mutation/recovery through the privileged broker;
- firmware update safety on physical hardware;
- Wine/Proton Windows application execution;
- Secure Boot or installer/recovery behavior.

Those remain separate production gates and the roadmap checkbox for a maintained bootable Linux image must stay open until a disposable VM actually boots and passes those native scenarios.
