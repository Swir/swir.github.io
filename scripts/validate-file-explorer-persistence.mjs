import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const adapter = fs.readFileSync('swir-file-storage.js', 'utf8');
const bridge = fs.readFileSync('swir-platform-bridge.js', 'utf8');
new Function(adapter);
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

async function boot({ legacy = [], nativeItems = null, saveDelayMs = 0 } = {}) {
  const localStorage = storage({ 'swir-vfs-v12': JSON.stringify(legacy) });
  const native = new Map();
  if (nativeItems !== null) native.set(MANIFEST, JSON.stringify({ schema: SCHEMA, version: 1, revision: 7, items: nativeItems }));
  const platformFiles = new Map();
  const storageWrites = new Map();
  const listeners = new Map();
  let saveCount = 0;

  const filesystem = {
    info: async () => ({ schema: 'swir.desktop-filesystem/0.1', provider: 'native-sandbox', native: true }),
    get: async id => native.has(id) ? { id, name: id, content: native.get(id) } : null,
    save: async file => {
      saveCount += 1;
      if (saveDelayMs) await new Promise(resolve => setTimeout(resolve, saveDelayMs));
      native.set(file.id, file.content ?? '');
      return { id: file.id, name: file.id };
    },
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
  vm.runInContext(adapter, context, { filename: 'swir-file-storage.js' });
  vm.runInContext(bridge, context, { filename: 'swir-platform-bridge.js' });
  await new Promise(resolve => setTimeout(resolve, 50 + saveDelayMs));
  return { window, localStorage, native, platformFiles, storageWrites, listeners, getSaveCount: () => saveCount };
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
  assert.equal(state.window.SwirPlatformBridge.storageInfo().revision, 7, 'native revision must hydrate into bridge diagnostics');
  assert.equal(state.storageWrites.get('compat.vfs.provider'), 'desktop-native-manifest');
}

{
  const state = await boot({ legacy: [{ id: 'migrated-1', type: 'text', name: 'hello.txt', content: 'hello', parent: 'root' }] });
  const manifest = JSON.parse(state.native.get(MANIFEST));
  assert.equal(manifest.schema, SCHEMA);
  assert.equal(manifest.revision, 1);
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
  assert.equal(manifest.revision, 8, 'existing native revision must advance monotonically');
  assert.equal(state.platformFiles.get('save-1').adapterSource, 'legacy-v12', 'portable platform mirror remains synchronized');
}

{
  const state = await boot({ nativeItems: [], saveDelayMs: 40 });
  state.localStorage.setItem('swir-vfs-v12', JSON.stringify([{ id: 'first', type: 'file', name: 'first.txt', content: 'one', parent: 'root' }]));
  const firstSync = state.window.SwirPlatformBridge.syncFiles();
  await new Promise(resolve => setTimeout(resolve, 10));
  state.localStorage.setItem('swir-vfs-v12', JSON.stringify([{ id: 'latest', type: 'file', name: 'latest.txt', content: 'two', parent: 'root' }]));
  const secondSync = state.window.SwirPlatformBridge.syncFiles();
  assert.equal(firstSync, secondSync, 'concurrent writes share one drain promise');
  await secondSync;
  const manifest = JSON.parse(state.native.get(MANIFEST));
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].id, 'latest', 'a write arriving during native save must be drained and persisted, not dropped');
  assert.ok(manifest.revision >= 9, 'queued native writes must advance revision');
  assert.equal(state.window.SwirPlatformBridge.storageInfo().queued, false);
  assert.equal(state.window.SwirPlatformBridge.storageInfo().syncing, false);
  assert.ok(state.getSaveCount() >= 2, 'queue race scenario must execute more than one native save');
}

assert.match(adapter, /NATIVE_MANIFEST='\.swir-file-explorer-v1\.json'/);
assert.match(adapter, /indexedDB\.open\(DB_NAME,DB_VERSION\)/);
assert.match(adapter, /provider='web-indexeddb'/);
assert.match(adapter, /provider='desktop-native-manifest'/);
assert.match(adapter, /await fs\.save\(\{id:NATIVE_MANIFEST/);
assert.match(bridge, /await storage\.load\(\{legacyItems:items\}\)/);
assert.match(bridge, /await storage\.save\(items\)/);
assert.match(bridge, /drainFileSyncQueue/);
assert.doesNotMatch(bridge, /filesystem\.save/);

console.log('SWIR File Explorer Desktop persistence contract: OK');
