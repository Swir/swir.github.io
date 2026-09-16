import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const programPath = path.join(import.meta.dirname, 'Program.cs');
const permissionsPath = path.join(import.meta.dirname, 'PermissionBroker.cs');
const preparationHostPath = path.join(import.meta.dirname, 'DesktopUpdatePreparationHostService.cs');
const updateCenterPath = path.join(root, 'swir-updates.html');
const serviceWorkerPath = path.join(root, 'sw.js');

const program = fs.readFileSync(programPath, 'utf8');
const permissions = fs.readFileSync(permissionsPath, 'utf8');
const preparationHost = fs.readFileSync(preparationHostPath, 'utf8');
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
requireText(program, "nativeUpdatePreparation: true", 'Desktop host must advertise signed update preparation availability.');
requireText(program, "location.pathname !== '/index.html'", 'Native host bootstrap must remain restricted to the trusted shell document.');
requireText(program, '_restartSession.TryEnterBridgeRequest', 'Native calls must continue to pass through the bridge drain gate.');
requireText(program, 'IsTrustedShellSource(e.Source)', 'Desktop host must continue to distinguish the trusted shell source.');
requireText(program, '_updatePreparationHost.CancelQueuedAfterResponseFailure()', 'Queued preparation must be cancelled if bridge acknowledgement cannot be delivered.');
requireText(program, 'await _updatePreparationHost.ExecuteQueuedAsync()', 'Update preparation must be deferred until after the bridge response scope.');
requireText(program, 'await _updateBridgeCoordinator.ExecuteQueuedAsync()', 'Update execution must remain explicitly deferred until after the bridge response scope.');
requireText(program, '"updates" => DispatchUpdatesAsync(request.Method, trustedShell)', 'Native host must route the updates surface through the trusted-shell-aware dispatcher.');
requireText(program, '"readiness" => _updateBridgeCoordinator.Describe()', 'Native updates readiness must stay read-only.');
requireText(program, '"check" => await _updatePreparationHost.CheckAsync(trustedShell)', 'Signed Desktop discovery must stay behind the trusted-shell host service.');
requireText(program, '"preparationStatus" => _updatePreparationHost.Describe()', 'Preparation status must be provided by the fail-closed host service.');
requireText(program, '"prepare" => _updatePreparationHost.QueuePrepare(trustedShell)', 'Preparation must use trusted-shell queueing.');
requireText(program, '"cancelPrepare" => _updatePreparationHost.Cancel(trustedShell)', 'Preparation cancellation must stay shell-gated.');
requireText(program, '"resetPreparation" => _updatePreparationHost.ResetTerminalState(trustedShell)', 'Preparation reset must stay shell-gated.');
requireText(program, '"applyAndRestart" => _updateBridgeCoordinator.PrepareApply(trustedShell)', 'Native apply must pass the coordinator trusted-shell preflight.');
requireText(program, "new Set(['check','preparationStatus','prepare','cancelPrepare','resetPreparation','applyAndRestart'])", 'Trusted shell broker must explicitly allow only the update workflow commands.');
requireText(program, "msg.name === 'updates.preparationCompleted'", 'Preparation completion must be forwarded as a native host event.');
requireText(program, "msg.name === 'updates.preparationFailed'", 'Preparation failure must be forwarded as a native host event.');

requireText(preparationHost, 'swir.desktop-update-preparation-host/0.3', 'Preparation host schema must describe the integrated bridge contract.');
requireText(preparationHost, 'ResetTerminalState(bool trustedShell)', 'Host service reset must require a trusted-shell assertion.');
requireText(preparationHost, 'UPDATE_BRIDGE_TRUST_REQUIRED', 'Preparation host must fail closed for untrusted reset callers.');

requireText(permissions, '"updates.inspect"', 'Trusted shell must have an explicit updates.inspect permission.');
requireText(permissions, '"updates.apply"', 'Trusted shell must have an explicit updates.apply permission.');
requireText(permissions, '("updates", "readiness" or "check" or "preparationStatus") => "updates.inspect"', 'Read-only update workflow must require updates.inspect.');
requireText(permissions, '("updates", "applyAndRestart" or "prepare" or "cancelPrepare" or "resetPreparation") => "updates.apply"', 'Mutating update workflow must require updates.apply.');

