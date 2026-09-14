import fs from 'node:fs';

const source = fs.readFileSync(new URL('./Program.cs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const required = [
  'private static void Main(string[] args)',
  'Application.Run(new MainWindow(args))',
  'DesktopShellIntegrationCoordinator',
  'CaptureStartupArguments(_startupArguments)',
  'RegisterCurrentUserFileHandlers()',
  'InitializeWindow(Handle)',
  'protected override void WndProc(ref Message m)',
  'TryResolveWindowMessage(m.Msg, m.WParam, out var action)',
  'shell.toggle-visibility',
  'shell.open-matrix',
  'request.Surface, "shellIntegration"',
  'SHELL_INTEGRATION_FORBIDDEN',
  'DispatchShellIntegrationAsync',
  '"pendingOpenFiles"',
  '"claimOpenFile"',
  '"cancelOpenFile"',
  'nativeShellIntegration: true',
  "shellIntegration: surface('shellIntegration', ['info','pendingOpenFiles','claimOpenFile','cancelOpenFile'])",
  "version: '0.5.6-preview'",
  '_shellIntegration.Dispose()'
];

for (const token of required) {
  if (!source.includes(token)) throw new Error(`Shipping shell wiring is missing required token: ${token}`);
}

const shellBranch = source.indexOf('if (string.Equals(request.Surface, "shellIntegration", StringComparison.Ordinal))');
const permissionBoundary = source.indexOf('_permissions.Authorize(effectiveToken, request.Surface, request.Method, RequestedOwner(request));');
if (shellBranch < 0 || permissionBoundary < 0 || shellBranch > permissionBoundary) {
  throw new Error('Trusted-shell shellIntegration gate must be evaluated before the generic app permission broker.');
}

const exposed = source.match(/shellIntegration:\s*surface\('shellIntegration',\s*\[([^\]]+)\]\)/)?.[1] || '';
for (const forbidden of ['registerShortcut', 'unregisterShortcut', 'registerAssociation', 'removeAssociation', 'openPath', 'execute']) {
  if (exposed.includes(forbidden)) throw new Error(`Forbidden shellIntegration web method exposed: ${forbidden}`);
}

for (const forbidden of ['Registry.LocalMachine', 'HKEY_LOCAL_MACHINE', 'Process.Kill(', 'Environment.Exit(']) {
  if (source.includes(forbidden)) throw new Error(`Unsafe shipping host shell integration pattern detected: ${forbidden}`);
}

if (!source.includes("window.postMessage({ type: 'SWIR_NATIVE_OPEN', id: 'matrix' }, location.origin)")) {
  throw new Error('Matrix global shortcut must route through the existing trusted SWIR_NATIVE_OPEN shell path.');
}

console.log('Shipping Desktop Host shell wiring contract: OK');
