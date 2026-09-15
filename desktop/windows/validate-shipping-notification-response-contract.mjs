import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const programPath = path.join(root, 'desktop', 'windows', 'Program.cs');
const bindingPath = path.join(root, 'desktop', 'windows', 'DesktopNotificationHostBinding.cs');
const program = fs.readFileSync(programPath, 'utf8');
const binding = fs.readFileSync(bindingPath, 'utf8');

const programRequired = [
  'var trustedShell = IsTrustedShellSource(e.Source);',
  '_isolation.TryResolveEntrySource(e.Source, out var packageId)',
  '_permissions.RequirePackageExecutionToken(packageId)',
  'new BridgeError(MapErrorCode(ex), ex.Message)',
  'BridgeException bridge => bridge.Code',
  'notifications: surface(\'notifications\', [\'show\'])'
];

for (const token of programRequired) {
  if (!program.includes(token)) {
    console.error(`Shipping notification response contract missing Program.cs token: ${token}`);
    process.exit(1);
  }
}

const bindingRequired = [
  'permissions.Authorize(',
  '"notifications",',
  '"show",',
  'owner)',
  'tray.ShowNotification(',
  'catch (DesktopNotificationBridgeException ex)',
  'catch (NativeNotificationException ex)',
  'throw new BridgeException(ex.Code, ex.Message);'
];

for (const token of bindingRequired) {
  if (!binding.includes(token)) {
    console.error(`Shipping notification response contract missing binding token: ${token}`);
    process.exit(1);
  }
}

const sourceGate = program.indexOf('var trustedShell = IsTrustedShellSource(e.Source);');
const dispatch = program.indexOf('var result = await DispatchAsync(request, effectiveToken, trustedShell);');
if (sourceGate < 0 || dispatch < 0 || sourceGate > dispatch) {
  console.error('Native request source identity must be resolved before notification dispatch.');
  process.exit(1);
}

const bridgeCatch = binding.indexOf('catch (DesktopNotificationBridgeException ex)');
const policyCatch = binding.indexOf('catch (NativeNotificationException ex)');
if (bridgeCatch < 0 || policyCatch < 0 || bridgeCatch > policyCatch) {
  console.error('Notification bridge validation errors must be translated before provider policy errors.');
  process.exit(1);
}

console.log('Shipping native notification response/error contract OK.');
