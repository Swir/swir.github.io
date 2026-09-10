import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const bridgePath = path.join(root, 'swir-app-bridge-host.js');
const runtimePath = path.join(root, 'swir-runtime.js');
const hostPath = path.join(root, 'desktop', 'windows', 'Program.cs');

const bridge = fs.readFileSync(bridgePath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');
const host = fs.readFileSync(hostPath, 'utf8');

const checks = [
  ['bridge advertises App Bridge 0.5.2+', /const VERSION = '0\.5\.[2-9](?:-[^']+)?'/, bridge],
  ['bridge detects nativeAppData feature', /features\?\.nativeAppData\s*!==\s*true/, bridge],
  ['bridge routes native reads through SwirRuntime.appData', /SwirRuntime\?\.appData/, bridge],
  ['bridge performs lazy legacy migration', /await native\.set\(pkg\.packageId, normalizedKey, legacyValue\)/, bridge],
  ['storage.get uses storageGet broker', /case 'storage\.get':[\s\S]*?return storageGet\(/, bridge],
  ['storage.set uses storageSet broker', /case 'storage\.set':[\s\S]*?return storageSet\(/, bridge],
  ['storage.remove uses storageRemove broker', /case 'storage\.remove':[\s\S]*?return storageRemove\(/, bridge],
  ['runtime exposes appData surface', /const appData = Object\.freeze\(/, runtime],
  ['desktop host exposes native App Data feature', /nativeAppData:\s*true/, host],
  ['desktop host exposes appData native surface', /appData:\s*surface\('appdata'/, host]
];

const failures = [];
for (const [name, pattern, source] of checks) {
  if (!pattern.test(source)) failures.push(name);
}

if (/case 'storage\.(?:get|set|remove)':[\s\S]{0,240}SwirAppSDK\?\.storage\?\.namespace/.test(bridge)) {
  failures.push('storage dispatch regressed to direct browser-only SDK namespace access');
}

if (failures.length) {
  console.error('Native App Data bridge validation failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log('Native App Data bridge validation passed.');
console.log('Desktop storage routing: SwirAppBridge -> SwirRuntime.appData -> Windows AppDataBroker');
console.log('Web fallback preserved; first native read lazily migrates legacy namespaced Web storage.');
