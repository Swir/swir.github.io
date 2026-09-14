import fs from 'node:fs';

const source = fs.readFileSync(new URL('./DesktopShellIntegrationCoordinator.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tests = fs.readFileSync(new URL('./DesktopShellIntegrationBrokerSelfTests.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const project = fs.readFileSync(new URL('./SWIR.Desktop.ShellIntegration.SelfTests.csproj', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const required = [
  'swir.desktop-shell-host-integration/0.1',
  'hostOwnedGlobalShortcuts = true',
  'applicationDefinedGlobalShortcuts = false',
  'changesWindowsUserChoice = false',
  'shell.toggle-visibility',
  'shell.open-matrix',
  'CaptureStartupArguments',
  'RegisterCurrentUserFileHandlers',
  'InitializeWindow',
  'TryResolveHotKey',
  'PendingOpenFiles',
  'ClaimOpenFile',
  'DesktopShellIntegrationBroker.ShortcutModifiers.Control | DesktopShellIntegrationBroker.ShortcutModifiers.Alt'
];
for (const token of required) {
  if (!source.includes(token)) throw new Error(`shell host coordinator missing: ${token}`);
}

const forbidden = [
  'Registry.LocalMachine',
  'HKEY_LOCAL_MACHINE',
  'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts',
  'CreateSubKey("UserChoice"',
  'OpenSubKey("UserChoice"',
  'DeleteSubKeyTree("UserChoice"',
  'Process.Kill',
  'Environment.Exit',
  'applicationDefinedGlobalShortcuts = true'
];
for (const token of forbidden) {
  if (source.includes(token)) throw new Error(`shell host coordinator contains forbidden primitive: ${token}`);
}

for (const extension of ['.txt', '.md', '.log', '.json', '.swirapp']) {
  if (!source.includes(`"${extension}"`)) throw new Error(`coordinator missing association extension ${extension}`);
}

if (!tests.includes('TestShellIntegrationCoordinator();')) throw new Error('coordinator self-test is not executed');
if (!tests.includes('applications must not register arbitrary global shortcuts')) throw new Error('coordinator permission boundary is not self-tested');
if (!tests.includes('coordinator claim must be one-time')) throw new Error('one-time native file claim is not self-tested through coordinator');
if (!project.includes('<Compile Include="DesktopShellIntegrationCoordinator.cs" />')) throw new Error('coordinator is missing from self-test project');

console.log('Desktop shell host coordinator contract OK.');
