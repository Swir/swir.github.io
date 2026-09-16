import fs from 'node:fs';

const fail = (message) => { throw new Error(message); };
const read = (path) => fs.readFileSync(path, 'utf8');

const workflow = read('.github/workflows/desktop-release.yml');
const roots = JSON.parse(read('desktop/windows/catalog-trust-roots.json'));
const lifecycle = read('desktop/windows/DesktopSignedPackageLifecycleSelfTests.cs');
const cutover = read('.github/workflows/desktop-catalog-cutover-contract.yml');
const runtimeStage = read('desktop/windows/stage-desktop-runtime.ps1');
const packageBridge = read('desktop/windows/DesktopPackageBridge.cs');
const packageInstaller = read('desktop/windows/DesktopAppPackageInstaller.cs');

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
  "Copy-Item -LiteralPath (Join-Path $catalogRelease 'catalog-trust-roots.json')",
  "$trust.requireSignedCatalog -ne $true",
  "@($trust.roots).Count -lt 1",
  "throw 'Production signed catalog trust roots must require signed catalogs and contain at least one root.'"
]) {
  if (!runtimeStage.includes(fragment)) fail(`Desktop runtime signed-catalog staging guard missing: ${fragment}`);
}

for (const fragment of [
  'legacySha256Fallback = _catalogTrust is null',
  'trustMode = _catalogTrust is null ? "LEGACY_SHA_UNTIL_ROOT_PROVISIONED" : "SIGNED_CATALOG_REQUIRED"',
  'CATALOG_AUTHORIZATION_REQUIRED',
  'return _installer.Install(path, trust.Sha256);'
]) {
  if (!packageBridge.includes(fragment)) fail(`Desktop package bridge production trust boundary missing: ${fragment}`);
}

// The signed catalog is only useful if its authorized digest is enforced again at the final
// native payload boundary. Keep these invariants in CI so a refactor cannot accidentally turn
// signed metadata into an identity-only check or replace constant-time digest comparison.
for (const fragment of [
  'integrity = "sha256-required"',
  'var expected = NormalizeHash(expectedSha256);',
  'var actual = ComputeSha256(bundlePath);',
  'CryptographicOperations.FixedTimeEquals',
  'PACKAGE_HASH_MISMATCH',
  'bundleSha256 = actual'
]) {
  if (!packageInstaller.includes(fragment)) fail(`Desktop package payload integrity boundary missing: ${fragment}`);
}
const hashCheck = packageInstaller.indexOf('CryptographicOperations.FixedTimeEquals');
const archiveOpen = packageInstaller.indexOf('ZipFile.OpenRead(bundlePath)');
if (hashCheck < 0 || archiveOpen < 0 || hashCheck > archiveOpen) {
  fail('Desktop package SHA-256 must be verified before the .swirapp archive is opened or extracted.');
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
