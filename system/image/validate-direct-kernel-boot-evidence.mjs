#!/usr/bin/env node
import fs from 'node:fs';

const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Usage: validate-direct-kernel-boot-evidence.mjs <evidence.json>');
const report = JSON.parse(fs.readFileSync(path, 'utf8'));
const requiredTrue = ['directKernelBoot', 'guestNetworkDisabled', 'systemdBooted', 'logindActive', 'networkManagerActive', 'peerAuthorizationSocketActive', 'readinessPassed', 'wineRuntimeRegistryPassed'];
const requiredFalse = ['bootableImageClaim', 'bootloaderE2EClaim', 'secureBootClaim', 'hardwareQualificationClaim'];
if (report?.schema !== 'swir.system-direct-kernel-boot-e2e/0.1') throw new Error('unexpected boot evidence schema');
if (report?.distribution !== 'debian-13-trixie' || report?.architecture !== 'amd64') throw new Error('unexpected boot target');
if (typeof report?.kernelRelease !== 'string' || report.kernelRelease.length < 1 || report.kernelRelease.length > 256) throw new Error('invalid kernel release');
if (report?.wineRuntimeProvider !== 'swir.compat.wine') throw new Error('managed Wine provider was not proven');
if (typeof report?.wineRuntimeVersion !== 'string' || report.wineRuntimeVersion.length < 1 || report.wineRuntimeVersion.length > 256) throw new Error('invalid managed Wine version evidence');
if (!Number.isFinite(Date.parse(report?.generatedAt))) throw new Error('invalid generatedAt timestamp');
for (const field of requiredTrue) if (report[field] !== true) throw new Error(`${field} must be true`);
for (const field of requiredFalse) if (report[field] !== false) throw new Error(`${field} must remain false`);
console.log('Direct-kernel boot evidence: OK');
