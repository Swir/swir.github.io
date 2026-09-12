import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const programPath = path.join(import.meta.dirname, 'Program.cs');
const permissionsPath = path.join(import.meta.dirname, 'PermissionBroker.cs');
const updateCenterPath = path.join(root, 'swir-updates.html');
const serviceWorkerPath = path.join(root, 'sw.js');

const program = fs.readFileSync(programPath, 'utf8');
const permissions = fs.readFileSync(permissionsPath, 'utf8');
const updateCenter = fs.readFileSync(updateCenterPath, 'utf8');
const serviceWorker = fs.readFileSync(serviceWorkerPath, 'utf8');

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message);
}

function rejectText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message);
}

requireText(program, "guardedUpdateRestartLifecycle: true", 'Desktop host must advertise guarded update restart lifecycle readiness.');
requireText(program, "nativeUpdateBridge: true", 'Desktop host must advertise Native Update Bridge availability.');
requireText(program, "location.pathname !== '/index.html'", 'Native host bootstrap must remain restricted to the trusted shell document.');
requireText(program, '_restartSession.TryEnterBridgeRequest', 'Native calls must continue to pass through the bridge drain gate.');
requireText(program, 'IsTrustedShellSource(e.Source)', 'Desktop host must continue to distinguish the trusted shell source.');
requireText(program, 'CancelQueuedAfterResponseFailure', 'Queued update mutation must be cancelled if the bridge acknowledgement cannot be delivered.');
requireText(program, 'await _updateBridgeCoordinator.ExecuteQueuedAsync()', 'Update execution must remain explicitly deferred until after the bridge response scope.');
requireText(program, '"updates" => DispatchUpdatesAsync(request.Method, trustedShell)', 'Native host must route the updates surface through the trusted-shell-aware dispatcher.');
requireText(program, '"readiness" => _updateBridgeCoordinator.Describe()', 'Native updates readiness must stay read-only.');
requireText(program, '"applyAndRestart" => _updateBridgeCoordinator.PrepareApply(trustedShell)', 'Native apply must pass the coordinator trusted-shell preflight.');

requireText(permissions, '"updates.inspect"', 'Trusted shell must have an explicit updates.inspect permission.');
requireText(permissions, '"updates.apply"', 'Trusted shell must have an explicit updates.apply permission.');
requireText(permissions, '("updates", "readiness") => "updates.inspect"', 'Readiness must require updates.inspect.');
requireText(permissions, '("updates", "applyAndRestart") => "updates.apply"', 'Apply must require updates.apply.');

// The public host object may expose read-only readiness, but never the mutating apply method.
requireText(program, "updates: surface('updates', ['readiness'])", 'Public SWIR_NATIVE_HOST updates surface must remain read-only.');
rejectText(program, "updates: surface('updates', ['readiness','applyAndRestart'])", 'Mutating update apply must not be public on SWIR_NATIVE_HOST.');
requireText(program, "msg.type !== 'swir-system-update-command'", 'Trusted shell must broker privileged update commands through a private message protocol.');
requireText(program, "event.source !== frame.contentWindow", 'Privileged update broker must pin the request to the actual Update Center iframe.');
requireText(program, "url.pathname !== '/swir-updates.html'", 'Privileged update broker must pin the trusted system page path.');
requireText(program, "call('updates', 'applyAndRestart')", 'Trusted shell broker must be the only JavaScript caller of native applyAndRestart.');

requireText(updateCenter, 'id="desktopHost"', 'Update Center must render Desktop Host readiness.');
requireText(updateCenter, 'id="desktopUpdate"', 'Update Center must render guarded restart readiness.');
requireText(updateCenter, 'id="applyRestart"', 'Update Center must render the guarded Apply update & restart action.');
requireText(updateCenter, 'parent.SWIR_NATIVE_HOST', 'Update Center must discover the Desktop Host through the existing shell-owned native host object.');
requireText(updateCenter, 'host.updates?.readiness', 'Update Center must query the public read-only native readiness API.');
requireText(updateCenter, "type:'swir-system-update-command'", 'Update Center must request apply through the trusted shell broker protocol.');
requireText(updateCenter, "method:'applyAndRestart'", 'Update Center broker request must name applyAndRestart explicitly.');
requireText(updateCenter, "confirm('Apply the verified SWIR OS Desktop update and restart now?", 'Desktop apply must require an explicit user confirmation.');
rejectText(updateCenter, 'host.updates.applyAndRestart', 'Update Center must not call a public mutating native updates method.');
rejectText(updateCenter, 'parent.SWIR_NATIVE_HOST.updates.applyAndRestart', 'Update Center must not bypass the trusted shell broker.');

requireText(serviceWorker, "'./swir-updates.html'", 'Service Worker CORE cache must keep Update Center available offline.');
requireText(serviceWorker, 'swir-os-v1.7.13-desktop-update-bridge-0.5.4', 'PWA cache key must invalidate the pre-bridge Update Center cache.');

const scripts = [...updateCenter.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
if (!scripts.length) throw new Error('Update Center must contain its executable script.');
for (const [index, script] of scripts.entries()) {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`Update Center inline script ${index + 1} failed JavaScript parse validation: ${error.message}`);
  }
}

console.log('Update Center Desktop native bridge contract validated (trusted shell broker + explicit permissions + deferred mutation + PWA cache).');
