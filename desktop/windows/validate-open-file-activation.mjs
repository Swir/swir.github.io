import fs from 'node:fs';

const source = fs.readFileSync(new URL('./DesktopOpenFileActivationBroker.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const shellSource = fs.readFileSync(new URL('./DesktopShellIntegrationBroker.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tests = fs.readFileSync(new URL('./DesktopShellIntegrationBrokerSelfTests.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const required = [
  'swir.desktop-open-file-activation/0.2',
  'activationSwitch = "--open-file"',
  'nativePathExposure = false',
  'oneTimeClaim = true',
  'destinationAppBoundCapability = true',
  'MaxPendingActivations = 32',
  'ActivationLifetime = TimeSpan.FromMinutes(5)',
  'CaptureCommandLine',
  'CaptureFile',
  'Pending()',
  'ClaimForApplication',
  'NormalizeAppId',
  'Claim(string activationId)',
  '_pending.Remove(activationId, out var pending)',
  'windows-file-association',
  'Unexpected arguments after the --open-file path.'
];
for (const token of required) {
  if (!source.includes(token)) throw new Error(`Missing required open-file activation token: ${token}`);
}

for (const extension of ['.txt', '.md', '.log', '.json', '.swirapp']) {
  if (!source.includes(`"${extension}"`)) throw new Error(`Missing activation allowlist extension: ${extension}`);
  if (!shellSource.includes(`"${extension}"`)) throw new Error(`Shell association allowlist drifted from activation policy: ${extension}`);
}

const forbiddenPublicPathPatterns = [
  'ActivationDescriptor(\n        string Id,\n        string NativePath',
  'ApplicationActivation(\n        string Id,\n        string NativePath',
  'nativePath =',
  'NativePath ='
];
for (const token of forbiddenPublicPathPatterns) {
  if (source.includes(token)) throw new Error(`Public activation descriptor must not expose native paths: ${token}`);
}

const testRequirements = [
  'native paths must not be exposed to web content',
  'claimed activation must be removed',
  'capability must be owner-bound to the destination app',
  'invalid destination app must not consume the activation',
  'ExpectFailure<InvalidOperationException>',
  'blocked.exe',
  'CaptureCommandLine(new[] { "--open-file", textPath, "unexpected" })'
];
for (const token of testRequirements) {
  if (!tests.includes(token)) throw new Error(`Missing open-file activation regression assertion: ${token}`);
}

if (!source.includes('if (switchIndexes.Length != 1)')) {
  throw new Error('Command-line activation must reject multiple --open-file switches.');
}
if (!source.includes('if (_pending.Count >= MaxPendingActivations)')) {
  throw new Error('Pending activation queue must remain bounded.');
}
if (!source.includes('PruneExpiredUnsafe()')) {
  throw new Error('Pending activation queue must prune expired entries.');
}
if (!source.includes('var owner = NormalizeAppId(appId);') || !source.includes('capabilityFactory(claimed.NativePath, owner)')) {
  throw new Error('Claimed files must be converted into destination-app-bound capabilities inside the native host boundary.');
}

console.log('Desktop open-file activation contract passed.');
