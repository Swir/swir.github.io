#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertReadOnlyContract, collectHardwareSnapshot, loadCatalog } from './hardware-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let catalogPath = path.join(here, 'hardware-catalog.json');
let pretty = true;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--catalog') {
    if (!args[i + 1]) throw new Error('--catalog requires a path');
    catalogPath = path.resolve(args[++i]);
  } else if (arg === '--compact') {
    pretty = false;
  } else if (arg === '--help') {
    console.log('Usage: node system/hardware/hardware-probe.mjs [--catalog PATH] [--compact]');
    process.exit(0);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

const catalog = loadCatalog(catalogPath);
const snapshot = collectHardwareSnapshot({ catalog });
assertReadOnlyContract(snapshot);
process.stdout.write(`${JSON.stringify(snapshot, null, pretty ? 2 : 0)}\n`);
