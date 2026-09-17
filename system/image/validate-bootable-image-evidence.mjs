#!/usr/bin/env node
import fs from 'node:fs';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Usage: validate-bootable-image-evidence.mjs <evidence.json>');
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const requiredTrue = ['uefiBootClaim', 'bootableImageClaim', 'bootloaderE2EClaim', 'guestNetworkDisabled', 'systemdBooted', 'logindActive', 'networkManagerActive', 'peerAuthorizationSocketActive', 'readinessPassed', 'wineRuntimeRegistryPassed', 'nativeLinuxExecutionPassed'];
const requiredFalse = ['directKernelBoot', 'secureBootClaim', 'hardwareQualificationClaim', 'installerClaim', 'recoveryModeClaim'];
const sha256 = /^[0-9a-f]{64}$/;
if (report?.schema !== 'swir.system-bootable-image-e2e/0.1') throw new Error('unexpected boot evidence schema');
if (report?.distribution !== 'debian-13-trixie' || report?.architecture !== 'amd64') throw new Error('unexpected boot target');
if (report?.bootPath !== 'uefi-systemd-boot' || report?.partitionTable !== 'gpt') throw new Error('unexpected boot path');
if (report?.rootFilesystem !== 'ext4' || report?.rootFilesystemLabel !== 'SWIR_ROOT') throw new Error('unexpected root filesystem');
if (report?.espFilesystem !== 'fat32' || report?.espFilesystemLabel !== 'SWIR_ESP') throw new Error('unexpected EFI system partition');
if (report?.bootloaderPackage !== 'systemd-boot-efi') throw new Error('unexpected bootloader package');
if (report?.wineRuntimeProvider !== 'swir.compat.wine') throw new Error('managed Wine provider was not proven');
if (report?.nativeLinuxExecutionProvider !== 'swir.package.system') throw new Error('native Linux package provider was not proven');
if (typeof report?.nativeLinuxExecutable !== 'string' || !report.nativeLinuxExecutable.startsWith('/usr/bin/')) throw new Error('native Linux executable evidence is invalid');
if (typeof report?.kernelRelease !== 'string' || report.kernelRelease.length < 1 || report.kernelRelease.length > 256) throw new Error('invalid kernel release');
if (typeof report?.wineRuntimeVersion !== 'string' || report.wineRuntimeVersion.length < 1 || report.wineRuntimeVersion.length > 256) throw new Error('invalid managed Wine version evidence');
for (const field of ['bootloaderSha256', 'imageSha256', 'ovmfSha256']) if (!sha256.test(report?.[field] || '')) throw new Error(`${field} must be SHA-256`);
if (!Number.isFinite(Date.parse(report?.generatedAt))) throw new Error('invalid generatedAt timestamp');
for (const field of requiredTrue) if (report[field] !== true) throw new Error(`${field} must be true`);
for (const field of requiredFalse) if (report[field] !== false) throw new Error(`${field} must remain false`);
console.log('Bootable-image UEFI evidence: OK');
