# SWIR Debian Base Image 0.1

Status: **candidate rootfs foundation / bootable image pending**

## Selected base

SWIR System Edition now has an explicit base-image candidate instead of an unspecified Linux distribution: **Debian 13 `trixie` stable**. The profile lives in `system/image/debian13-base-image-profile.json` and is validated against `swir.system-base-image-profile/0.1`.

The profile tracks the Debian 13 major/stable line rather than embedding a point-release ISO. Point releases are maintenance snapshots of the same stable release, so the image pipeline can consume current signed Debian 13 packages while the SWIR profile remains pinned to `trixie`.

Supported target architectures in the profile are `amd64` and `arm64`. The current CI rootfs builder intentionally refuses cross-architecture emulation; the first executable lane is native `amd64`. An arm64 lane needs an explicit qemu-user/binfmt pipeline rather than silently pretending it was tested.

## Repository trust

The base profile permits only the official Debian repositories below:

```text
https://deb.debian.org/debian
https://security.debian.org/debian-security
```

Both are configured with `/usr/share/keyrings/debian-archive-keyring.gpg`. Unsigned repositories, arbitrary third-party repositories and random binary driver sources are disabled. `main` and Debian's `non-free-firmware` component are the only enabled components; firmware still comes through the distribution package path rather than random download sites.

## Rootfs E2E lane

`debian13-rootfs-build.sh` uses `debootstrap` to create a fresh Debian 13 root filesystem, then installs the first System Edition foundation set from signed Debian repositories:

```text
linux-image-amd64
systemd-sysv
dbus
polkitd
pkexec
network-manager
fwupd
flatpak
wine
wine64
firmware-linux-free
ca-certificates
nodejs
```

Debian 13 splits the former PolicyKit binary package surface: `polkitd` supplies the policy service/supporting tools and `pkexec` is packaged separately. SWIR pins both rather than depending on the obsolete `policykit-1` binary package name.

The builder provisions the three SWIR Polkit policy domains with root ownership, private package/firmware/catalog state directories and the existing System Image Readiness probe. `/proc`, `/sys` and `/dev` are mounted only for the disposable rootfs validation pass and are cleaned up on exit. Service auto-start is blocked during package installation.

The verifier requires every mandatory readiness gate to pass inside the chroot, requires fwupd/Flatpak/Wine optional provider gates, verifies Debian 13 identity, checks installed packages and kernel payload, checks PolicyKit file ownership/modes and rejects unapproved apt source lines. It also runs an `apt-get -s upgrade` dependency simulation without mutating package state.

## What this does not claim

This is deliberately **not** marked as a bootable SWIR OS image. The rootfs has a real Debian kernel package and userspace foundation, but it is not yet partitioned into a disk image, configured with a bootloader, booted under QEMU, or verified through SWIR login/shell startup. Accordingly:

```text
bootableImageClaim = false
rootfsE2EClaim = true
```

The roadmap item **maintained Linux base/kernel and bootable image** stays open until a generated disk image boots in a disposable VM and passes post-boot health/recovery checks.

## Next image milestone

The next safe step is a reproducible disk-image builder on top of this rootfs: GPT/EFI layout, signed/controlled bootloader configuration, initramfs, first-boot provisioning, QEMU boot, logind/NetworkManager/Polkit health checks, SWIR session startup and failure/recovery vectors. Only that VM boot evidence can move the bootable-image roadmap checkbox.