// Public host object exposes only read-only readiness. All network/preparation/apply commands stay private to the pinned Update Center iframe.
requireText(program, "updates: surface('updates', ['readiness'])", 'Public SWIR_NATIVE_HOST updates surface must remain read-only.');
rejectText(program, "updates: surface('updates', ['readiness','check'", 'Signed check must not become a public app-callable surface.');
rejectText(program, 'host.updates.prepare', 'Public host must not expose preparation mutation.');
requireText(program, "msg.type !== 'swir-system-update-command'", 'Trusted shell must broker privileged update commands through a private message protocol.');
requireText(program, "event.source !== frame.contentWindow", 'Privileged update broker must pin the request to the actual Update Center iframe.');
requireText(program, "url.pathname !== '/swir-updates.html'", 'Privileged update broker must pin the trusted system page path.');
requireText(program, "call('updates', msg.method)", 'Trusted shell broker must be the only JavaScript caller of private native update workflow methods.');

requireText(updateCenter, 'id="desktopHost"', 'Update Center must render Desktop Host readiness.');
requireText(updateCenter, 'id="desktopFeed"', 'Update Center must render signed release feed status.');
requireText(updateCenter, 'id="desktopPreparation"', 'Update Center must render preparation lifecycle status.');
requireText(updateCenter, 'id="checkDesktop"', 'Update Center must expose signed Desktop check.');
requireText(updateCenter, 'id="prepareDesktop"', 'Update Center must expose verified download/preparation.');
requireText(updateCenter, 'id="cancelPrepare"', 'Update Center must expose preparation cancellation.');
requireText(updateCenter, 'id="resetPrepare"', 'Update Center must expose failed-state reset.');
requireText(updateCenter, 'id="applyRestart"', 'Update Center must render the guarded Apply update & restart action.');
requireText(updateCenter, 'parent.SWIR_NATIVE_HOST', 'Update Center must discover the Desktop Host through the shell-owned native host object.');
requireText(updateCenter, 'host.updates?.readiness', 'Update Center must query only the public read-only native readiness API directly.');
requireText(updateCenter, "desktopCommand('check'", 'Update Center signed check must use the private shell broker.');
requireText(updateCenter, "desktopCommand('preparationStatus'", 'Update Center preparation status must use the private shell broker.');
requireText(updateCenter, "desktopCommand('prepare'", 'Update Center prepare must use the private shell broker.');
requireText(updateCenter, "desktopCommand('cancelPrepare'", 'Update Center cancellation must use the private shell broker.');
requireText(updateCenter, "desktopCommand('resetPreparation'", 'Update Center reset must use the private shell broker.');
requireText(updateCenter, "desktopCommand('applyAndRestart'", 'Update Center apply must use the private shell broker.');
requireText(updateCenter, "confirm('Download the signed SWIR OS Desktop update", 'Desktop preparation must require explicit user confirmation.');
requireText(updateCenter, "confirm('Apply the verified SWIR OS Desktop update and restart now?", 'Desktop apply must require explicit user confirmation.');
rejectText(updateCenter, 'host.updates.applyAndRestart', 'Update Center must not call a public mutating native updates method.');
rejectText(updateCenter, 'host.updates.prepare', 'Update Center must not bypass the trusted shell broker for preparation.');

// swir.github.io is now the public showcase. The Desktop runtime stages its own local assets and must not
// depend on the old root-scope PWA worker. Keep the root worker as a one-shot retirement worker so returning
// browsers cannot keep serving stale Web Edition caches over the showcase.
requireText(serviceWorker, "LEGACY_CACHE_PREFIX = 'swir-os-'", 'Public showcase worker must target legacy SWIR OS cache namespaces.');
requireText(serviceWorker, 'await caches.keys()', 'Public showcase worker must enumerate legacy caches for cleanup.');
requireText(serviceWorker, 'await self.registration.unregister()', 'Public showcase worker must unregister itself after retiring legacy caches.');
rejectText(serviceWorker, "'./swir-updates.html'", 'Public showcase worker must not re-cache the Desktop Update Center.');
rejectText(serviceWorker, 'swir-os-v1.7.13-desktop-update-flow-0.6.0', 'Retired Web Edition cache keys must not be recreated by the public showcase worker.');

const scripts = [...updateCenter.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
if (!scripts.length) throw new Error('Update Center must contain its executable script.');
for (const [index, script] of scripts.entries()) {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`Update Center inline script ${index + 1} failed JavaScript parse validation: ${error.message}`);
  }
}

console.log('Update Center Desktop workflow validated (signed check + guarded preparation + cancel/reset + deferred mutation + guarded restart + showcase cache retirement).');
