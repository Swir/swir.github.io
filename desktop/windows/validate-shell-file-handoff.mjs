import fs from 'node:fs';

const associations = fs.readFileSync(new URL('../../swir-associations.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const sw = fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const requiredAssociationTokens = [
  'openNativeActivation',
  'drainNativeActivations',
  'window.SWIR_NATIVE_HOST?.shellIntegration',
  'claimOpenFile(descriptor.id,app.id)',
  "capability.kind!=='file'",
  'capability.ownerAppId!==app.id',
  "window.addEventListener('swir:native-open-file-requested'",
  "window.addEventListener('swir:native-host-ready'",
  'SwirAssociations=Object.freeze'
];
for (const token of requiredAssociationTokens) {
  if (!associations.includes(token)) throw new Error(`Missing native file handoff token: ${token}`);
}

if (/SWIR_NATIVE_HOST\?\.filesystem\.readText/.test(associations) || /nativePath/i.test(associations)) {
  throw new Error('Portable association service must not receive native paths or bypass app-bound file capabilities.');
}
if (!associations.includes('defaultFor(descriptor.name)')) {
  throw new Error('Native activation must reuse the canonical SWIR association resolver.');
}
if (!associations.includes('return openFile({...capability')) {
  throw new Error('Native activation must converge on the existing portable openFile handoff.');
}

if (!sw.includes('shell-file-activation-0.1.0')) {
  throw new Error('Service worker cache generation was not bumped for native file activation handoff.');
}
if (!sw.includes("'./swir-associations.js'")) {
  throw new Error('swir-associations.js must remain in the offline core cache.');
}

console.log('Desktop shell file handoff contract passed.');
