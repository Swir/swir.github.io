import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const catalogFile = path.join(root, 'swir-packages.js');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(catalogFile, 'utf8'), sandbox, { filename: catalogFile });
const catalog = sandbox.window.SWIR_PACKAGE_CATALOG;
if (!Array.isArray(catalog) || !catalog.length) throw new Error('SWIR package catalog is empty or invalid.');

// Chat is intentionally pending until its API/CORS policy supports the dedicated desktop app origin.
const pending = new Map([
  ['swir.chat', 'network/CORS migration pending for dedicated app origin']
]);

const failures = [];
const ready = [];
for (const pkg of catalog) {
  const entry = String(pkg.entry || '').replace(/^\.\//, '');
  const file = path.join(root, entry);
  if (!entry || !fs.existsSync(file)) {
    failures.push(`${pkg.packageId}: missing entry ${entry || '(empty)'}`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  const reason = pending.get(pkg.packageId);
  if (reason) {
    console.log(`PENDING ${pkg.packageId}: ${reason}`);
    continue;
  }
  if (/parent\.(?:Swir|SWIR_)/.test(source)) failures.push(`${pkg.packageId}: direct parent.Swir*/parent.SWIR_* access remains`);
  if (!source.includes('swir-app-bridge.js')) failures.push(`${pkg.packageId}: swir-app-bridge.js is not loaded`);
  if (!source.includes(`data-swir-package="${pkg.packageId}"`)) failures.push(`${pkg.packageId}: bridge package identity is missing/mismatched`);
  if (!source.includes(`data-swir-app="${pkg.id}"`)) failures.push(`${pkg.packageId}: bridge app identity is missing/mismatched`);
  if (!failures.some(x => x.startsWith(`${pkg.packageId}:`))) ready.push(pkg.packageId);
}

if (failures.length) {
  console.error('\nApp isolation readiness validation failed:');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`App isolation bridge-ready packages (${ready.length}/${catalog.length}): ${ready.join(', ')}`);
console.log(`Explicitly pending packages: ${[...pending.keys()].join(', ') || 'none'}`);
