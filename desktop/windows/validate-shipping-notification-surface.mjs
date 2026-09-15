import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const programPath = path.join(root, 'desktop', 'windows', 'Program.cs');
const source = fs.readFileSync(programPath, 'utf8');

const required = [
  'private readonly DesktopNotificationBridgeService _notifications;',
  '_notifications = DesktopNotificationHostBinding.Create(_permissions, _tray);',
  'DesktopNotificationHostBinding.Dispatch(_notifications, request.Method, request.Args, effectiveToken)',
  "nativeNotifications: true",
  "notifications: surface('notifications', ['show'])",
  "version: '0.5.7-preview'"
];

for (const token of required) {
  if (!source.includes(token)) {
    console.error(`Shipping notification surface contract missing: ${token}`);
    process.exit(1);
  }
}

const notificationDispatch = source.indexOf('if (string.Equals(request.Surface, "notifications", StringComparison.Ordinal))');
const genericAuthorization = source.indexOf('_permissions.Authorize(effectiveToken, request.Surface, request.Method, RequestedOwner(request));');
if (notificationDispatch < 0 || genericAuthorization < 0 || notificationDispatch > genericAuthorization) {
  console.error('notifications dispatch must enter DesktopNotificationHostBinding before generic authorization to avoid bypassing or duplicating the owner-bound notification permission boundary.');
  process.exit(1);
}

console.log('Shipping native notification surface contract OK.');
