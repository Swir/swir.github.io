import fs from 'node:fs';

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message || `Missing required wiring: ${needle}`);
}

const desktop = fs.readFileSync('.github/workflows/desktop-release.yml', 'utf8');
const catalog = fs.readFileSync('.github/workflows/signed-catalog-release.yml', 'utf8');
for (const [name, source] of [['desktop-release.yml', desktop], ['signed-catalog-release.yml', catalog]]) {
  requireText(source, 'SWIR_CATALOG_SIGNING_PUBLIC_KEY_SHA256', `${name} must bind the protected public-root fingerprint secret`);
  requireText(source, 'SWIR_CATALOG_EXPECTED_ROOT_SHA256', `${name} must expose an expected root fingerprint only inside the release job`);
  requireText(source, 'verify-catalog-root-pin.mjs', `${name} must invoke the fail-closed root pin verifier`);
}
requireText(desktop, 'SWIR_CATALOG_KEY_ID', 'Desktop release must keep catalog key-id binding');
requireText(catalog, 'inputs.key_id', 'Signed catalog release must keep workflow input key-id binding');
requireText(desktop, "-notmatch '^[A-Fa-f0-9]{64}$'", 'Desktop release must reject malformed root fingerprints before signing');
requireText(catalog, '^[A-Fa-f0-9]{64}$', 'Signed catalog release must reject malformed root fingerprints before signing');
requireText(desktop, 'Final bundle catalog root pin verification failed', 'Desktop release must re-check the root pin after bundle materialization');
requireText(catalog, 'Verify pinned catalog public root', 'Signed catalog release must verify the generated trust-root bundle before upload');
console.log('SWIR release root-pin workflow wiring OK');
