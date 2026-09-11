#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectHardwareSnapshot, loadCatalog, assertReadOnlyContract } from './hardware-service.mjs';
import { assertSafeDriverPlan, resolveDriverPlan } from './driver-resolver.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = path.join(here, 'hardware-catalog.json');
const compact = process.argv.includes('--compact');

try {
  const catalog = loadCatalog(catalogPath);
  const snapshot = collectHardwareSnapshot({ catalog });
  assertReadOnlyContract(snapshot);
  const plan = resolveDriverPlan(snapshot, catalog);
  assertSafeDriverPlan(plan);
  process.stdout.write(`${JSON.stringify(plan, null, compact ? 0 : 2)}\n`);
} catch (error) {
  process.stderr.write(`SWIR Driver Plan failed: ${error.message}\n`);
  process.exitCode = 1;
}
