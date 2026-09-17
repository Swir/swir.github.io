#!/usr/bin/env node
import { probeSystemImageReadiness } from './system-image-readiness.mjs';

const compact = process.argv.includes('--compact');
for (const arg of process.argv.slice(2)) {
  if (!['--compact'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
}
const report = await probeSystemImageReadiness();
process.stdout.write(`${JSON.stringify(report, null, compact ? 0 : 2)}\n`);
