#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertReadOnlyContract, collectHardwareSnapshot, loadCatalog } from './hardware-service.mjs';
import { assertSafeDriverPlan, resolveDriverPlan } from './driver-resolver.mjs';
import { assertSafeDriverCenterReport, createDriverCenterReport } from './driver-center-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let catalogPath = path.join(here, 'hardware-catalog.json');
let trustedSourcesPath = path.join(here, '..', 'contracts', 'trusted-sources.json');
let snapshotPath = null;
let pretty = true;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--catalog') {
    if (!args[i + 1]) throw new Error('--catalog requires a path');
    catalogPath = path.resolve(args[++i]);
  } else if (arg === '--trusted-sources') {
    if (!args[i + 1]) throw new Error('--trusted-sources requires a path');
    trustedSourcesPath = path.resolve(args[++i]);
  } else if (arg === '--snapshot') {
    if (!args[i + 1]) throw new Error('--snapshot requires a path');
    snapshotPath = path.resolve(args[++i]);
  } else if (arg === '--compact') {
    pretty = false;
  } else if (arg === '--help') {
    console.log('Usage: node system/hardware/driver-center-report.mjs [--catalog PATH] [--trusted-sources PATH] [--snapshot PATH] [--compact]');
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

const catalog = loadCatalog(catalogPath);
const trustedSources = JSON.parse(fs.readFileSync(trustedSourcesPath, 'utf8'));
if (trustedSources?.schema !== 'swir.trusted-sources/0.1') throw new Error('Unsupported trusted source policy');
const snapshot = snapshotPath
  ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  : collectHardwareSnapshot({ catalog });
assertReadOnlyContract(snapshot);
const plan = resolveDriverPlan(snapshot, catalog);
assertSafeDriverPlan(plan);
const report = createDriverCenterReport(snapshot, plan, trustedSources);
assertSafeDriverCenterReport(report);
process.stdout.write(`${JSON.stringify(report, null, pretty ? 2 : 0)}\n`);
