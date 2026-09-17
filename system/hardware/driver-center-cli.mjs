#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertSafeDriverCenterRuntime, buildDriverCenterRuntime } from './driver-center-runtime.mjs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { compact: false, output: null, device: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--compact') out.compact = true;
    else if (arg === '--output') out.output = argv[++i] || fail('--output requires a path');
    else if (arg === '--device') out.device = argv[++i] || fail('--device requires an exact device key');
    else fail(`Unsupported argument: ${arg}`);
  }
  return out;
}

function safeOutputPath(value) {
  if (!value) return null;
  const resolved = path.resolve(value);
  const parent = path.dirname(resolved);
  const stat = fs.existsSync(parent) ? fs.lstatSync(parent) : null;
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) fail('output parent must be an existing non-symlink directory');
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) fail('refusing symlink output path');
  return resolved;
}

function selectDevice(runtime, key) {
  if (!key) return runtime;
  if (!/^(pci|usb):[A-Za-z0-9_.:-]{1,160}$/.test(key)) fail('invalid device key');
  const selected = runtime.devices.find(device => device.key === key);
  if (!selected) fail(`device not found: ${key}`);
  return Object.freeze({ ...runtime, selectedDevice: selected });
}

export async function runDriverCenterCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const output = safeOutputPath(args.output);
  const runtime = await buildDriverCenterRuntime();
  assertSafeDriverCenterRuntime(runtime);
  const result = selectDevice(runtime, args.device);
  const json = `${JSON.stringify(result, null, args.compact ? 0 : 2)}\n`;
  if (output) fs.writeFileSync(output, json, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  else process.stdout.write(json);
  return result;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runDriverCenterCli().catch(error => {
    process.stderr.write(`${error?.code || error?.name || 'ERROR'}: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
