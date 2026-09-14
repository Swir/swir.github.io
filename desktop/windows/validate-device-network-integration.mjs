import fs from 'node:fs';
import vm from 'node:vm';

const program = fs.readFileSync('desktop/windows/Program.cs', 'utf8');
const runtime = fs.readFileSync('swir-runtime.js', 'utf8');
const permission = fs.readFileSync('desktop/windows/PermissionBroker.cs', 'utf8');

function requireText(source, needle, message) {
  if (!source.includes(needle)) throw new Error(message + ` Missing: ${needle}`);
}

requireText(program, 'private readonly DesktopDeviceNetworkBroker _deviceNetwork = new();', 'Desktop Host must own the native broker.');
requireText(program, '"network" => DispatchNetworkAsync(request.Method)', 'Desktop Host must dispatch network calls.');
requireText(program, '"devices" => DispatchDevicesAsync(request.Method)', 'Desktop Host must dispatch device calls.');
requireText(program, '"status" => _deviceNetwork.NetworkStatus()', 'network.status must use the native broker.');
requireText(program, '"adapters" => _deviceNetwork.NetworkAdapters()', 'network.adapters must use the native broker.');
requireText(program, '"info" => _deviceNetwork.Describe()', 'devices.info must describe the native broker.');
requireText(program, '"list" => _deviceNetwork.Devices()', 'devices.list must enumerate through the native broker.');
requireText(program, "network: surface('network', ['status','adapters'])", 'Native bridge must expose read-only network inspection.');
requireText(program, "devices: surface('devices', ['info','list'])", 'Native bridge must expose read-only device inspection.');
requireText(program, 'nativeDeviceNetwork: true', 'Native host feature flag must advertise device/network support.');
requireText(program, 'DeviceNetworkBrokerException deviceNetwork => deviceNetwork.Code', 'Broker error codes must cross the bridge.');

requireText(permission, '("network", "status" or "adapters") => "network.inspect"', 'Network inspection must remain permission-gated.');
requireText(permission, '("devices", "info" or "list") => "device.inspect"', 'Device inspection must remain permission-gated.');
if (/\("network",\s*"(scan|connect|disconnect)"\)/.test(permission)) throw new Error('Native network mutation must remain fail-closed.');

const calls = [];
const nativeHost = {
  edition: 'DESKTOP',
  sessionId: 'integration-test',
  features: { nativeDeviceNetwork: true },
  network: {
    async status() { calls.push('network.status'); return { schema: 'swir.desktop-network-status/0.1', online: true, readOnly: true }; },
    async adapters() { calls.push('network.adapters'); return { schema: 'swir.desktop-network-adapters/0.1', readOnly: true, adapters: [] }; }
  },
  devices: {
    async info() { calls.push('devices.info'); return { schema: 'swir.desktop-device-network/0.1', native: true, readOnly: true }; },
    async list() { calls.push('devices.list'); return { schema: 'swir.desktop-devices/0.1', supported: true, readOnly: true, devices: [] }; }
  }
};
const window = {
  SWIR_NATIVE_HOST: nativeHost,
  dispatchEvent() {},
  addEventListener() {},
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
};
const context = {
  window,
  navigator: { onLine: false, connection: null, serviceWorker: null },
  location: { reload() {} },
  CustomEvent: window.CustomEvent,
  console,
  setTimeout,
  clearTimeout
};
vm.createContext(context);
vm.runInContext(runtime, context, { filename: 'swir-runtime.js' });

const api = context.window.SwirRuntime;
if (!api?.network || !api?.devices) throw new Error('SwirRuntime must expose network and devices surfaces.');
const status = await api.network.status();
const adapters = await api.network.adapters();
const info = await api.devices.info();
const devices = await api.devices.list();
if (status.schema !== 'swir.desktop-network-status/0.1' || status.readOnly !== true) throw new Error('network.status did not route to native host.');
if (adapters.schema !== 'swir.desktop-network-adapters/0.1' || adapters.readOnly !== true) throw new Error('network.adapters did not route to native host.');
if (info.schema !== 'swir.desktop-device-network/0.1' || info.native !== true) throw new Error('devices.info did not route to native host.');
if (devices.schema !== 'swir.desktop-devices/0.1' || devices.readOnly !== true) throw new Error('devices.list did not route to native host.');
const expected = ['network.status', 'network.adapters', 'devices.info', 'devices.list'];
if (JSON.stringify(calls) !== JSON.stringify(expected)) throw new Error(`Unexpected native routing: ${JSON.stringify(calls)}`);
const caps = api.capabilities();
if (!caps.surfaces.network.native || !caps.surfaces.devices.native) throw new Error('Runtime capabilities must report native network/device providers.');
if (!caps.surfaces.devices.methods.includes('info') || !caps.surfaces.devices.methods.includes('list')) throw new Error('Device methods missing from runtime capabilities.');

console.log('Desktop device/network integration contract OK');
