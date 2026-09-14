import fs from 'node:fs';

const program = fs.readFileSync('desktop/windows/Program.cs', 'utf8');
const permissionBroker = fs.readFileSync('desktop/windows/PermissionBroker.cs', 'utf8');
const trayLifecycle = fs.readFileSync('desktop/windows/DesktopTrayLifecycle.cs', 'utf8');
const trayIcon = fs.readFileSync('desktop/windows/DesktopTrayIcon.cs', 'utf8');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}
function rejectText(source, text, message) {
  if (source.includes(text)) throw new Error(message);
}

requireText(program, '"clipboard" => DispatchClipboardAsync(request.Method, request.Args)', 'Desktop Host must keep native clipboard routing.');
requireText(program, '"readText" => Clipboard.ContainsText() ? Clipboard.GetText() : string.Empty', 'Desktop Host must keep native clipboard reads.');
requireText(program, 'Clipboard.SetText(text ?? string.Empty)', 'Desktop Host must keep native clipboard writes.');
requireText(program, "clipboard: surface('clipboard', ['readText','writeText','clear'])", 'Native Host must expose the portable clipboard contract.');
requireText(permissionBroker, '("clipboard", "readText") => "clipboard.read"', 'Clipboard reads must remain permission-gated.');
requireText(permissionBroker, '("clipboard", "writeText" or "clear") => "clipboard.write"', 'Clipboard writes must remain permission-gated.');

requireText(trayLifecycle, 'swir.desktop-tray/0.1', 'Tray lifecycle schema is missing.');
requireText(trayLifecycle, 'RequestHide()', 'Tray lifecycle must support hide transitions.');
requireText(trayLifecycle, 'RequestRestore()', 'Tray lifecycle must support restore transitions.');
requireText(trayLifecycle, 'RequestExit()', 'Tray lifecycle must support explicit exit transitions.');
requireText(trayLifecycle, 'DesktopTrayWindowState.Disposed', 'Tray lifecycle must have a terminal disposed state.');

requireText(trayIcon, 'new NotifyIcon', 'Desktop tray adapter must use the native Windows notification area.');
requireText(trayIcon, 'SystemIcons.Application', 'Tray icon must use a local trusted icon source.');
requireText(trayIcon, 'DoubleClick += (_, _) => Restore()', 'Tray icon must restore the host on double click.');
requireText(trayIcon, '_window.Hide()', 'Tray adapter must hide the host window through the native Form API.');
requireText(trayIcon, '_window.Close()', 'Tray exit must terminate through the host window lifecycle.');
requireText(trayIcon, 'EnsureUiThread()', 'Tray operations must enforce host UI-thread ownership.');

rejectText(trayIcon, 'SWIR_NATIVE_HOST', 'Tray adapter must not expose itself directly to web content.');
rejectText(trayIcon, 'Process.Start(', 'Tray adapter must not launch arbitrary processes.');
rejectText(trayIcon, 'Registry.', 'Tray adapter must not mutate the registry.');
rejectText(trayIcon, 'WebMessage', 'Tray adapter must stay host-owned until a permissioned portable contract exists.');

console.log('Clipboard + Desktop tray foundation contract passed.');
