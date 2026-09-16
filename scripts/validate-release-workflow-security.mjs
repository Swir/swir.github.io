import fs from 'node:fs';

const ACTION_PINS = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'], // v7.0.1
  ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'], // v7.0.0
  ['actions/setup-dotnet', 'd4c94342e560b34958eacfc5d055d21461ed1c5d'], // v5.0.0
  ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'], // v7.0.1
  ['actions/download-artifact', '37930b1c2abaa49bbe596cd826c3c89aef350131'], // v7.0.0
]);

const MAIN_REPO_GUARD = "if: ${{ github.repository == 'Swir/swir.github.io' && github.ref == 'refs/heads/main' }}";
const SIGNING_ENVIRONMENT = 'environment: swir-release-signing';

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message || `Missing required release security wiring: ${needle}`);
}

function rejectText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message || `Forbidden release security wiring: ${needle}`);
}

function verifyPinnedActions(label, source) {
  const usesPattern = /^\s*-?\s*uses:\s+(actions\/[A-Za-z0-9_.-]+)@([^\s#]+).*$/gm;
  let count = 0;
  for (const match of source.matchAll(usesPattern)) {
    count += 1;
    const [, action, ref] = match;
    const expected = ACTION_PINS.get(action);
    if (!expected) throw new Error(`${label}: unapproved first-party action ${action}`);
    if (ref !== expected) {
      throw new Error(`${label}: ${action} must be pinned to immutable commit ${expected}; found ${ref}`);
    }
  }
  if (count === 0) throw new Error(`${label}: no first-party actions were found to verify`);
  rejectText(source, 'uses: actions/checkout@v', `${label}: mutable checkout major tag is forbidden in release workflows`);
  rejectText(source, 'uses: actions/setup-node@v', `${label}: mutable setup-node major tag is forbidden in release workflows`);
  rejectText(source, 'uses: actions/setup-dotnet@v', `${label}: mutable setup-dotnet major tag is forbidden in release workflows`);
  rejectText(source, 'uses: actions/upload-artifact@v', `${label}: mutable upload-artifact major tag is forbidden in release workflows`);
  rejectText(source, 'uses: actions/download-artifact@v', `${label}: mutable download-artifact major tag is forbidden in release workflows`);
}

function verifySecretBoundary(label, source, requiredSecretNames) {
  const jobsIndex = source.indexOf('\njobs:');
  const stepsIndex = source.indexOf('\n    steps:', jobsIndex);
  if (jobsIndex < 0 || stepsIndex < 0) throw new Error(`${label}: could not resolve the signing job boundary`);
  const signingJobHeader = source.slice(jobsIndex, stepsIndex);
  if (/\$\{\{\s*secrets\./.test(signingJobHeader)) {
    throw new Error(`${label}: signing secrets must not be job-level env; scope each secret to only the step that needs it`);
  }
  for (const secret of requiredSecretNames) {
    requireText(source, `secrets.${secret}`, `${label}: required protected secret reference ${secret} is missing`);
  }
}

function verifyReleaseWorkflow(label, source, requiredSecretNames) {
  requireText(source, MAIN_REPO_GUARD, `${label}: secret-bearing signing job must refuse non-main/non-canonical repository dispatches`);
  requireText(source, SIGNING_ENVIRONMENT, `${label}: signing job must use the fixed swir-release-signing environment`);
  requireText(source, 'persist-credentials: false', `${label}: checkout must not persist Git credentials`);
  requireText(source, 'permissions:\n  contents: read', `${label}: workflow default token permissions must remain read-only`);
  verifySecretBoundary(label, source, requiredSecretNames);
  verifyPinnedActions(label, source);
}

function runSelfTest() {
  const actionLines = [
    `      - uses: actions/checkout@${ACTION_PINS.get('actions/checkout')}`,
    `      - uses: actions/setup-node@${ACTION_PINS.get('actions/setup-node')}`,
    `      - uses: actions/upload-artifact@${ACTION_PINS.get('actions/upload-artifact')}`,
  ].join('\n');
  const good = `name: test\npermissions:\n  contents: read\njobs:\n  sign:\n    ${MAIN_REPO_GUARD}\n    ${SIGNING_ENVIRONMENT}\n    runs-on: ubuntu-latest\n    steps:\n${actionLines}\n      - run: echo ok\n        env:\n          KEY: \${{ secrets.TEST_KEY }}\n      - run: echo checkout\n        env:\n          NOTE: persist-credentials: false\n`;
  verifyReleaseWorkflow('self-test-good', good, ['TEST_KEY']);

  const mutable = good.replace(ACTION_PINS.get('actions/checkout'), 'v7');
  let mutableRejected = false;
  try { verifyReleaseWorkflow('self-test-mutable', mutable, ['TEST_KEY']); } catch { mutableRejected = true; }
  if (!mutableRejected) throw new Error('self-test failed: mutable action ref was accepted');

  const jobSecret = good.replace('    steps:\n', '    env:\n      LEAK: ${{ secrets.TEST_KEY }}\n    steps:\n');
  let jobSecretRejected = false;
  try { verifyReleaseWorkflow('self-test-job-secret', jobSecret, ['TEST_KEY']); } catch { jobSecretRejected = true; }
  if (!jobSecretRejected) throw new Error('self-test failed: job-level secret was accepted');

  const branch = good.replace(MAIN_REPO_GUARD, "if: ${{ github.ref == 'refs/heads/main' }}");
  let branchRejected = false;
  try { verifyReleaseWorkflow('self-test-repo-guard', branch, ['TEST_KEY']); } catch { branchRejected = true; }
  if (!branchRejected) throw new Error('self-test failed: incomplete canonical repository guard was accepted');

  console.log('SWIR release workflow security validator self-test OK');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const desktop = fs.readFileSync('.github/workflows/desktop-release.yml', 'utf8');
  const catalog = fs.readFileSync('.github/workflows/signed-catalog-release.yml', 'utf8');

  verifyReleaseWorkflow('desktop-release.yml', desktop, [
    'SWIR_DESKTOP_RELEASE_PRIVATE_KEY_PEM',
    'SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM',
    'SWIR_CATALOG_SIGNING_PUBLIC_KEY_SHA256',
    'SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64',
    'SWIR_CATALOG_NEXT_SIGNING_PUBLIC_KEY_SHA256',
    'SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE',
    'SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE',
  ]);
  verifyReleaseWorkflow('signed-catalog-release.yml', catalog, [
    'SWIR_CATALOG_SIGNING_PRIVATE_KEY_PEM',
    'SWIR_CATALOG_SIGNING_PUBLIC_KEY_SHA256',
    'SWIR_CATALOG_NEXT_PUBLIC_KEY_BASE64',
    'SWIR_CATALOG_NEXT_SIGNING_PUBLIC_KEY_SHA256',
    'SWIR_CATALOG_ROTATION_CUTOVER_SEQUENCE',
    'SWIR_CATALOG_CURRENT_RETIRE_AFTER_SEQUENCE',
  ]);

  console.log('SWIR release workflow signing boundary and immutable action pins OK');
}
