# SWIR Debian 13 VM E2E 0.1

Status: **booted disposable System foundation implemented / final bootable SWIR image pending**

## Purpose

This lane turns the System Edition base from an abstract Linux target into an executable integration boundary. The selected candidate is Debian 13 `trixie` stable. Construction uses Debian's archive keyring and only the two profile-approved HTTPS repositories: `deb.debian.org/debian` and `security.debian.org/debian-security`.

The machine-readable source of truth is `system/image/debian13-base-image-profile.json`. It keeps random driver downloads, unsigned repositories, third-party repositories and Windows kernel drivers-as-Linux-drivers disabled. Native Linux drivers remain the preferred kernel path; firmware comes from Debian packages and fwupd/LVFS integration.

## What the VM job really does

`system/e2e/debian13-direct-kernel-vm-e2e.sh` creates a fresh amd64 Debian 13 rootfs with `debootstrap`, installs the distribution kernel plus systemd, D-Bus, Polkit, NetworkManager, fwupd, Flatpak and Wine, and applies the existing SWIR System Image Provisioning and Peer Authorization Provisioning contracts in production mode.

The composed rootfs therefore contains the real SWIR Polkit policies, persistent trust/journal directories, peer authorization socket/service, and the current System Image Readiness probe. Before boot, the harness creates a plain ext4 disk image and copies the rootfs into it.

The privileged staging directory intentionally remains `root:root 0700`. That mode must **not** become the runtime filesystem root: non-root system daemons require traversal of `/`. The disk composition boundary therefore normalizes the deployed `/` to `root:root 0755` and verifies that invariant both before and after boot. This regression was found by the first real VM boot attempt when D-Bus correctly failed with systemd `200/CHDIR` against a copied `0700` root.

The disposable test VM also initializes a unique machine ID for that one VM instance so D-Bus/logind exercise their real boot path. This is not a golden-image policy: a future reusable release image must reset machine identity before distribution and generate a unique identity on first boot.

QEMU then boots the **Debian distribution kernel and initramfs directly** with the ext4 image as `/dev/vda`. The guest is deliberately started without a network device. A one-shot systemd gate requires:

- runtime `/` to be `root:root 0755`;
- the System Image Readiness report to pass every required core gate;
- D-Bus, `systemd-logind`, NetworkManager and the SWIR peer-authorization socket to be active;
- `loginctl` and `nmcli` to work against the booted services;
- fwupd, Flatpak and Wine binaries to exist from the approved distribution packages.

The guest writes a machine-readable readiness report, emits a unique serial PASS sentinel, syncs and powers itself off. CI remounts the image read-only and verifies both the report and guest status. On failure, compact systemd/journal diagnostics are written to the serial log. Serial output, readiness evidence and provisioning reports are retained briefly as diagnostics.

## Supply-chain and privilege boundary

The build does not download a cloud image or arbitrary binary payload. `debootstrap` and APT verify Debian repository metadata/packages using `/usr/share/keyrings/debian-archive-keyring.gpg`. The guest has no network interface during execution, so the boot test cannot silently obtain additional software.

System provisioning refuses the live `/` target, validates managed paths against symlink escape, installs root-owned policy/state artifacts and records integrity metadata. The peer authorization runtime key is still generated at runtime rather than embedded into the image.

## Why the roadmap remains conservative

This is materially stronger than a chroot or syntax-only contract because a Linux kernel actually boots the composed filesystem and starts real systemd/logind/NetworkManager services. It still does **not** satisfy the final `maintained Linux base/kernel and bootable image` deliverable by itself.

The VM currently bypasses a bootloader with QEMU `-kernel`/`-initrd`. It also does not yet prove a SWIR graphical login/session, compositor/shell startup, installer/recovery media, UEFI/Secure Boot, physical GPU/Wi-Fi/audio hardware, or real firmware mutation. The profile therefore enforces:

```text
bootableImageClaim = false
directKernelVmE2EClaim = true
bootloaderE2EClaim = false
```

## Next image milestone

Build a reproducible GPT/UEFI disk image from the same verified rootfs, install a controlled bootloader, boot it through firmware rather than QEMU direct-kernel injection, then start the SWIR desktop/session and run package/network/compatibility recovery scenarios inside that booted guest. Only evidence from that path should advance the final bootable-image roadmap checkbox.
