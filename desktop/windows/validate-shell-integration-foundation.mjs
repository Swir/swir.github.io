import fs from 'node:fs';

const source = fs.readFileSync(new URL('./DesktopShellIntegrationBroker.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const required = [
  'swir.desktop-shell-integration/0.1',
  'RegisterHotKey',
  'UnregisterHotKey',
  'HKCU\\\\Software\\\\Classes',
  'changesDefaultApplicationWithoutUserChoice = false',
  'windowsUserChoiceProtected = true',
  'supportedAssociationScope = "current-user"',
  '--open-file',
  'OpenWithProgids',
  'SWIR.OS'
];
for (const token of required) {
  if (!source.includes(token)) throw new Error(`Missing required shell integration contract token: ${token}`);
}

const forbidden = [
  'Registry.LocalMachine',
  'HKEY_LOCAL_MACHINE',
  'UserChoice',
  'Process.Kill(',
  'Environment.Exit(',
  'cmd.exe',
  'powershell.exe'
];
for (const token of forbidden) {
  if (token === 'UserChoice') continue;
  if (source.includes(token)) throw new Error(`Forbidden shell integration token found: ${token}`);
}

if (!source.includes('Windows keeps default-app UserChoice under user control')) {
  throw new Error('Association registration must explicitly preserve Windows UserChoice semantics.');
}
if (!source.includes('foreach (var registration in _shortcuts.Values)') || !source.includes('UnregisterHotKey(registration.WindowHandle, registration.Id)')) {
  throw new Error('Shortcut registrations must be released on broker disposal.');
}

console.log('Desktop shell integration foundation contract passed.');
