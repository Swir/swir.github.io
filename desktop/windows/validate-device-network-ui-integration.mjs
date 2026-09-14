import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const requireAll = (text, tokens, label) => {
  for (const token of tokens) {
    if (!text.includes(token)) throw new Error(`${label}: missing ${token}`);
  }
};
const forbidAll = (text, tokens, label) => {
  for (const token of tokens) {
    if (text.includes(token)) throw new Error(`${label}: forbidden ${token}`);
  }
};

const device = read('swir-device.html');
const network = read('swir-network.html');
const runtime = read('swir-runtime.js');
const apps = read('swir-apps.js');
const serviceWorker = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

requireAll(device, [
  'parent.SwirRuntime||parent.SWIR_RUNTIME',
  'r.devices.info()',
  'r.devices.list()',
  'r.network.status()',
  'r.network.adapters()',
  'Native hardware inventory',
  'Desktop Device/Network Broker',
  'web-adapter'
], 'Device Manager native-first integration');

requireAll(network, [
  'parent.SwirRuntime||parent.SWIR_RUNTIME',
  'r.network.status()',
  'r.network.adapters()',
  'Native adapters',
  'READ ONLY',
  'No scan/connect/disconnect privileges',
  'MAC/IP addresses, Wi-Fi credentials',
  'web-adapter'
], 'Network Center native-first integration');

requireAll(runtime, [
  "call('network','status'",
  "call('network','adapters'",
  "call('devices','info'",
  "call('devices','list'"
], 'Runtime broker bridge');

requireAll(apps, [
  'url:"./swir-device.html"',
  'url:"./swir-network.html"'
], 'Application registry');

requireAll(serviceWorker, [
  "'./swir-runtime.js'",
  "'./swir-device.html'",
  "'./swir-network.html'",
  "'./manifest.webmanifest'",
  'device-network-ui-0.1.0'
], 'PWA cache contract');

if (manifest.start_url !== './' || manifest.scope !== './' || manifest.display !== 'standalone') {
  throw new Error('PWA manifest start_url/scope/display contract changed unexpectedly');
}
if (!String(manifest.description || '').includes('Device & Network Core')) {
  throw new Error('PWA manifest must continue advertising Device & Network Core');
}

forbidAll(network, [
  "r.network.scan(",
  "r.network.connect(",
  "r.network.disconnect("
], 'Network Center mutation boundary');

if (!/Desktop Edition uses the read-only Windows device broker/.test(device)) {
  throw new Error('Device Manager must retain an explicit safe Web fallback message');
}
if (!/Native connect\/disconnect\/scan remain disabled/.test(network)) {
  throw new Error('Network Center must explicitly keep privileged mutation disabled');
}

console.log('Device Manager / Network Center native integration, registry, manifest and PWA cache contract: OK');
