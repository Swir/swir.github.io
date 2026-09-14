import fs from 'node:fs';

const program = fs.readFileSync('desktop/windows/Program.cs', 'utf8').replaceAll('\r\n', '\n');
const trayLifecycle = fs.readFileSync('desktop/windows/DesktopTrayLifecycle.cs', 'utf8').replaceAll('\r\n', '\n');
const trayIcon = fs.readFileSync('desktop/windows/DesktopTrayIcon.cs', 'utf8').replaceAll('\r\n', '\n');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}
function rejectText(source, text, message) {
  if (source.includes(text)) throw new Error(message);
}

requireText(program, 'private readonly DesktopTrayLifecycle _trayLifecycle = new();', 'Shipping host must own the tray lifecycle.');
requireText(program, 'private readonly DesktopTrayIcon _tray;', 'Shipping host must own the native tray adapter.');
requireText(program, '_tray = new DesktopTrayIcon(this, _trayLifecycle);', 'Shipping host must instantiate the tray adapter.');
requireText(program, 'Resize += OnHostResize;', 'Shipping host must observe minimize transitions.');
requireText(program, 'FormClosing += OnHostFormClosing;', 'Shipping host must intercept user close transitions.');
requireText(program, 'if (WindowState != FormWindowState.Minimized || IsDisposed || Disposing)', 'Host minimize handling must be explicit and disposal-safe.');
requireText(program, '_tray.Hide();', 'Minimize/close lifecycle must be able to hide into the notification area.');
requireText(program, 'e.CloseReason == CloseReason.UserClosing', 'Only ordinary user close should convert to hide-to-tray.');
requireText(program, 'e.Cancel = true;', 'Ordinary user close must be cancelled before hiding to tray.');
requireText(program, '_trayLifecycle.RequestExit();\n        Close();', 'Explicit/update exit must mark tray lifecycle exiting before closing the host.');
requireText(program, '_tray.Dispose();', 'Tray adapter must be disposed when the shipping host closes.');
requireText(program, "nativeClipboardTray: true", 'Desktop Host capability diagnostics must advertise verified clipboard/tray integration.');

const hostVersionMatch = program.match(/version:\s*'([0-9]+\.[0-9]+\.[0-9]+-preview)'/);
if (!hostVersionMatch) throw new Error('Desktop Host bridge must advertise an explicit preview version.');
const [major, minor, patch] = hostVersionMatch[1].replace('-preview', '').split('.').map(Number);
if (major !== 0 || minor < 5 || (minor === 5 && patch < 5)) {
  throw new Error(`Desktop Host bridge version ${hostVersionMatch[1]} predates verified tray lifecycle integration.`);
}

requireText(trayLifecycle, 'DesktopTrayWindowState.Exiting', 'Tray lifecycle must retain an explicit exiting state.');
requireText(trayLifecycle, 'DesktopTrayWindowState.Disposed', 'Tray lifecycle must retain a terminal disposed state.');
requireText(trayIcon, '_window.Close()', 'Tray Exit must flow through the normal host close lifecycle.');
requireText(trayIcon, '_notifyIcon.Visible = false;', 'Tray must disappear before explicit exit/disposal.');

rejectText(program, 'Process.Kill(', 'Tray integration must not terminate processes directly.');
rejectText(program, 'Environment.Exit(', 'Tray integration must not bypass normal host shutdown.');
rejectText(program, 'Application.ExitThread(', 'Tray integration must not bypass normal host shutdown.');

console.log(`Clipboard + Desktop tray shipping-host integration contract passed for host ${hostVersionMatch[1]}.`);
