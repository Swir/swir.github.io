# SWIR Firmware Transaction Broker 0.1

## Scope

This component adds the first mutation boundary on top of the existing read-only `fwupd` / LVFS discovery service. It does **not** make arbitrary firmware files installable and it does not claim generic firmware rollback.

The broker accepts only a candidate that was normalized by the SWIR fwupd/LVFS discovery boundary and still satisfies all of these properties:

```text
remoteId = lvfs
source.class = fwupd-lvfs
source.repositoryId = lvfs
trustedSource = true
directDownloadUrlExposed = false
mutationAuthorized = false
```

Discovery remains read-only; authorization is obtained separately for every mutation.

## Update plan

A candidate is converted into `swir.firmware-update-plan/0.1` and bound to:

- device id;
- release id where available;
- current version;
- target version;
- normalized checksum set;
- LVFS source identity;
- reboot requirement;
- one guarded command template.

The canonical plan is covered by a SHA-256 plan digest before Polkit authorization or execution.

The only 0.1 mutation template is:

```text
/usr/bin/fwupdmgr --assume-yes --no-reboot-check update <device-id>
```

This deliberately updates one selected fwupd device rather than exposing a generic `fwupdmgr update` for every device. `--no-reboot-check` prevents the CLI from deciding SWIR's reboot policy; SWIR records the reboot requirement in its transaction state instead. The executor never enables `--force`, downgrade/reinstall flags, local firmware paths, arbitrary URLs or raw caller arguments.

## Polkit binding

`PolkitFirmwareAuthorizationBroker` maps operations to dedicated action ids:

```text
org.swir.system.firmware.update
org.swir.system.firmware.recover
```

Authorization is bound to the current process PID/start-time/UID, exact device id, exact release id where known, exact operation and exact plan digest. `pkcheck` is required to be a trusted root-owned non-symlink binary and is executed without a shell or inherited environment. `system/security/org.swir.system.firmware.policy` declares only the SWIR update/recovery actions and requires administrator authentication; no firmware action is granted implicitly.

## Journal and recovery

Before `fwupdmgr` is invoked, the service persists `swir.firmware-transaction-journal/0.1` under:

```text
/var/lib/swir/transactions/firmware
```

Production policy requires a private directory and private regular journal files. State transitions are persisted before and after the privileged operation:

```text
planned
  -> authorized
  -> executing
  -> committed
     | staged-reboot-required
     |   -> committed-after-reboot
     |   -> failed-needs-recovery
     | failed-needs-recovery
```

A successful process exit is not enough. SWIR re-reads fwupd inventory. If the device reports the target version, the transaction is committed. If the candidate explicitly requires a reboot and the old version is still reported, the transaction becomes `staged-reboot-required`. Any other version mismatch fails closed and requires operator/recovery review.

For a staged transaction SWIR records the Linux boot identity from `/proc/sys/kernel/random/boot_id`. `reconcileAfterBoot(...)` refuses to finalize until that boot identity has actually changed. After a real reboot it re-reads fwupd inventory: the target version becomes `committed-after-reboot`; any other observed version becomes `failed-needs-recovery`. This prevents a caller from pretending that a reboot occurred just by re-running the reconciler in the same boot session.

Firmware is different from a normal package transaction: many devices cannot be generically rolled back after a failed flash. Therefore 0.1 deliberately records:

```text
automaticRollback = false
safeToAutoRetry = false
```

The journal can be inspected after restart, and reboot-staged transactions have a boot-identity-bound post-boot reconciler, but no unsupported automatic downgrade claim is made.

## Source policy

0.1 does not download firmware from arbitrary websites. It delegates firmware acquisition and verification to the maintained distribution `fwupd` daemon and accepts only candidates classified from the `lvfs` remote by the read-only discovery service.

## Completion gate

The roadmap item **fwupd/LVFS firmware updates where supported** remains incomplete. The transaction boundary, Polkit binding, reboot-aware journal and boot-identity-bound post-boot result reconciliation now exist, but completion still requires real supported-hardware/System-image E2E and recovery behavior tested across representative firmware classes. A contract-tested broker is not evidence that a particular physical device can safely flash or roll back firmware.
