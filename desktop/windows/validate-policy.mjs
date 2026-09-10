import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const catalogSource = fs.readFileSync(path.join(repoRoot, 'swir-packages.js'), 'utf8');
const policy = JSON.parse(fs.readFileSync(path.join(here, 'app-policy.json'), 'utf8'));

const sandbox = { window: {}, Object };
vm.createContext(sandbox);
vm.runInContext(catalogSource, sandbox, { filename: 'swir-packages.js', timeout: 1000 });

const packages = Array.isArray(sandbox.window.SWIR_PACKAGE_CATALOG) ? sandbox.window.SWIR_PACKAGE_CATALOG : [];
const expected = new Map(packages.map(pkg => [pkg.packageId, {
  packageId: pkg.packageId,
  entry: pkg.entry,
  permissions: [...(pkg.permissions || [])].sort()
}]));
const actual = new Map((policy.packages || []).map(pkg => [pkg.packageId, {
  packageId: pkg.packageId,
  entry: pkg.entry,
  permissions: [...(pkg.permissions || [])].sort()
}]));

const errors = [];
if (policy.schema !== 'swir.desktop-policy/0.1') errors.push(`Unsupported policy schema: ${policy.schema}`);
for (const [packageId, exp] of expected) {
  const got = actual.get(packageId);
  if (!got) { errors.push(`Missing desktop policy for ${packageId}`); continue; }
  if (got.entry !== exp.entry) errors.push(`${packageId}: entry mismatch (${got.entry} != ${exp.entry})`);
  if (JSON.stringify(got.permissions) !== JSON.stringify(exp.permissions)) errors.push(`${packageId}: permission set mismatch`);
}
for (const packageId of actual.keys()) {
  if (!expected.has(packageId)) errors.push(`Desktop policy has package not present in SWIR catalog: ${packageId}`);
}
if (new Set((policy.packages || []).map(pkg => pkg.packageId)).size !== (policy.packages || []).length) errors.push('Duplicate packageId in app-policy.json');

if (errors.length) {
  console.error('Desktop policy validation failed:');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log(`Desktop policy OK: ${actual.size} package policies match swir-packages.js`);
