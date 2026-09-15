import fs from 'node:fs';

const fail = (message) => { throw new Error(message); };
const read = (path) => fs.readFileSync(path, 'utf8');

const workflow = read('.github/workflows/desktop-release.yml');
const roots = JSON.parse(read('desktop/windows/catalog-trust-roots.json'));
const lifecycle = read('desktop/windows/DesktopSignedPackageLifecycleSelfTests.cs');
const cutover = read('.github/workflows/desktop-catalog-cutover-contract.yml');

const requiredWorkflowFragments = [
  'SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM: ${{ secrets.SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM }}',
  'SWIR_CATALOG_EXPECTED_ROOT_SHA256: ${{ secrets.SWIR_CATALOG_SIGNING_PUBLIC_KEY_SHA256 }}',
  'SWIR_CATALOG_SEQUENCE: ${{ inputs.catalog_sequence }}',
  'SWIR_CATALOG_KEY_ID: ${{ inputs.catalog_key_id }}',
  'build-signed-catalog-release.mjs',
  'verify-catalog-root-pin.mjs',
  'requireSignedCatalog -ne $true',
  'Verify staged Store artifacts against signed catalog',
  'persist-credentials: false'
];
for (const fragment of requiredWorkflowFragments) {
  if (!workflow.includes(fragment)) fail(`Desktop release trust-chain wiring missing: ${fragment}`);
}

const privateKeyAssignments = workflow
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith('SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM:'));
const expectedPrivateKeyAssignment =
  'SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM: ${{ secrets.SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM }}';
if (privateKeyAssignments.length === 0 || privateKeyAssignments.some((line) => line !== expectedPrivateKeyAssignment)) {
  fail('Catalog signing private key must only enter the release workflow through GitHub Actions secrets.');
}
if (/BEGIN (?:ED25519 |EC |RSA )?PRIVATE KEY/.test(workflow)) {
  fail('Private signing-key material must never be embedded in the release workflow.');
}

if (roots.schema !== 'swir.catalog-trust-roots/1.0') fail('Unexpected checked-in catalog trust-root schema.');
if (roots.requireSignedCatalog !== false || !Array.isArray(roots.roots) || roots.roots.length !== 0) {
  fail('The source-tree preview trust store must remain empty/fail-neutral; production roots are staged only by the controlled release pipeline.');
}

for (const fragment of [
  'requireSignedCatalog = true',
  'SignatureAlgorithm.Ed25519',
  'CATALOG_ROLLBACK_DETECTED',
  'signed v1 must survive Host restart',
  'signed v2 must survive Host restart',
  'rolled-back v1 must survive Host restart'
]) {
  if (!lifecycle.includes(fragment)) fail(`Signed package lifecycle coverage missing: ${fragment}`);
}

for (const fragment of [
  'test-catalog-root-cutover-e2e.mjs',
  'verify-catalog-root-rotation.mjs',
  'Run signed install-update-restart-rollback root cutover lifecycle'
]) {
  if (!cutover.includes(fragment)) fail(`Catalog root-cutover contract coverage missing: ${fragment}`);
}

console.log('Desktop release trust-chain preflight passed.');
