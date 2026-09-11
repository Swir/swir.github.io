import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const programPath = path.join(import.meta.dirname, 'Program.cs');
const updateCenterPath = path.join(root, 'swir-updates.html');
const serviceWorkerPath = path.join(root, 'sw.js');

const program = fs.readFileSync(programPath, 'utf8');
const updateCenter = fs.readFileSync(updateCenterPath, 'utf8');
const serviceWorker = fs.readFileSync(serviceWorkerPath, 'utf8');

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message);
}

function rejectText(source, needle, message) {
  if (source.includes(needle)) throw new Error(message);
}

requireText(program, "guardedUpdateRestartLifecycle: true", 'Desktop host must advertise guarded update restart lifecycle readiness.');
requireText(program, "location.pathname !== '/index.html'", 'Native host bootstrap must remain restricted to the trusted shell document.');
requireText(program, '_restartSession.TryEnterBridgeRequest', 'Native calls must continue to pass through the bridge drain gate.');
requireText(program, 'IsTrustedShellSource(e.Source)', 'Desktop host must continue to distinguish the trusted shell source.');

requireText(updateCenter, 'id="desktopHost"', 'Update Center must render Desktop Host readiness.');
requireText(updateCenter, 'id="desktopUpdate"', 'Update Center must render guarded restart readiness.');
requireText(updateCenter, 'parent.SWIR_NATIVE_HOST', 'Update Center must discover the Desktop Host through the existing shell-owned native host object.');
requireText(updateCenter, 'guardedUpdateRestartLifecycle', 'Update Center must derive restart readiness from the host feature contract.');
requireText(updateCenter, 'PACKAGED E2E REQUIRED', 'Update Center must visibly keep restart application gated pending packaged E2E.');

requireText(serviceWorker, "'./swir-updates.html'", 'Service Worker CORE cache must keep Update Center available offline.');
requireText(serviceWorker, 'swir-os-v1.7.13-desktop-update-readiness-0.5.3', 'PWA cache key must invalidate the pre-readiness Update Center cache.');

const scripts = [...updateCenter.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean);
if (!scripts.length) throw new Error('Update Center must contain its executable script.');
for (const [index, script] of scripts.entries()) {
  try {
    new Function(script);
  } catch (error) {
    throw new Error(`Update Center inline script ${index + 1} failed JavaScript parse validation: ${error.message}`);
  }
}

// The current milestone is intentionally read-only. Do not accidentally expose a mutating
// update command to an iframe/system page until the packaged Windows failure-injection suite
// proves the full two-slot handoff and rollback path.
for (const forbidden of [
  'applyAndRestart',
  'applyPreparedUpdate',
  'RestartReadyAsync',
  "surface('updates'",
  "call('updates'"
]) {
  rejectText(updateCenter, forbidden, `Update Center must remain read-only before packaged E2E: found ${forbidden}`);
}

console.log('Update Center Desktop readiness contract validated (syntax + PWA cache + read-only packaged-E2E gate enforced).');
