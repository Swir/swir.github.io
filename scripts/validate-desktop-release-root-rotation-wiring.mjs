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

// Rotation roots and fingerprints used to be exposed through job-level env and therefore
// required explicit process-environment cleanup. The hardened release workflow now scopes
// every signing/trust secret to only the step that consumes it. Keep this contract aligned
// with that stronger boundary: a future move back to job-level secret env must fail CI.
const jobStart = text.indexOf('\n  build-and-verify:');
const stepsStart = text.indexOf('\n    steps:', jobStart);
if (jobStart < 0 || stepsStart < 0) {
  throw new Error('Desktop release build-and-verify job boundary could not be resolved.');
}
const signingJobHeader = text.slice(jobStart, stepsStart);
const protectedRotationSecrets = [
  'secrets.SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64',
  'secrets.SWIR_CATALOG_NEXT_SIGNING_PUBLIC_KEY_SHA256',
  'secrets.SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE',
  'secrets.SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE',
];
for (const secret of protectedRotationSecrets) {
  if (signingJobHeader.includes(secret)) {
    throw new Error(`Desktop release exposes rotation secret at job scope: ${secret}`);
  }
  if (!text.includes(secret)) {
    throw new Error(`Desktop release no longer wires required protected rotation input: ${secret}`);
  }
}

if (!text.includes('environment: swir-release-signing')) {
  throw new Error('Desktop release rotation signing job must use the protected swir-release-signing environment.');
}
if (!text.includes("if: ${{ github.repository == 'Swir/swir.github.io' && github.ref == 'refs/heads/main' }}")) {
  throw new Error('Desktop release rotation signing job must be restricted to canonical main.');
}

console.log('Desktop release current-next root rotation wiring validated with step-scoped protected secrets.');
