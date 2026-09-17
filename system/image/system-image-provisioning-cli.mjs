#!/usr/bin/env node
import path from 'node:path';
import { stageSystemImageFoundation, verifySystemImageFoundation } from './system-image-provisioning.mjs';

function valueOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const command = process.argv[2];
const rootfsValue = valueOf('--rootfs');
const production = process.argv.includes('--production');
const compact = process.argv.includes('--compact');

if (!['stage', 'verify'].includes(command) || !rootfsValue) {
  console.error('Usage: system-image-provisioning-cli.mjs <stage|verify> --rootfs <absolute-path> [--source-root <repo>] [--repository-policy <file>] [--production] [--compact]');
  process.exit(64);
}

try {
  const rootfs = path.resolve(rootfsValue);
  let report;
  if (command === 'stage') {
    const sourceRootValue = valueOf('--source-root');
    const repositoryPolicy = valueOf('--repository-policy');
    if (!sourceRootValue || !repositoryPolicy) throw Object.assign(new Error('stage requires --source-root and --repository-policy'), { code: 'CLI_ARGUMENT_REQUIRED' });
    report = await stageSystemImageFoundation({
      rootfs,
      sourceRoot: path.resolve(sourceRootValue),
      deploymentInputs: { repositoryTrustPolicy: path.resolve(repositoryPolicy) },
      production
    });
  } else {
    report = await verifySystemImageFoundation({ rootfs, production });
  }
  process.stdout.write(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
  if (report.ready !== true) process.exitCode = 2;
} catch (error) {
  process.stderr.write(`${error?.code || 'SYSTEM_IMAGE_PROVISIONING_FAILED'}: ${error?.message || error}\n`);
  process.exitCode = 1;
}
