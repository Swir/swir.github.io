# SWIR System Reference Image 0.1

Status: **reference rootfs + signed base-VM E2E implemented / SWIR-built bootable image pending**

## Purpose

SWIR OS now has one explicit System Edition reference base instead of an undefined “some Linux” target. The 0.1 reference profile is **Ubuntu 24.04 LTS (`noble`), amd64**, using only pinned official Ubuntu archive/security mirrors and the `main` + `universe` components needed by the declared package set. This is a test/build reference, not yet a claim that SWIR OS ships a bootable Ubuntu-derived image.

The machine-readable source of truth is `system/image/reference-image-profile.json`, validated by `reference-image-profile.mjs` and its JSON Schema contract.

## Trust policy

The reference profile deliberately keeps the supply-chain boundary narrow:

- distribution packages come only from `https://archive.ubuntu.com/ubuntu` and `https://security.ubuntu.com/ubuntu`;
- enabled archive components are limited to Ubuntu `main` and `universe`;
- package signature verification remains mandatory;
- arbitrary mirrors and third-party repositories are disabled;
- the VM E2E image comes only from `https://cloud-images.ubuntu.com/releases/noble/release` and its downloaded `SHA256SUMS` must pass the corresponding `SHA256SUMS.gpg` verification with `/usr/share/keyrings/ubuntu-cloudimage-keyring.gpg` before the image checksum is trusted;
- the kernel path is the distribution `linux-generic` meta-package with in-tree Linux drivers preferred;
- firmware sources are limited to `linux-firmware` and `fwupd-lvfs`;
- random firmware/driver binary downloads are forbidden;
- Windows user applications remain a Wine/Proton compatibility concern; Windows kernel drivers are not treated as Linux drivers.

The current profile sets `bootableImageClaim=false` and the validator rejects attempts to flip that bit before a **SWIR-built** bootable image passes its own VM E2E.

## Disposable rootfs E2E

`system/image/reference-rootfs-e2e.sh` creates a fresh Ubuntu 24.04 minbase rootfs with `debootstrap`, installs only the profile-controlled E2E package set, mounts read-only sysfs plus procfs for evidence, provisions the root-owned SWIR catalog-trust directory, copies the existing System Image Readiness probe into the rootfs, and executes the probe **inside the chroot**.

The test requires the rootfs to expose trusted paths for APT, systemd, systemd-logind/loginctl, Polkit, NetworkManager and the persistent SWIR trust root. It also installs and verifies fwupd and Flatpak capability discovery. Service starts are blocked during image construction with `policy-rc.d`; the rootfs test is about package/image composition and binary trust, not pretending a chroot is a booted machine.

The harness never accepts a caller-provided mirror or arbitrary package string. Both come from the validated reference profile.

## Disposable signed base-VM E2E

`system/e2e/reference-vm-e2e.sh` goes one step further. On an ephemeral CI runner it downloads the current **released** Ubuntu 24.04 amd64 cloud image from the exact profile-controlled Canonical endpoint, verifies the GPG signature of `SHA256SUMS` using the installed Ubuntu cloud-image keyring, verifies the image SHA-256, then boots a disposable copy under QEMU.

Cloud-init creates an isolated test account, installs the declared native prerequisites from the distribution repositories, provisions `/var/lib/swir/security/catalog-trust`, and enables NetworkManager. The harness waits for the real boot and cloud-init completion over an ephemeral SSH channel, verifies that NetworkManager and systemd-logind are active, installs the SWIR readiness probe into the VM and requires the full core readiness result plus fwupd/Flatpak discovery. Serial output and the readiness report are retained briefly as CI diagnostics.

This VM test proves significantly more than a chroot: the selected signed base image boots a Linux kernel, starts systemd/logind and NetworkManager, reaches a usable local userspace and satisfies the native prerequisites expected by the current SWIR System services.

## What this still does not prove

Neither E2E path proves that SWIR OS itself is a finished bootable distribution. In particular, the current gates do **not** yet prove:

- a SWIR-built kernel/initramfs/bootloader/image artifact boots;
- SWIR graphical shell/login/session startup;
- native IPC peer-credential binding from the desktop shell into system services;
- real interactive Polkit authorization from a graphical SWIR session;
- package mutation/recovery through the privileged broker inside the booted VM;
- firmware update safety on physical hardware;
- Wine/Proton Windows application execution inside the booted reference target;
- Secure Boot, installer or recovery behavior.

Those remain separate production gates. The roadmap checkbox for a maintained Linux base/kernel **and bootable SWIR image** stays open until a SWIR-produced image, not merely the upstream signed reference base, boots and passes the required native scenarios.
