# SWIR Linux Driver Foundation Live E2E 0.1

## Purpose

This gate verifies the primary System Edition hardware path against the selected Debian 13 base rather than treating driver policy as documentation only.

SWIR OS keeps Linux-native hardware support first:

```text
Linux kernel in-tree driver
        |
        +--> distro kernel package (linux-image-amd64)
        |
        +--> distro firmware set (firmware-linux)
        |      +--> firmware-linux-free
        |      +--> firmware-linux-nonfree
        |
        v
signed Debian repositories only
```

The selected base enables Debian's `main` and `non-free-firmware` components through the Debian archive keyring. No arbitrary binary-driver URL is accepted by the image builder.

## What the gate proves

1. The canonical Debian 13 profile explicitly requires `linux-image-amd64` and `firmware-linux`.
2. The production rootfs builder installs both from official signed Debian repositories.
3. `firmware-linux` resolves to installed `firmware-linux-free` and `firmware-linux-nonfree` packages in the staged System Edition rootfs.
4. The staged rootfs contains a real kernel module tree and real firmware payload files.
5. A live Linux kernel exposes at least one PCI/USB device bound to a kernel driver and at least one corresponding `/sys/module/*` module identity.
6. The evidence keeps random driver downloads disabled and Windows kernel drivers disabled as a general Linux hardware path.

The live-kernel observation comes from the GitHub Linux runner while the package/rootfs observation comes from the selected Debian 13 System Edition base. This is intentional: the gate proves the architecture and provisioning path without pretending the CI runner is broad hardware qualification.

## Safety boundary

- Rootfs creation uses `mmdebstrap` with Debian's archive keyring.
- The builder has no caller-supplied repository URL and no insecure APT flags.
- Repository classes remain `distribution-repository`.
- Firmware comes from Debian's signed `non-free-firmware` component; SWIR does not scrape or download firmware from random websites.
- The E2E code is read-only after rootfs composition and does not load/unload kernel modules or flash firmware.
- `hardwareQualificationClaim=false` remains explicit.

## Evidence

A successful run emits `swir.linux-driver-foundation-e2e/0.1` containing the selected base, installed kernel/firmware package versions, firmware dependency versions, live bound-driver count, observed kernel module names and policy flags.

## Roadmap interpretation

After this gate passes on the exact revision being merged, it is sufficient evidence for the scoped roadmap item **in-tree Linux drivers + linux-firmware as primary hardware path**. It does not qualify every physical device, proprietary GPU path, fwupd update, vendor repository, recovery transaction or hotplug scenario; those remain separate gates.
