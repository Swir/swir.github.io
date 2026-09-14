import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const runtime = read('swir-runtime.js');
const program = read('desktop/windows/Program.cs');
const worker = read('sw.js');

function requireText(source, text, message) {
  if (!source.includes(text)) throw new Error(message);
}

requireText(runtime, "const identity = Object.freeze({", 'SwirRuntime must expose a portable identity surface.');
requireText(runtime, "call('identity','info'", 'SwirRuntime.identity.info must prefer the native Host surface.');
requireText(runtime, "call('identity','account'", 'SwirRuntime.identity.account must prefer the native Host surface.');
requireText(runtime, "call('identity','session'", 'SwirRuntime.identity.session must prefer the native Host surface.');
requireText(runtime, "'devices','identity','updater'", 'Runtime capability diagnostics must include identity.');
requireText(runtime, 'devices,identity,updater', 'Identity must be exported on the public SwirRuntime API.');
requireText(runtime, "schema:'swir.desktop-account-session/web'", 'Web Edition needs an explicit identity fallback descriptor.');
requireText(runtime, 'accountManagement:false', 'Web identity descriptor must not claim native account management.');
requireText(runtime, 'credentialExposure:false', 'Web identity descriptor must explicitly deny credential exposure.');
requireText(runtime, 'readOnly:true', 'Portable identity fallback must remain read-only.');
requireText(program, "identity: surface('identity', ['info','account','session'])", 'Desktop Host must expose the identity methods consumed by SwirRuntime.');
requireText(program, 'nativeAccountSession: true', 'Desktop Host must advertise native account/session capability.');
requireText(worker, "'./swir-runtime.js'", 'Service Worker CORE cache must include swir-runtime.js.');
requireText(worker, 'account-session-runtime-0.1.0', 'Service Worker cache version must invalidate pre-identity-runtime assets.');

console.log('Desktop account/session portable runtime contract OK.');
