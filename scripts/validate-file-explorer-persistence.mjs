import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const bridge = fs.readFileSync('swir-platform-bridge.js', 'utf8');
new Function(bridge);

const MANIFEST = '.swir-file-explorer-v1.json';
const SCHEMA = 'swir.file-explorer-state/1.0';

function storage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    dump: key => map.get(key)
  };
}

async function boot({ legacy = [], nativeItems = null } = {}) {
  const localStorage = storage({ 'swir-vfs-v12': JSON.stringify(legacy) });
  const native = new Map();
  if (nativeItems !== null) native.set(MANIFEST, JSON.stringify({ schema: SCHEMA, version: 1, items: nativeItems }));
  const platformFiles = new Map();
  const storageWrites = new Map();
  const listeners = new Map();

  const filesystem = {
    info: async () => ({ schema: 'swir.desktop-filesystem/0.1', provider: 'native-sandbox', native: true }),
    get: async id => native.has(id) ? { id, name: id, content: native.get(id) } : null,
    save: async file => { native.set(file.id, file.content ?? ''); return { id: file.id, name: file.id }; },
    remove: async id => native.delete(id),
    list: async () => [...native.keys()].map(id => ({ id, name: id }))
  };

  const SwirPlatform = {
    ready: Promise.resolve(),
    files: {
      list: async () => [...platformFiles.values()],
      save: async item => { platformFiles.set(item.id, structuredClone(item)); return item; },
      remove: async id => platformFiles.delete(id)
    },
    storage: { set: async (key, value) => storageWrites.set(key, value) }
  };

  const window = {
    SwirPlatform,
    SwirRuntime: { filesystem },
    addEventListener(type, fn) { listeners.set(type, fn); }
  };
  const context = vm.createContext({ window, localStorage, setTimeout, clearTimeout, Date, JSON, console, structuredClone });
  vm.runInContext(bridge, context, { filename: 'swir-platform-bridge.js' });
  await new Promise(resolve => setTimeout(resolve, 40));
  return { window, localStorage, native, platformFiles, storageWrites, listeners };
}

{
  const state = await boot({
    legacy: [{ id: 'stale', type: 'file', name: 'stale.txt', content: 'old' }],
    nativeItems: [{ id: 'native-1', type: 'file', name: 'native.txt', content: 'persisted', parent: 'root' }]
  });
  const hydrated = JSON.parse(state.localStorage.dump('swir-vfs-v12'));
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].id, 'native-1', 'native manifest must be authoritative on Desktop startup');
  assert.equal(state.window.SwirPlatformBridge.storageInfo().provider, 'desktop-native-manifest');
  assert.equal(state.storageWrites.get('compat.vfs.provider'), 'desktop-native-manifest');
}

{
  const state = await boot({ legacy: [{ id: 'migrated-1', type: 'text', name: 'hello.txt', content: 'hello', parent: 'root' }] });
  const manifest = JSON.parse(state.native.get(MANIFEST));
  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].type, 'file', 'legacy text records are normalized during migration');
  assert.equal(manifest.items[0].content, 'hello');
}

{
  const state = await boot({ nativeItems: [] });
  state.localStorage.setItem('swir-vfs-v12', JSON.stringify([{ id: 'save-1', type: 'file', name: 'save.txt', content: 'desktop', parent: 'root' }]));
  await state.window.SwirPlatformBridge.syncFiles();
  const manifest = JSON.parse(state.native.get(MANIFEST));
  assert.equal(manifest.items[0].id, 'save-1', 'File Explorer changes must persist through native filesystem.save');
  assert.equal(state.platformFiles.get('save-1').adapterSource, 'legacy-v12', 'portable platform mirror remains synchronized');
}

assert.match(bridge, /NATIVE_VFS_MANIFEST='\.swir-file-explorer-v1\.json'/);
assert.match(bridge, /filesystem\.save\(\{id:NATIVE_VFS_MANIFEST/);
assert.match(bridge, /hydrateNative:true/);
assert.doesNotMatch(bridge, /filesystem\.remove\([^)]*NATIVE_VFS_MANIFEST/);

console.log('SWIR File Explorer Desktop persistence contract: OK');
