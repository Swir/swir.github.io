import fs from 'node:fs';

const workflowPath = new URL('../.github/workflows/desktop-release.yml', import.meta.url);
const text = fs.readFileSync(workflowPath, 'utf8');

const required = [
  'enable_catalog_root_rotation:',
  'catalog_next_key_id:',
  'SWIR_CATALOG_ROTATION_ENABLED: ${{ inputs.enable_catalog_root_rotation }}',
  'SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64: ${{ secrets.SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64 }}',
  'SWIR_CATALOG_NEXT_EXPECTED_ROOT_SHA256: ${{ secrets.SWIR_CATALOG_NEXT_SIGNING_PUBLIC_KEY_SHA256 }}',
  'SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE: ${{ secrets.SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE }}',
  'SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE: ${{ secrets.SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE }}',
  'apply-catalog-root-rotation.mjs',
  'verify-catalog-root-rotation.mjs',
  'Current signing root cannot sign beyond its protected retirement sequence.',
  'Final bundle catalog root rotation verification failed',
];

for (const token of required) {
  if (!text.includes(token)) throw new Error(`Desktop release rotation wiring missing: ${token}`);
}

const applyCount = (text.match(/apply-catalog-root-rotation\.mjs/g) || []).length;
const verifyCount = (text.match(/verify-catalog-root-rotation\.mjs/g) || []).length;
if (applyCount < 1) throw new Error('Desktop release never applies the protected current-next trust bundle.');
if (verifyCount < 2) throw new Error('Desktop release must verify rotation before staging and again in the final bundle.');

if (!/if \(\$env:SWIR_CATALOG_ROTATION_ENABLED -eq 'true'\)/.test(text)) {
  throw new Error('Desktop release does not fail closed behind an explicit rotation mode branch.');
}

if (!text.includes("Remove-Item Env:SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64")) {
  throw new Error('Desktop release cleanup does not remove next-root material from the process environment.');
}

console.log('Desktop release current-next root rotation wiring validated.');
