# SWIR System Image Provisioning 0.1

Status: **implemented build foundation / bootable image and installer pending**

This layer turns several already-implemented System Edition security boundaries into an explicit Linux rootfs layout. It does not select a final base distribution and it does not claim that SWIR OS is bootable.

## What is provisioned

`system/image/system-image-provisioning.json` defines the first controlled rootfs layout for:

```text
/etc/swir/repository-trust-policy.json
/usr/share/polkit-1/actions/org.swir.system.packages.policy
/usr/share/polkit-1/actions/org.swir.system.network.policy
/usr/share/polkit-1/actions/org.swir.system.firmware.policy
/var/lib/swir/security/catalog-trust
/var/lib/swir/package-transactions
/var/lib/swir/transactions/firmware
/var/lib/swir/compat/prefixes
/var/lib/swir/image/provisioning-state.json
```

The package/network/firmware PolicyKit definitions come only from repository-controlled source files. The distribution repository trust policy is intentionally a **deployment input**: the checked-in `example.invalid` template is rejected by the provisioner and cannot accidentally become production trust configuration.

## Safety boundary

`stageSystemImageFoundation()` requires an explicit rootfs directory and refuses `/`. The rootfs itself and every managed destination must be non-symlink paths. Destination paths are fixed by the manifest and cannot escape the rootfs.

Production mode additionally requires Unix UID 0 and applies root ownership. Build/test mode uses the current UID so the exact layout, modes, hashes and tamper detection can be exercised in CI without pretending that CI artifacts are a production image.

There is no shell command surface and no URL/download surface in this layer.

## Provenance and verification

After staging, the provisioner writes `swir.system-image-provisioning-state/0.1` with the manifest SHA-256 and SHA-256/size binding for every provisioned file. `verifySystemImageFoundation()` then checks:

- directory type, exact mode and expected owner;
- file type, exact mode and expected owner;
- no symlink destinations;
- required PolicyKit action IDs and no unauthenticated `allow_* = yes` policy;
- strict repository trust policy semantics (`native-required`, no insecure mode, no `example.invalid`);
- exact file digest/size binding to provisioning state;
- exact manifest digest and production-mode/owner binding.

Any post-provision tampering makes the report fail closed.

## Why this matters for System Edition

The privileged services already have separate package, NetworkManager and firmware authorization domains. This layer defines where those policies and their persistent state must live in a future image, giving the installer/image builder a reproducible contract rather than scattered documentation.

It also creates a concrete boundary between repository-controlled operating-system files and release/deployment inputs such as the selected distribution repository policy.

## Remaining production gates

1. Select and pin a maintained base distribution after installer/update/Secure Boot/hardware test evidence.
2. Add an actual image builder that installs the selected distro kernel, systemd, Polkit, NetworkManager, fwupd and required SWIR runtime packages before applying this layout.
3. Run the provisioner in a disposable root-owned VM/disk image and verify ownership/modes against the mounted filesystem.
4. Boot that image, verify polkitd loads all three policy domains, and run package/network mutation E2E.
5. Add installer, bootloader/Secure Boot strategy, login/session integration and recovery environment.
